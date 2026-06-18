// Control Flow Flattening (CFF)
//
// Splits each function into basic blocks and routes all execution through a
// while-loop + switch-style comparison chain that dispatches based on a
// `state` register.  Original jumps become state transitions.
//
// ── How it works ─────────────────────────────────────────────────────────────
//
// 1. Each function's instruction stream is split into basic blocks at every
//    label definition and after every terminator (JUMP, JUMP_IF_*, RETURN,
//    THROW).
//
// 2. Each block is assigned a random u16 state value.  A sentinel endState
//    (not used by any block) marks loop termination.
//
// 3. A dispatch loop is compiled from a Template.  Rather than comparing the
//    state register against an absolute constant in each arm, a single
//    accumulator `c` walks the (ascending-sorted) state values RELATIVELY:
//    it is seeded with the smallest state at the top of every iteration and
//    each subsequent arm adds the delta to the previous state, so the target
//    state of an arm is `oldState + diff` rather than a readable literal.
//
//      var state = <startState>;
//      var c = 0;
//      while (state !== <endState>) {
//        c = <s0>;            if (state === c) _VM_JUMP_("<block0>");
//        c += <s1 - s0>;      if (state === c) _VM_JUMP_("<block1>");
//        c -= <s1 - s2>;      if (state === c) _VM_JUMP_("<block2>");
//        ...
//      }
//
//    The running sum telescopes (c = s0 + Σ(si − si−1) = si exactly), so chain
//    order is irrelevant to correctness and is shuffled unpredictably.  Deltas
//    may be negative; since LOAD_INT operands are unsigned u16 a negative delta
//    is emitted as a `-=` of its magnitude (always <= U16_MAX) rather than via
//    masking.  Static solvers can no longer read which block a state routes to
//    without replaying the running sum.
//
//    The Template's `state` register is extracted via compileInline() so that
//    block bodies can write state transitions to it.
//
// 4. Block bodies are emitted with their original instructions.  Terminators
//    are rewritten.  Each transition is RELATIVE: when a block runs, the state
//    register still holds that block's own dispatch value, so the target is
//    reached by ADDing the delta (target − current) rather than loading the
//    absolute next-state as a constant.  A negative delta is a SUB of its
//    magnitude (additive operators only — no constant, no masking):
//
//      JUMP target         → LOAD_INT  delta, |targetState - blockState|
//                             ADD/SUB   state, state, delta
//                             JUMP      <loopTop>
//
//      JUMP_IF_FALSE c, t  → JUMP_IF_TRUE c, <skipLabel>
//                             ADD/SUB   state, state, <delta to targetState>
//                             JUMP      <loopTop>
//                             <skipLabel>:
//                             ADD/SUB   state, state, <delta to fallthrough>
//                             JUMP      <loopTop>
//
//      RETURN / THROW      → kept in-place (exits the VM frame directly)
//
//    Relative transitions assume the `state` register holds the running block's
//    own value on entry — true for every dispatcher-routed entry.  Some opcodes
//    (FOR_IN_NEXT, TRY_SETUP, FINALLY_SETUP, and JUMP_REG via LOAD_INT-of-label)
//    jump DIRECTLY to a block label, bypassing the dispatcher, so for those
//    "direct-entry" blocks `state` is seeded absolutely at entry before the
//    relative math runs (see collectDirectEntryLabels).
//
// 5. Block order is shuffled randomly so spatial locality gives no hints.
//
// 6. Fake "dead" blocks are mixed into the dispatcher (see generateFakeBlocks).
//
// ── Pipeline position ─────────────────────────────────────────────────────────
// Same slot as Dispatcher: before resolveRegisters and resolveLabels.
// Can run alongside Dispatcher (they are composable).

import type { Bytecode, Instruction, RegisterOperand } from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import {
  getRandomInt,
  choice,
  shuffle,
  chance,
} from "../../utils/random-utils.ts";
import { U16_MAX } from "../../utils/op-utils.ts";
import { Template } from "../../template.ts";
import {
  ref,
  allocReg,
  buildMaxIdMap,
  forEachFunction,
  extractLabel,
} from "../../utils/pass-utils.ts";

