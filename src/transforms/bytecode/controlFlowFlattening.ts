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
// 3b. Every arithmetic and comparison step above is then rewritten through MBA
//    (see utils/mba-utils.ts), so what actually reaches the bytecode is closer
//    to:
//
//      while (!(((state ^ E) | -(state ^ E)) >>> 31)) { ... }   // state !== E
//      c = ((c & ~state) | (c & state)) ...                     // c = s0
//      if (!((state ^ c) | -(state ^ c))) _VM_JUMP_(...)        // state === c
//
//    Two properties are being bought here, and the second is the point:
//
//      • no EQ / NEQ instruction is left anywhere in the dispatch loop.  A
//        static devirtualizer dissolves flattening by collecting the registers
//        that get compared for equality and specialising each program point per
//        constant value of those registers.  With no equality operator to key
//        on, every incoming edge merges instead, `state` widens to UNKNOWN, and
//        the dispatch loop is reproduced verbatim rather than unflattened.
//
//      • state constants stop being readable.  `c = s0` becomes an identity
//        expansion of s0 over a LIVE register, so constant propagation widens
//        it instead of recovering the block's state value.
//
//    All of this is exact: every state, sentinel and delta is a compiler-chosen
//    u16, so the int32 precondition mba-utils documents holds by construction —
//    no type analysis of user code is involved.
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
  buildMaxIdMap,
  forEachFunction,
  extractLabel,
} from "../../utils/pass-utils.ts";
import {
  createMBAEmitContext,
  emitMBA,
  mNum,
  mVar,
  mbaAddExpr,
  mbaConstExpr,
  mbaEqExpr,
  mbaNeExpr,
  mbaOpaqueFalse,
  mbaOpaqueTrue,
  mbaSubExpr,
  printMBA,
  type MBAEmitContext,
  type MBAOptions,
} from "../../utils/mba-utils.ts";

// ── MBA configuration ────────────────────────────────────────────────────────
// Every value the state machine touches (block states, the endState sentinel,
// every delta) is a compiler-chosen u16, so the whole state layer is int32 by
// construction and satisfies mba-utils' correctness contract with no analysis.
//
// Depth is the one knob with a real cost: each level multiplies the node count,
// and the dispatch chain expands two expressions per arm through Template —
// whose registers this pass pins wholesale, so they never share slots.  Depth 2
// already puts a nested mixture in front of every comparison; going deeper buys
// far less than entangling more registers does (see mba-utils' header).

// `state` and `c` are the dispatch loop's own registers.  Using them as noise
// operands is what makes the expansion bite: the result carries a manufactured
// data dependency on a live register, so a lifter cannot fold the arm away
// without first proving that dependency irrelevant.
const MBA_DISPATCH: MBAOptions = { depth: 2, noise: ["state", "c"] };