// ── Basic block splitting ────────────────────────────────────────────────────

interface BasicBlock {
  label: string;
  body: Bytecode;
  terminator: Instruction | null;
  stateValue: number;
  // Index of the block that originally followed this one (for fallthroughs).
  // -1 means "no successor" (last block, or ends with RETURN/THROW).
  originalNextIndex: number;

  // This block's position in the array before the emission-order shuffle.
  originalIndex?: number;

  // Marks a fake dead block
  isFake?: boolean;
}

function isTerminator(op: number, compiler: Compiler): boolean {
  const OP = compiler.OP;
  return (
    op === OP.JUMP ||
    op === OP.JUMP_IF_FALSE ||
    op === OP.JUMP_IF_TRUE ||
    op === OP.RETURN ||
    op === OP.THROW
  );
}

// Direct-entry block detection
// CFF rewrites the JUMP / JUMP_IF_* terminators into state transitions that all
// route through the dispatch loop, so a block entered that way always has the
// dispatcher's matched value in `state`.  But several opcodes embed a target
// label and jump to it DIRECTLY, bypassing the dispatch loop entirely:
//
//   • FOR_IN_NEXT  exitTarget            (loop-done jump)
//   • TRY_SETUP    handlerPc             (catch entry, taken by the VM unwinder)
//   • FINALLY_SETUP finallyPc / throwPad (finalizer + re-raise pad)
//   • LOAD_INT reg, <label>  →  JUMP_REG (finally continuation / break / continue
//                                         resume pads materialized by _emitLoadLabel)
//
// A block reached through one of these does NOT have its own stateValue in the
// `state` register, which breaks the RELATIVE transition (it assumes state ==
// blockState on entry).  We collect every label referenced by a NON-terminator
// instruction; the blocks owning those labels are seeded with an absolute
// `state = blockState` at entry so the relative terminator math stays correct.
function collectDirectEntryLabels(
  instrs: Bytecode,
  compiler: Compiler,
): Set<string> {
  const labels = new Set<string>();
  for (const instr of instrs) {
    const op = instr[0];
    if (op === null) continue; // IR pseudo (defineLabel) — not a real jump
    if (isTerminator(op, compiler)) continue; // rewritten → routed through dispatcher
    for (let j = 1; j < instr.length; j++) {
      const operand = instr[j] as any;
      if (operand && typeof operand === "object" && operand.type === "label") {
        labels.add(operand.label as string);
      }
    }
  }
  return labels;
}

function splitBasicBlocks(instrs: Bytecode, compiler: Compiler): BasicBlock[] {
  const blocks: BasicBlock[] = [];
  const usedStates = new Set<number>();

  const assignState = (): number => {
    let s: number;
    do {
      s = getRandomInt(0, U16_MAX);
    } while (usedStates.has(s));
    usedStates.add(s);
    return s;
  };

  let currentLabel: string | null = null;
  let currentBody: Bytecode = [];

  const flushBlock = (terminator: Instruction | null) => {
    if (
      currentBody.length === 0 &&
      terminator === null &&
      currentLabel === null
    )
      return;

    const label = currentLabel ?? compiler._makeLabel("cff_block");
    blocks.push({
      label,
      body: currentBody,
      terminator,
      stateValue: assignState(),
      originalNextIndex: -1, // filled in after all blocks are created
    });
    currentBody = [];
    currentLabel = null;
  };

  for (const instr of instrs) {
    const op = instr[0];

    // defineLabel → start a new block boundary
    if (op === null && (instr[1] as any)?.type === "defineLabel") {
      flushBlock(null);
      currentLabel = (instr[1] as any).label;
      continue;
    }

    // Terminator → ends the current block
    if (op !== null && isTerminator(op, compiler)) {
      flushBlock(instr);
      continue;
    }

    currentBody.push(instr);
  }

  // Flush trailing instructions
  flushBlock(null);

  // Split large blocks (> MAX_BLOCK_SIZE instructions) into smaller chunks
  // so that no single block reveals too much sequential code.
  const MAX_BLOCK_SIZE = 3;
  const splitBlocks: BasicBlock[] = [];
  for (const block of blocks) {
    if (block.body.length <= MAX_BLOCK_SIZE) {
      splitBlocks.push(block);
      continue;
    }
    // Chunk the body into pieces of MAX_BLOCK_SIZE
    for (let j = 0; j < block.body.length; j += MAX_BLOCK_SIZE) {
      const isFirst = j === 0;
      const isLast = j + MAX_BLOCK_SIZE >= block.body.length;
      splitBlocks.push({
        label: isFirst ? block.label : compiler._makeLabel("cff_split"),
        body: block.body.slice(j, j + MAX_BLOCK_SIZE),
        terminator: isLast ? block.terminator : null,
        stateValue: isFirst ? block.stateValue : assignState(),
        originalNextIndex: -1,
      });
    }
  }
  // Replace blocks with split result
  blocks.length = 0;
  blocks.push(...splitBlocks);

  // Wire up originalNextIndex for fallthrough resolution
  for (let i = 0; i < blocks.length - 1; i++) {
    blocks[i].originalNextIndex = i + 1;
  }
  // Last block has no successor
  if (blocks.length > 0) {
    blocks[blocks.length - 1].originalNextIndex = -1;
  }

  return blocks;
}

// ── Cross-block register promotion ───────────────────────────────────────────
// Scans all blocks (bodies + terminators) and finds register operands that
// appear in more than one block.  Those registers must not be in the "temp"
// pool because resolveRegisters' linear scan doesn't understand the CFF
// dispatch loop and would reuse their slots between blocks.
//
// Promotion is done in-place: we delete the `kind` property on the operand
// objects so they default to the "local::" pool (which never reuses slots).

function promoteMultiBlockRegisters(blocks: BasicBlock[]): void {
  // (fnId, regId) → index of first block where this register was seen
  const regFirstBlock = new Map<string, number>();
  // Set of register keys that appear in 2+ blocks
  const multiBlockRegs = new Set<string>();

  for (let bi = 0; bi < blocks.length; bi++) {
    const allInstrs = blocks[bi].terminator
      ? [...blocks[bi].body, blocks[bi].terminator!]
      : blocks[bi].body;

    for (const instr of allInstrs) {
      for (let j = 1; j < instr.length; j++) {
        const op = instr[j] as any;
        if (op && typeof op === "object" && op.type === "register") {
          const key = `${op.fnId}:${op.id}`;
          const first = regFirstBlock.get(key);
          if (first === undefined) {
            regFirstBlock.set(key, bi);
          } else if (first !== bi) {
            multiBlockRegs.add(key);
          }
        }
      }
    }
  }

  if (multiBlockRegs.size === 0) return;

  // Second pass: pin all operand instances of multi-block registers so that
  // resolveRegisters assigns them to the "local::" pool (no slot reuse).
  for (const block of blocks) {
    const allInstrs = block.terminator
      ? [...block.body, block.terminator!]
      : block.body;

    for (const instr of allInstrs) {
      for (let j = 1; j < instr.length; j++) {
        const op = instr[j] as any;
        if (op && typeof op === "object" && op.type === "register") {
          const key = `${op.fnId}:${op.id}`;
          if (multiBlockRegs.has(key)) {
            op.pinned = true;
          }
        }
      }
    }
  }
}