// Per-transition MBA, emitted straight to bytecode.  The scratch pool is
// indexed by tree HEIGHT and shared across every transition in a function, so
// this costs a handful of registers no matter how many blocks there are.
const MBA_TRANSITION: MBAOptions = { depth: 2, noise: ["state"] };

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

  // Every arm is emitted through MBA (see MBA_DISPATCH above):
  //
  //   • the accumulator seed `c = s0`   → an identity expansion of s0 over a
  //     live register, so the literal never appears and a lifter widens it to
  //     UNKNOWN instead of reading the block's state value straight off;
  //   • each `c += delta`               → an add identity;
  //   • each `state === c` test         → a difference (`^` or `-`) fed to a
  //     zero test built from `>>> 31` / logical `!`.
  //
  // The comparison rewrite is the one that matters most.  A static lifter
  // dissolves flattening by noticing which registers are compared for equality
  // and then specialising each program point per constant value of those
  // registers — with no equality/inequality operator left anywhere in the
  // dispatch loop there is nothing to key that specialisation on, every
  // incoming edge merges, `state` widens to UNKNOWN, and the flattened state
  // machine survives devirtualization intact.
  const cases: string[] = [];
  let prevState = chainOrder[0].stateValue;
  const armTest = (label: string) =>
    `if (${printMBA(mbaEqExpr(mVar("state"), mVar("c"), MBA_DISPATCH))}) _VM_JUMP_("${label}");`;

  cases.push(`c = ${printMBA(mbaConstExpr(prevState, MBA_DISPATCH))};`);
  cases.push(armTest(chainOrder[0].label));
  for (let i = 1; i < chainOrder.length; i++) {
    const delta = chainOrder[i].stateValue - prevState;
    // Deltas stay non-negative in the emitted literal (ADD vs SUB) exactly as
    // before — LOAD_INT operands are unsigned and every magnitude is <= U16_MAX.
    const step =
      delta >= 0
        ? mbaAddExpr(mVar("c"), mNum(delta), MBA_DISPATCH)
        : mbaSubExpr(mVar("c"), mNum(-delta), MBA_DISPATCH);
    cases.push(`c = ${printMBA(step)};`);
    cases.push(armTest(chainOrder[i].label));
    prevState = chainOrder[i].stateValue;
  }

  const source = `
    var state = ${startState};
    var c = 0;
    while (${printMBA(mbaNeExpr(mVar("state"), mNum(endState), MBA_DISPATCH))}) {
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
//
// The add/sub is then expanded through MBA over `state` itself, so the update
// reads as a mixture of bitwise and arithmetic steps on a register rather than
// a legible `state = state + <literal>`.  mba-utils truncates the result back
// to int32, which is exact here because every state and delta is a u16.
function emitStateTransition(
  out: Bytecode,
  rState: RegisterOperand,
  currentState: number,
  targetState: number,
  loopTopLabel: string,
  compiler: Compiler,
  mba: MBAEmitContext,
): void {
  const OP = compiler.OP;
  const delta = targetState - currentState;
  const env = new Map([["state", rState]]);
  const expr =
    delta >= 0
      ? mbaAddExpr(mVar("state"), mNum(delta), MBA_TRANSITION)
      : mbaSubExpr(mVar("state"), mNum(-delta), MBA_TRANSITION);

  // emitMBA reads `state` while computing into scratch; the write lands only
  // once the whole expression has been evaluated, so using `state` as its own
  // noise operand is safe.
  const result = emitMBA(out, expr, env, mba);
  out.push([OP.MOVE!, ref(rState), ref(result)]);
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
  targetStates: number[],
  loopTopLabel: string,
  compiler: Compiler,
  mba: MBAEmitContext,
): void {
  const OP = compiler.OP;

  // 50% chance for single random jump.
  if (chance(50)) {
    emitStateTransition(
      out,
      rState,
      block.stateValue,
      choice(targetStates),
      loopTopLabel,
      compiler,
      mba,
    );
    return;
  }

  // Two-way fork, gated on an OPAQUE PREDICATE.
  //
  // The predicate's value is fixed — it is an MBA identity that evaluates the
  // same for every possible input — but it is computed FROM `state`, so its
  // value cannot be read off statically.  A lifter's constant propagation
  // widens it to UNKNOWN and has to emit both arms, which is the point: a fake
  // block stops being distinguishable from a real branch.
  //
  // Correctness is trivial here regardless of which arm runs: this is a dead
  // block, and both arms are ordinary state transitions.
  const skipLabel = compiler._makeLabel("cff_skip");
  const predicate = emitMBA(
    out,
    chance(50)
      ? mbaOpaqueTrue(mVar("state"), MBA_TRANSITION)
      : mbaOpaqueFalse(mVar("state"), MBA_TRANSITION),
    new Map([["state", rState]]),
    mba,
  );
  out.push([
    OP.JUMP_IF_TRUE!,
    ref(predicate),
    { type: "label", label: skipLabel },
  ]);
  emitStateTransition(
    out,
    rState,
    block.stateValue,
    choice(targetStates),
    loopTopLabel,
    compiler,
    mba,
  );
  out.push([null, { type: "defineLabel", label: skipLabel }]);
  emitStateTransition(
    out,
    rState,
    block.stateValue,
    choice(targetStates),
    loopTopLabel,
    compiler,
    mba,
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

  // Shared MBA scratch pool for every transition in this function.  Registers
  // are indexed by expression HEIGHT and rewritten before each read, so the
  // whole function needs only a handful regardless of block count.  Pinned for
  // the same reason the dispatch registers are: resolveRegisters' linear scan
  // cannot see the loop back-edges this pass introduces.
  const mba = createMBAEmitContext(compiler, fnId, maxId, true);

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
        fakeTargetStates,
        loopTopLabel,
        compiler,
        mba,
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
    //
    // The seed is emitted as an identity expansion of the block's state value
    // over the CURRENT contents of `state` (always a valid u16 — the dispatch
    // template seeds it at function entry and every transition truncates back
    // to int32).  The value is the same for any input, but it now depends on a
    // runtime register, so the literal never appears in the instruction stream
    // and a lifter's constant propagation widens it to UNKNOWN.
    if (directEntryLabels.has(block.label)) {
      const seed = emitMBA(
        out,
        mbaConstExpr(block.stateValue, MBA_TRANSITION),
        new Map([["state", rState]]),
        mba,
      );
      out.push([OP.MOVE!, ref(rState), ref(seed)]);
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
        block.stateValue,
        fallthroughStateMap.get(origIdx)!,
        loopTopLabel,
        compiler,
        mba,
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
            block.stateValue,
            targetState,
            loopTopLabel,
            compiler,
            mba,
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
            block.stateValue,
            targetState,
            loopTopLabel,
            compiler,
            mba,
          );
          out.push([null, { type: "defineLabel", label: skipLabel }]);
          emitStateTransition(
            out,
            rState,
            block.stateValue,
            fallthroughStateMap.get(origIdx)!,
            loopTopLabel,
            compiler,
            mba,
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
            block.stateValue,
            targetState,
            loopTopLabel,
            compiler,
            mba,
          );
          out.push([null, { type: "defineLabel", label: skipLabel }]);
          emitStateTransition(
            out,
            rState,
            block.stateValue,
            fallthroughStateMap.get(origIdx)!,
            loopTopLabel,
            compiler,
            mba,
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