// Generate the dispatch loop via Template
function buildDispatchTemplate(
  blocks: BasicBlock[],
  endState: number,
  startState: number,
  compiler: Compiler,
  fnId: number,
  maxId: Map<number, number>,
): {
  bytecode: Bytecode;
  rState: RegisterOperand;
  loopTopLabel: string;
  loopExitLabel: string;
  innerBytecode: Bytecode;
} {
  // Build the if-chain using a RELATIVE comparison accumulator.
  //
  // The accumulator `c` is seeded with the first arm's state at the top of each
  // iteration, then each subsequent arm adjusts it by the delta from the
  // previous state (new = oldState + diff).  Because the running sum telescopes
  // (c = s0 + Σ(si − si−1) = si exactly), the chain order is irrelevant to
  // correctness, so we shuffle it into an unpredictable order.  Deltas can be
  // negative; since LOAD_INT operands are unsigned u16 we emit a `-=` of the
  // magnitude in that case rather than masking — every magnitude is <= U16_MAX.
  const chainOrder = [...blocks];
  for (let i = chainOrder.length - 1; i > 0; i--) {
    const j = getRandomInt(0, i);
    [chainOrder[i], chainOrder[j]] = [chainOrder[j], chainOrder[i]];
  }

  const cases: string[] = [];
  let prevState = chainOrder[0].stateValue;
  cases.push(`c = ${prevState};`);
  cases.push(`if (state === c) _VM_JUMP_("${chainOrder[0].label}");`);
  for (let i = 1; i < chainOrder.length; i++) {
    const delta = chainOrder[i].stateValue - prevState;
    cases.push(delta >= 0 ? `c += ${delta};` : `c -= ${-delta};`);
    cases.push(`if (state === c) _VM_JUMP_("${chainOrder[i].label}");`);
    prevState = chainOrder[i].stateValue;
  }

  const source = `
    var state = ${startState};
    var c = 0;
    while (state !== ${endState}) {
      ${cases.join("\n      ")}
    }
  `;

  const template = new Template(source);
  const result = template.compileInline({}, compiler, fnId, maxId);

  // Pin ALL dispatch-loop registers so resolveRegisters assigns them to the
  // "local::" pool (no slot reuse).  The dispatch loop is re-entered on every
  // state transition (backward JUMP to while_top), but the linear-scan liveness
  // in resolveRegisters doesn't track loops and would incorrectly treat dispatch
  // temps as dead after one pass, allowing their slots to be reused by body
  // registers that are live across blocks.
  for (const instr of result.bytecode) {
    for (let j = 1; j < instr.length; j++) {
      const op = instr[j] as any;
      if (op && typeof op === "object" && op.type === "register") {
        op.pinned = true;
      }
    }
  }

  const rState = result.registers.get("state");
  if (!rState) {
    throw new Error("CFF: Template did not produce a 'state' register");
  }

  // Find the while loop labels from the compiled IR
  let loopTopLabel: string | null = null;
  let loopExitLabel: string | null = null;

  for (const instr of result.bytecode) {
    if (instr[0] === null && (instr[1] as any)?.type === "defineLabel") {
      const label = (instr[1] as any).label as string;
      if (label.includes("while_top") && !loopTopLabel) {
        loopTopLabel = label;
      }
      if (label.includes("while_exit") && !loopExitLabel) {
        loopExitLabel = label;
      }
    }
  }

  if (!loopTopLabel || !loopExitLabel) {
    throw new Error("CFF: Could not find while loop labels in Template output");
  }

  return {
    bytecode: result.bytecode,
    rState,
    loopTopLabel,
    loopExitLabel,
    innerBytecode: result.innerBytecode,
  };
}

// ── State transition helpers ─────────────────────────────────────────────────

// Emit a RELATIVE state transition.  When a block runs, the state register
// still holds that block's own dispatch value (`currentState`), so adjusting it
// by the delta lands exactly on `targetState` — without ever loading the
// absolute next-state as a constant, which is what static solvers read to lift
// the CFG.  The delta is applied with additive operators only: a non-negative
// delta is an ADD, a negative one a SUB of its magnitude (so the loaded operand
// always stays within the unsigned u16 range LOAD_INT requires — no masking).
function emitStateTransition(
  out: Bytecode,
  rState: RegisterOperand,
  rDelta: RegisterOperand,
  currentState: number,
  targetState: number,
  loopTopLabel: string,
  compiler: Compiler,
): void {
  const OP = compiler.OP;
  const delta = targetState - currentState;
  out.push([OP.LOAD_INT!, ref(rDelta), Math.abs(delta)]);
  out.push([
    delta >= 0 ? OP.ADD! : OP.SUB!,
    ref(rState),
    ref(rState),
    ref(rDelta),
  ]);
  out.push([OP.JUMP!, { type: "label", label: loopTopLabel }]);
}

// Fake (dead) block generation
// Create 1-5 blocks whose state values are NEVER the target of any real
// transition.
function generateFakeBlocks(
  usedStates: Set<number>,
  endState: number,
  compiler: Compiler,
): BasicBlock[] {
  const fakeCount = getRandomInt(1, 5);

  // Reserve a fresh, never-reached state for each fake block.  Mutating
  // usedStates keeps these distinct from the real states, endState, and each
  // other.
  const assignState = (): number => {
    let s: number;
    do {
      s = getRandomInt(0, U16_MAX);
    } while (usedStates.has(s) || s === endState);
    usedStates.add(s);
    return s;
  };

  const fakes: BasicBlock[] = [];
  for (let i = 0; i < fakeCount; i++) {
    fakes.push({
      // Reuse the exact label hints real blocks use so a fake arm is lexically
      // indistinguishable from a real one.
      label: compiler._makeLabel(choice(["cff_block", "cff_split"])),
      body: [],
      terminator: null,
      stateValue: assignState(),
      originalNextIndex: -1,
      isFake: true,
    });
  }

  return fakes;
}

// Emit a fake (dead) block's bytecode
function emitFakeBlock(
  out: Bytecode,
  block: BasicBlock,
  rState: RegisterOperand,
  rDelta: RegisterOperand,
  targetStates: number[],
  loopTopLabel: string,
  compiler: Compiler,
): void {
  const OP = compiler.OP;

  // 50% chance for single random jump.
  if (chance(50)) {
    emitStateTransition(
      out,
      rState,
      rDelta,
      block.stateValue,
      choice(targetStates),
      loopTopLabel,
      compiler,
    );
    return;
  }

  // Two-way fork
  const skipLabel = compiler._makeLabel("cff_skip");
  out.push([OP.LOAD_INT!, ref(rDelta), getRandomInt(0, U16_MAX)]);
  out.push([OP.LT!, ref(rDelta), ref(rState), ref(rDelta)]);
  out.push([
    OP.JUMP_IF_TRUE!,
    ref(rDelta),
    { type: "label", label: skipLabel },
  ]);
  emitStateTransition(
    out,
    rState,
    rDelta,
    block.stateValue,
    choice(targetStates),
    loopTopLabel,
    compiler,
  );
  out.push([null, { type: "defineLabel", label: skipLabel }]);
  emitStateTransition(
    out,
    rState,
    rDelta,
    block.stateValue,
    choice(targetStates),
    loopTopLabel,
    compiler,
  );
}

// Per-function transformation
function processFunctionBlock(
  instrs: Bytecode,
  fnId: number,
  compiler: Compiler,
  maxId: Map<number, number>,
): { instrs: Bytecode; tail: Bytecode } {
  const OP = compiler.OP;

  // Only transform functions that contain simple jumps
  const hasRoutableJump = instrs.some((instr) => {
    const op = instr[0];
    return op === OP.JUMP || op === OP.JUMP_IF_FALSE || op === OP.JUMP_IF_TRUE;
  });
  if (!hasRoutableJump) return { instrs, tail: [] };

  // Labels that can be entered by an embedded/indirect jump (FOR_IN_NEXT exit,
  // catch/finally handlers, JUMP_REG continuation pads) — collected from the
  // ORIGINAL stream before it is carved into blocks.  Blocks owning these labels
  // need an absolute state seed (see emission below) because the RELATIVE
  // transition assumes `state` already holds the block's value on entry, which
  // only holds for dispatcher-routed entries.
  const directEntryLabels = collectDirectEntryLabels(instrs, compiler);

  // 1. Split into basic blocks
  const blocks = splitBasicBlocks(instrs, compiler);
  if (blocks.length < 2) return { instrs, tail: [] };

  // 1b. Promote cross-block registers to "local" pool
  // resolveRegisters does a linear-scan liveness analysis that doesn't
  // understand the CFF dispatch loop (backward jumps).  A "temp" register
  // that's live across two blocks would appear to die within its first
  // block and get its slot reused, corrupting values read in later blocks.
  //
  // Fix: find every register that appears in more than one block and
  // delete its "temp" kind so it lands in the "local::" pool (no reuse).
  promoteMultiBlockRegisters(blocks);

  const usedStates = new Set(blocks.map((b) => b.stateValue));

  // Pick endState sentinel
  let endState: number;
  do {
    endState = getRandomInt(0, U16_MAX);
  } while (usedStates.has(endState));

  const startState = blocks[0].stateValue;

  // 1c. Inject fake (dead) blocks
  const fakeBlocks = generateFakeBlocks(usedStates, endState, compiler);
  blocks.push(...fakeBlocks);

  // 2. Build dispatch loop from Template
  const dispatch = buildDispatchTemplate(
    blocks,
    endState,
    startState,
    compiler,
    fnId,
    maxId,
  );
  const { rState, loopTopLabel, loopExitLabel } = dispatch;

  // Scratch register holding the per-transition delta.  allocReg yields a
  // "local::" register (the same pool pinned dispatch registers use), so it is
  // never slot-reused across blocks.  It is rewritten before every use, so a
  // single register is safely shared by all transitions.
  const rDelta = allocReg(fnId, maxId);

  // 3. Pre-compute all state mappings BEFORE shuffle
  // These maps capture the correct stateValues while the blocks array is
  // still in its original split order.  After the shuffle, indexing into
  // blocks[] by original index would give the wrong block.

  // label -> stateValue (for jump target resolution)
  const labelToState = new Map<string, number>();
  for (const block of blocks) {
    labelToState.set(block.label, block.stateValue);
  }

  // originalIndex -> fallthrough stateValue.  Also stamp each block with its
  // pre-shuffle position so emission can recover this mapping after the order is
  // randomized below.
  const fallthroughStateMap = new Map<number, number>();
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].originalIndex = i;
    const next = blocks[i].originalNextIndex;
    fallthroughStateMap.set(i, next >= 0 ? blocks[next].stateValue : endState);
  }

  // 4. Shuffle block order
  shuffle(blocks);

  // 5. Emit: dispatch loop + block bodies
  const out: Bytecode = [];

  // Dispatch loop (var state = ...; while(...) { if-chain })
  out.push(...dispatch.bytecode);

  // Universe of states a fake block may bogusly "jump" to (real + fake).
  const fakeTargetStates = blocks.map((b) => b.stateValue);

  // Each block: defineLabel -> body -> state transition -> JUMP loopTop
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const origIdx = block.originalIndex!;

    // Block label
    out.push([null, { type: "defineLabel", label: block.label }]);

    // Fake (dead) block
    if (block.isFake) {
      emitFakeBlock(
        out,
        block,
        rState,
        rDelta,
        fakeTargetStates,
        loopTopLabel,
        compiler,
      );
      continue;
    }

    // If this block can be entered by a jump that bypasses the dispatch loop
    // (FOR_IN_NEXT exit, catch/finally handlers, JUMP_REG continuation pads),
    // the `state` register may not hold this block's value on entry.  Seed it
    // absolutely so the relative terminator transition below lands correctly.
    // (split keeps the original label on the first sub-block, which is exactly
    // the jump target, so seeding it is sufficient.)  When the block is instead
    // reached through the dispatcher, state already equals blockState and this
    // write is a harmless no-op.
    if (directEntryLabels.has(block.label)) {
      out.push([OP.LOAD_INT!, ref(rState), block.stateValue]);
    }

    // Block body
    out.push(...block.body);

    // Terminator rewriting
    const term = block.terminator;

    if (term === null) {
      // Fallthrough → transition to the original next block's state
      emitStateTransition(
        out,
        rState,
        rDelta,
        block.stateValue,
        fallthroughStateMap.get(origIdx)!,
        loopTopLabel,
        compiler,
      );
    } else if (term[0] === OP.RETURN || term[0] === OP.THROW) {
      // Exits the frame — emit as-is
      out.push(term);
    } else if (term[0] === OP.JUMP) {
      const targetLabel = extractLabel(term[1]);
      if (targetLabel !== null) {
        const targetState = labelToState.get(targetLabel);
        if (targetState !== undefined) {
          emitStateTransition(
            out,
            rState,
            rDelta,
            block.stateValue,
            targetState,
            loopTopLabel,
            compiler,
          );
        } else {
          // Target outside this function's blocks — keep original
          out.push(term);
        }
      } else {
        out.push(term);
      }
    } else if (term[0] === OP.JUMP_IF_FALSE) {
      // Original: if (!cond) goto target; else fallthrough
      // → if (cond) goto skipLabel  (inverted)
      //   state = targetState; goto loopTop
      //   skipLabel:
      //   state = fallthroughState; goto loopTop
      const cond = term[1] as RegisterOperand;
      const targetLabel = extractLabel(term[2]);

      if (targetLabel !== null) {
        const targetState = labelToState.get(targetLabel);
        if (targetState !== undefined) {
          const skipLabel = compiler._makeLabel("cff_skip");

          out.push([
            OP.JUMP_IF_TRUE!,
            cond,
            { type: "label", label: skipLabel },
          ]);
          emitStateTransition(
            out,
            rState,
            rDelta,
            block.stateValue,
            targetState,
            loopTopLabel,
            compiler,
          );
          out.push([null, { type: "defineLabel", label: skipLabel }]);
          emitStateTransition(
            out,
            rState,
            rDelta,
            block.stateValue,
            fallthroughStateMap.get(origIdx)!,
            loopTopLabel,
            compiler,
          );
        } else {
          out.push(term);
        }
      } else {
        out.push(term);
      }
    } else if (term[0] === OP.JUMP_IF_TRUE) {
      // Original: if (cond) goto target; else fallthrough
      // → if (!cond) goto skipLabel  (inverted)
      //   state = targetState; goto loopTop
      //   skipLabel:
      //   state = fallthroughState; goto loopTop
      const cond = term[1] as RegisterOperand;
      const targetLabel = extractLabel(term[2]);

      if (targetLabel !== null) {
        const targetState = labelToState.get(targetLabel);
        if (targetState !== undefined) {
          const skipLabel = compiler._makeLabel("cff_skip");

          out.push([
            OP.JUMP_IF_FALSE!,
            cond,
            { type: "label", label: skipLabel },
          ]);
          emitStateTransition(
            out,
            rState,
            rDelta,
            block.stateValue,
            targetState,
            loopTopLabel,
            compiler,
          );
          out.push([null, { type: "defineLabel", label: skipLabel }]);
          emitStateTransition(
            out,
            rState,
            rDelta,
            block.stateValue,
            fallthroughStateMap.get(origIdx)!,
            loopTopLabel,
            compiler,
          );
        } else {
          out.push(term);
        }
      } else {
        out.push(term);
      }
    }
  }

  return { instrs: out, tail: dispatch.innerBytecode };
}

//Pass entry point
export function controlFlowFlattening(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const maxId = buildMaxIdMap(bc);
  return forEachFunction(bc, compiler, (fnInstrs, fnId) =>
    processFunctionBlock(fnInstrs, fnId, compiler, maxId),
  );
}
