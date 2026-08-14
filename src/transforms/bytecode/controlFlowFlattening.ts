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
// 3b. This pass emits PLAIN bytecode and does not build MBA itself.  Every
//    arithmetic and comparison instruction it generates is stamped with
//    MBA_SAFE_SYM instead, which is a promise to the MBA passes downstream:
//    "every value flowing through this instruction is int32 by construction".
//    That is true here with no analysis at all — every state, sentinel and
//    delta is a compiler-chosen u16.
//
//    mbaSuperOps and mbaExpand's "generated" phase then rewrite those marked
//    instructions into MBA opcode HANDLERS, so the finished dispatch loop still
//    contains no EQ / NEQ / ADD a lifter can read — but the mixture lives in a
//    handler body (one shared JS expression, executed natively) rather than in
//    the instruction stream (a hundred interpreted instructions per site,
//    re-executed on every state transition).
//
//    The division of labour matters, and it is why this pass used to be so
//    expensive.  Emitting MBA here put it inside the dispatch chain, which is
//    walked once per transition: cost is O(blocks) MBA per edge, and the
//    expansions themselves inflate the instruction count, which creates more
//    blocks, which lengthens the chain again.  Measured on a small branch-heavy
//    program that quadratic reached 4,183 instructions of dispatch and 93% of
//    the whole function's bytecode.  A handler costs one opcode slot and zero
//    bytecode no matter how large its expression is.
//
//    What is deliberately NOT delegated is the branchless conditional
//    transition (see emitBranchlessTransition): that is a control-flow property,
//    not an arithmetic one, so no amount of MBA downstream could supply it.
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
//      JUMP_IF_FALSE c, t  → b       = ~~(!c)      (1 when c is falsy)
//                             state   = state + <delta to the truthy target>
//                                             + b * <swing to the falsy one>
//                             JUMP      <loopTop>
//
//        The conditional edge is deleted, not rewritten: no JUMP_IF_* and no
//        skip label survive.  This is what stops a partial evaluator from
//        unflattening the function — see emitBranchlessTransition for why the
//        branchy lowering was removable no matter how much MBA sat on top of
//        it.
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
import {
  Compiler,
  MBA_DOMAINS_SYM,
  MBA_SAFE_SYM,
  type MBAOperandDomains,
  type MBASafeMark,
} from "../../compiler.ts";
import { pickTaintRegister } from "../../utils/mba-taint.ts";
import {
  getRandomInt,
  choice,
  shuffle,
  chance,
} from "../../utils/random-utils.ts";
import { U16_MAX, U32_MAX } from "../../utils/op-utils.ts";
import {
  createStateEncoder,
  disposeStateEncoder,
  type StateEncoder,
} from "../../utils/state-encoding.ts";
import { Template } from "../../template.ts";
import {
  allocReg,
  buildMaxIdMap,
  forEachFunction,
  extractLabel,
} from "../../utils/pass-utils.ts";

// ── Handing work to the MBA layer ────────────────────────────────────────────
//
// Everything this pass emits is ordinary bytecode.  The integer instructions
// among it are stamped MBA_SAFE_SYM, which tells mbaSuperOps / mbaExpand that
// their operands are int32 by construction — true here without any analysis,
// because every state value, sentinel and delta is a compiler-chosen u16 and
// every intermediate is the result of another marked instruction.
//
// Instructions are emitted in strict SINGLE-USE dataflow chains: each step
// writes a fresh temporary that exactly one later instruction reads.  That
// shape is what mbaSuperOps needs to fuse a run into one handler — a register
// with two readers has to survive as a real value, so the chain cannot collapse
// around it.  Writing `t1 = …; t2 = f(t1)` instead of reusing one scratch
// register costs nothing (they land in a reusable pool) and is the difference
// between a superoperator and eight separate instructions.
function markSafe(instr: Instruction, mark: MBASafeMark = true): Instruction {
  (instr as unknown as Record<symbol, unknown>)[MBA_SAFE_SYM] = mark;
  return instr;
}

// Record what this pass KNOWS about an operand's value, beyond the int32-ness
// MBA_SAFE_SYM already promises: the state register holds one of a set of words
// drawn from a single residue class, and a branchless mask holds 0 or -1.
//
// That is the difference between a handler an attacker's classifier can sample
// and one it cannot. The classifier decides what a handler computes by running
// it on ordinary small integers; a term that vanishes on this pass's actual
// values and fires on everything else makes the sampled function differ from
// every operator in its table. See mba-utils' "Domain-restricted identities" —
// which is also why these must be facts, not guesses: a domain that is merely
// probable would fire during a real execution and miscompile the transition.
function markDomains(instr: Instruction, domains: MBAOperandDomains): void {
  const meta = instr as unknown as Record<symbol, unknown>;
  const existing = (meta[MBA_DOMAINS_SYM] ?? {}) as MBAOperandDomains;
  meta[MBA_DOMAINS_SYM] = { ...existing, ...domains };
}

// Opcodes the dispatch Template can produce that the MBA layer knows how to
// rewrite.  Marking by opcode is exact here because the template holds nothing
// but the state machine — every operand in it is a compiler-chosen u16 or a
// register that only ever holds one.
const TEMPLATE_MBA_OP_NAMES = [
  // Not MBA-rewritable on its own, but marking it lets mbaSuperOps fold the
  // load into whichever instruction reads it — which is how a dispatch delta
  // stops being a legible integer load standing in front of an add.
  "LOAD_INT",
  "ADD",
  "SUB",
  "EQ",
  "NEQ",
  "BAND",
  "BOR",
  "BXOR",
  "LT",
  "GT",
  "LTE",
  "GTE",
  "UNARY_BITNOT",
  "UNARY_NEG",
] as const;

function templateMBAOps(compiler: Compiler): Set<number> {
  const ops = new Set<number>();
  for (const name of TEMPLATE_MBA_OP_NAMES) {
    const value = (compiler.OP as Record<string, number | undefined>)[name];
    if (typeof value === "number") ops.add(value);
  }
  return ops;
}

// State alphabet
// ───────────────────────────────────────────────────────────────────────────
// Every state value a function uses is drawn from ONE residue class: they are
// all congruent to a per-function tag modulo 2^STATE_TAG_BITS.  Two things fall
// out of that, both free:
//
//   • Every delta between two states is congruent to 0, so the invariant is
//     preserved by every transition without any extra work — including the
//     branchless one, whose `m & d1` term is either 0 or d1.
//   • The set of values the state register can hold is a DOMAIN the compiler
//     established, which is what lets a handler carry terms that vanish on it
//     and nowhere else.  See mba-utils' "Domain-restricted identities".
//
// The cost is three bits of state entropy — 8192 distinct values per function
// instead of 65536, against a block count in the tens.
const STATE_TAG_BITS = 3;

function assignTaggedState(used: Set<number>, tag: number): number {
  let s: number;
  do {
    s =
      (getRandomInt(0, U16_MAX >>> STATE_TAG_BITS) << STATE_TAG_BITS) | tag;
  } while (used.has(s));
  used.add(s);
  return s;
}

// The ENCODED alphabet
// ───────────────────────────────────────────────────────────────────────────
// The residue class above is a property of the PLAIN state, and the plain state
// only exists inside a transition handler.  What the register holds, and what
// the dispatch chain compares, is E(s) — so the dispatch chain's handlers can
// only carry domain-restricted terms if the ENCODED words share a class too.
//
// E is drawn by the encoder and is not something this pass can steer, so the
// constraint is met from the other end: enumerate every tagged plain value,
// keep the ones whose encoding lands in the encoder's class, and draw state
// values only from that set.  Enumerating is affordable (8192 encodes per
// function) and — unlike a rejection loop — it makes "every value this register
// can hold is in the class" true by construction rather than probable, which is
// the standard a domain has to meet before a handler may assume it.
//
// If the set turns out too small for the function, the caller drops the encoder
// entirely rather than emitting handlers whose assumption does not hold.
function buildStatePool(tag: number, encoder: StateEncoder): number[] {
  const pool: number[] = [];
  for (let i = 0; i <= U16_MAX >>> STATE_TAG_BITS; i++) {
    const plain = (i << STATE_TAG_BITS) | tag;
    if (encoder.stateFilter(plain)) pool.push(plain);
  }
  shuffle(pool);
  return pool;
}

// Fake blocks are the last thing to draw a state, so the pool has to cover them
// too — this is generateFakeBlocks' upper bound.
const MAX_FAKE_BLOCKS = 5;

/** A block's state before the alphabet is drawn.  Never reaches emission. */
const UNASSIGNED_STATE = -1;

// A short-lived temporary for one emitted chain.  Deliberately NOT pinned and
// given its own pool: the live range is a handful of adjacent instructions
// inside a single block, which the linear scan in resolveRegisters handles
// exactly — the back-edge problem that forces `state` and the dispatch
// registers into the pinned pool cannot arise for a value that is written and
// read without an intervening jump.
function allocTemp(fnId: number, maxId: Map<number, number>): RegisterOperand {
  const r = allocReg(fnId, maxId);
  r.kind = "cff";
  return r;
}

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

// State values are NOT assigned here.  They depend on the encoding, which is
// only drawn once the function is known to be worth flattening — so blocks come
// out with a placeholder and the caller fills it in (see buildStatePool).
function splitBasicBlocks(
  instrs: Bytecode,
  compiler: Compiler,
): BasicBlock[] {
  const blocks: BasicBlock[] = [];

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
      stateValue: UNASSIGNED_STATE,
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
  //
  // This number is the dominant cost knob of the whole pass, because block
  // count drives the dispatch chain BOTH ways: more blocks make the chain
  // longer, and they also make more transitions walk it.  Cost is quadratic in
  // it, and with the MBA layer turning each arm into a handler, that quadratic
  // is measured in real work rather than in instructions.
  //
  // Measured on a 12-iteration bit mixer with `mba` + `controlFlowFlattening`,
  // six seeds each:  3 → 1.5-8.0s and 150-190KB (one seed exceeded an 8s cap);
  // 6 → 0.5-2.1s and 131-152KB; 10 → 0.4-2.8s and 127-159KB.  Six is where the
  // curve flattens.  Going lower buys very little: a VM instruction is a single
  // register operation, so even a six-instruction block is a fragment of an
  // expression rather than anything resembling a source statement.
  const MAX_BLOCK_SIZE = 6;
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
        stateValue: UNASSIGNED_STATE,
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
  encoder: StateEncoder | null,
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

  // The chain is written as plain JS and compiled by Template; the EQ / NEQ /
  // ADD / SUB instructions that come out are then marked MBA-safe below, and
  // the MBA passes turn each of them into a handler.  The end state is the same
  // as when this pass built the mixtures itself — no equality operator survives
  // anywhere in the dispatch loop, so a lifter that dissolves flattening by
  // specialising program points per constant value of the compared register has
  // nothing to key on — but the cost per arm is two instructions instead of a
  // hundred, and it is paid once in a handler body rather than on every edge.
  // With an encoding in force the register holds E(s), never s.  Equality
  // survives a bijection, so the chain compares encoded values directly and
  // never decodes — which is what keeps the encoding off the one path that is
  // walked once per arm per transition.  See utils/state-encoding.ts.
  const enc = (s: number) => (encoder ? encoder.encode(s) : s);
  // An encoded constant is a full 32-bit word, and `this._operand()` hands back
  // an UNSIGNED one while every int32 operator here works on signed values —
  // so a state with bit 31 set would arrive 2^32 too high.  `^` and `|` apply
  // ToInt32 to their operands, so the arms and the walk are already safe; the
  // two bare assignments are not, and get an explicit `| 0`.
  const int32 = (v: number) => (encoder ? `(${v} | 0)` : `${v}`);

  const cases: string[] = [];
  let prevState = chainOrder[0].stateValue;

  // `state ^ (state ^ s0)` is s0 for every state, but it is not a constant the
  // Template can fold, so it compiles to a three-instruction single-use chain
  // that mbaSuperOps collapses into one opaque handler.  Writing `c = s0`
  // directly would instead leave a bare LOAD_INT feeding a MOVE — the one shape
  // in the whole dispatch loop that still announces "this register is the
  // comparison accumulator, and this is where its walk starts".
  cases.push(`c = state ^ (state ^ ${enc(prevState)});`);
  cases.push(`if (state === c) _VM_JUMP_("${chainOrder[0].label}");`);
  for (let i = 1; i < chainOrder.length; i++) {
    const cur = chainOrder[i].stateValue;
    if (encoder) {
      // Encoded values have no additive structure worth telescoping through,
      // so the accumulator walks by XOR instead.  It telescopes identically
      // (c = e0 ^ (e0^e1) ^ (e1^e2) ... = ei), it needs no sign handling, and
      // the constants are differences of full-entropy words rather than the
      // small signed deltas that spell out the state ordering.
      cases.push(`c = c ^ ${(enc(cur) ^ enc(prevState)) >>> 0};`);
    } else {
      const delta = cur - prevState;
      // Deltas stay non-negative in the emitted literal (ADD vs SUB) — LOAD_INT
      // operands are unsigned and every magnitude is <= U16_MAX.
      cases.push(delta >= 0 ? `c += ${delta};` : `c -= ${-delta};`);
    }
    cases.push(`if (state === c) _VM_JUMP_("${chainOrder[i].label}");`);
    prevState = cur;
  }

  const source = `
    var state = ${int32(enc(startState))};
    var c = 0;
    while (state !== ${int32(enc(endState))}) {
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
  //
  // Every arithmetic and comparison instruction here is also marked MBA-safe:
  // `state`, `c`, the sentinel and every delta are compiler-chosen u16s, so the
  // int32 precondition holds by construction.  The template contains nothing
  // else — no user value reaches it — so marking by opcode is exact.
  // Marked HOT: the whole chain is re-walked on every state transition, so a
  // handler generated from any of these instructions runs O(blocks) times more
  // often than one generated from a block body.
  //
  // The Template compiles a numeric literal to LOAD_CONST over the constant
  // POOL, which mbaSuperOps cannot absorb — a pool index is resolved long after
  // this pass, so it is not a value a handler could read.  Every number in this
  // template is a compiler-chosen u16, so each is rewritten into a LOAD_INT
  // carrying its value inline.  The fusion then reaches it, and a state delta
  // ends up as an operand of an opaque opcode rather than a pool entry sitting
  // next to a legible add.
  const safeOps = templateMBAOps(compiler);
  for (const instr of result.bytecode) {
    if (instr[0] === compiler.OP.LOAD_CONST && instr.length === 3) {
      const operand = instr[2] as { type?: string; value?: unknown };
      const value = operand?.type === "constant" ? operand.value : undefined;
      // The bound is u32, not u16: an encoded state is a full-width word, and
      // leaving it in the constant POOL would put it out of reach of the fusion
      // (a pool index is resolved long after this pass, so it is not a value a
      // handler could read) and leave it sitting next to a legible comparison.
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= U32_MAX
      ) {
        instr[0] = compiler.OP.LOAD_INT!;
        instr[2] = value;
      }
    }
    if (instr[0] !== null && safeOps.has(instr[0])) {
      markSafe(instr, "hot");
    }
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

  // ── Domains for the chain ────────────────────────────────────────────────
  // This is the one place in the whole state machine where a handler sees the
  // state WITHOUT decoding it, so it is the one place the plain residue class
  // buys nothing.  Both registers here hold encoded words — `state` by
  // definition, `c` because the accumulator walks the same alphabet and is only
  // ever compared against `state` — and every immediate is either an encoded
  // word or the XOR of two, which carries the tag twice and so carries zero.
  //
  // Marking them turns the chain's handlers from functions a classifier can
  // sample into functions that differ from every operator on 15 of every 16
  // integers it tries.  Nothing here is inferred: the alphabet was drawn from
  // buildStatePool precisely so this claim is true by construction.
  if (encoder) {
    const rC = result.registers.get("c");
    const stateIds = new Set<number>([rState.id]);
    if (rC) stateIds.add(rC.id);

    for (const instr of result.bytecode) {
      if (instr[0] === null) continue;
      const domains: MBAOperandDomains = {};
      // Sources only.  A destination carries no claim — `var c = 0` writes the
      // accumulator a value outside the alphabet, and although nothing reads
      // domains for operand 1, a false claim sitting there is a trap for the
      // next reader of this map.
      for (let j = 2; j < instr.length; j++) {
        const operand = instr[j] as any;
        if (
          operand &&
          typeof operand === "object" &&
          operand.type === "register" &&
          stateIds.has(operand.id)
        ) {
          domains[j] = encoder.encodedDomain;
        } else if (typeof operand === "number") {
          // An immediate in this template is one of exactly two things: a whole
          // encoded state (the accumulator seed, the loop sentinel) or the XOR
          // of two consecutive ones (a walk step). Their tags are `tag` and 0
          // respectively, and telling them apart is what the value test does.
          const tagged =
            (operand & ((1 << encoder.encodedDomain.modTag!.bits) - 1)) ===
            encoder.encodedDomain.modTag!.tag;
          domains[j] = tagged
            ? encoder.encodedDomain
            : encoder.encodedDeltaDomain;
        }
      }
      if (Object.keys(domains).length > 0) markDomains(instr, domains);
    }
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

// Everything a transition needs to emit an instruction: the opcode table plus
// the register allocator's cursor for this function.
interface EmitCtx {
  compiler: Compiler;
  fnId: number;
  maxId: Map<number, number>;
  /**
   * Non-null when this function's `state` register lives in an encoded domain.
   * Transitions then go through one of the two handlers the encoder minted
   * rather than through plain arithmetic.  See utils/state-encoding.ts.
   */
  encoder: StateEncoder | null;
  /**
   * A register the transition handlers read and do not depend on, appended as
   * the last operand of every transition instruction.  See utils/mba-taint.ts.
   */
  taint: RegisterOperand | null;
}

// A distinct operand object for the same virtual register, PRESERVING `kind`
// and `pinned`.  ref() drops both by design, and resolveRegisters derives a
// register's pool from each operand instance — so ref()-ing a "cff" temp would
// silently move that instance into the non-reusing local pool.
const dup = (r: RegisterOperand): RegisterOperand => ({ ...r });

// `dst = <imm>`.  Not itself MBA-rewritable (LOAD_INT has no MBA form), but
// marked all the same: mbaSuperOps folds a marked LOAD_INT into the consumer
// that reads it, which turns the immediate into an operand of an opaque handler
// rather than a legible integer load.
function emitImm(out: Bytecode, ctx: EmitCtx, value: number): RegisterOperand {
  const dst = allocTemp(ctx.fnId, ctx.maxId);
  out.push(markSafe([ctx.compiler.OP.LOAD_INT!, dup(dst), value]));
  return dst;
}

// `dst = <op> a` / `dst = a <op> b`, into a fresh temporary.
function emitUn(
  out: Bytecode,
  ctx: EmitCtx,
  opName: "UNARY_BITNOT" | "UNARY_NEG" | "UNARY_NOT",
  a: RegisterOperand,
  safe = true,
): RegisterOperand {
  const dst = allocTemp(ctx.fnId, ctx.maxId);
  const instr: Instruction = [
    (ctx.compiler.OP as Record<string, number>)[opName],
    dup(dst),
    dup(a),
  ];
  out.push(safe ? markSafe(instr) : instr);
  return dst;
}

function emitBinTo(
  out: Bytecode,
  ctx: EmitCtx,
  opName: string,
  dst: RegisterOperand,
  a: RegisterOperand,
  b: RegisterOperand,
): RegisterOperand {
  out.push(
    markSafe([
      (ctx.compiler.OP as Record<string, number>)[opName],
      dup(dst),
      dup(a),
      dup(b),
    ]),
  );
  return dst;
}

function emitBin(
  out: Bytecode,
  ctx: EmitCtx,
  opName: string,
  a: RegisterOperand,
  b: RegisterOperand,
): RegisterOperand {
  return emitBinTo(
    out,
    ctx,
    opName,
    allocTemp(ctx.fnId, ctx.maxId),
    a,
    b,
  );
}

// Emit a RELATIVE state transition.  When a block runs, the state register
// still holds that block's own dispatch value (`currentState`), so adjusting it
// by the delta lands exactly on `targetState` — without ever loading the
// absolute next-state as a constant, which is what static solvers read to lift
// the CFG.  The delta is applied with additive operators only: a non-negative
// delta is an ADD, a negative one a SUB of its magnitude (so the loaded operand
// always stays within the unsigned u16 range LOAD_INT requires — no masking).
//
// Two instructions, both marked: mbaSuperOps fuses them into a single handler
// that reads `state` and the immediate and writes the new state, so what the
// finished bytecode shows is one opaque opcode with an operand — not an integer
// load followed by a legible `state = state + <literal>`.
function emitStateTransition(
  out: Bytecode,
  rState: RegisterOperand,
  currentState: number,
  targetState: number,
  loopTopLabel: string,
  ctx: EmitCtx,
): void {
  const delta = targetState - currentState;

  if (ctx.encoder) {
    // One instruction, and neither operand is readable: the register holds
    // E(state), and the immediate is the delta under its own encoding.  The
    // handler is `E(D(state) + Dd(imm))` — decode, add, re-encode, fused into a
    // single expression.  The delta stays an OPERAND so one handler serves
    // every edge in the function instead of one handler per edge.
    //
    // The taint register rides last, in the order the encoder recorded in its
    // `srcNames`.  The handler reads it and cannot depend on it.
    const instr: Instruction = [
      ctx.encoder.stepOp,
      dup(rState),
      dup(rState),
      ctx.encoder.encodeDelta(delta),
    ];
    if (ctx.taint) instr.push(dup(ctx.taint));
    // Operand 2 is the source state; it holds an encoded word, which is the one
    // thing the dispatch chain and this handler have in common.
    markDomains(instr, { 2: ctx.encoder.encodedDomain });
    out.push(instr);
  } else {
    const t = emitImm(out, ctx, Math.abs(delta));
    emitBinTo(out, ctx, delta >= 0 ? "ADD" : "SUB", rState, rState, t);
  }

  out.push([ctx.compiler.OP.JUMP!, { type: "label", label: loopTopLabel }]);
}

// Emit a CONDITIONAL state transition with no branch in it.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The obvious lowering of `if (cond) goto A; else goto B` under flattening is a
// real JUMP_IF_* over two constant transitions.  That lowering is what makes
// flattening removable.  A lifter that partially evaluates the bytecode forks
// at the branch and, on each side, `state` is a compile-time constant again —
// so every arm of the dispatch chain folds, the comparison chain collapses, and
// the whole state machine is reconstructed.  None of the MBA above stops that:
// an MBA over constants is still a constant, and a partial evaluator EXECUTES
// it instead of simplifying it.  Depth, non-linearity and variable count are
// all irrelevant when every leaf is known.
//
// So the branch is removed and the condition is folded into the state
// arithmetically:
//
//     b     = ~~(!cond)                  // 1 when cond is falsy, 0 when truthy
//     m     = -b                         // 0 or -1, an all-ones mask
//     state = state + d0 ± (m & |d1|)    // d0 = truthy target, d1 = the delta
//                                        //      that swings it to the falsy one
//
// `b` comes from the USER's program, so `state` is no longer a function of
// compile-time values alone.  A partial evaluator reaching the dispatcher now
// has an unknown in the state register: no arm folds, no edge is decided, and
// the flattened machine survives as a flattened machine.
//
// ── Why a mask and not `b * d1` ──────────────────────────────────────────────
// They compute the same thing for b in {0, 1}, but a MUL cannot be handed to
// the MBA layer: `x * y` over two unconstrained int32s reaches 2^62, past the
// point where float64 holds integers exactly, so mba-utils will not rewrite it
// and mbaExpand has no spec for it.  `-b & |d1|` is built from UNARY_NEG and
// BAND, both of which the MBA layer rewrites, so the entire chain from the
// condition to the state write ends up inside handlers.
//
// ── Correctness ──────────────────────────────────────────────────────────────
// `!cond` is total — it accepts any JS value, including the non-numeric ones a
// user predicate may hold — and the two complements narrow the resulting
// boolean to exactly 0 or 1.  Negating that gives 0 or -1, so the AND yields
// either 0 or |d1| exactly.  Only the UNARY_NOT is left unmarked: its INPUT is
// a user value rather than an int32, which is precisely the precondition the
// MBA algebra needs.  Everything downstream of it is int32 by construction.
function emitBranchlessTransition(
  out: Bytecode,
  rState: RegisterOperand,
  condSrc: RegisterOperand,
  currentState: number,
  stateIfTruthy: number,
  stateIfFalsy: number,
  loopTopLabel: string,
  ctx: EmitCtx,
): void {
  // b = ~~(!cond).  `!` first, so the source may hold any value; the two
  // complements then turn the boolean into an int32 0/1.  Note the polarity: b
  // is 1 when `cond` is FALSY.
  const notCond = emitUn(out, ctx, "UNARY_NOT", condSrc, /* safe */ false);
  const b0 = emitUn(out, ctx, "UNARY_BITNOT", notCond);
  const b = emitUn(out, ctx, "UNARY_BITNOT", b0);

  // On entry `state` holds this block's own value, so both legs are relative:
  // d0 lands on the truthy target, and d1 swings from there to the falsy one.
  const d0 = stateIfTruthy - currentState;
  const d1 = stateIfFalsy - stateIfTruthy;

  const mask = emitUn(out, ctx, "UNARY_NEG", b);

  if (ctx.encoder) {
    // The whole swing collapses into the encoded handler:
    // `E(D(state) + Dd(d0) + (m & Dd(d1)))`.  Both deltas ride as encoded
    // operands, so neither target is readable, and the mask still comes from
    // the user's condition — which is what keeps `state` out of reach of a
    // partial evaluator.
    const instr: Instruction = [
      ctx.encoder.condOp,
      dup(rState),
      dup(rState),
      dup(mask),
      ctx.encoder.encodeDelta(d0),
      ctx.encoder.encodeDelta(d1),
    ];
    if (ctx.taint) instr.push(dup(ctx.taint));
    // Operand 2 is the encoded state; operand 3 is the branchless mask, which
    // the three instructions above narrow to exactly 0 or -1.  Both are facts,
    // and both are what let this handler stop matching any operator on the
    // integers a classifier probes with.
    markDomains(instr, {
      2: ctx.encoder.encodedDomain,
      3: { int32: true, mask: true },
    });
    out.push(instr);
    out.push([ctx.compiler.OP.JUMP!, { type: "label", label: loopTopLabel }]);
    return;
  }

  const swing = emitBin(out, ctx, "BAND", mask, emitImm(out, ctx, Math.abs(d1)));

  const base = emitBin(
    out,
    ctx,
    d0 >= 0 ? "ADD" : "SUB",
    rState,
    emitImm(out, ctx, Math.abs(d0)),
  );
  emitBinTo(out, ctx, d1 >= 0 ? "ADD" : "SUB", rState, base, swing);
  out.push([ctx.compiler.OP.JUMP!, { type: "label", label: loopTopLabel }]);
}

// Fake (dead) block generation
// Create 1-5 blocks whose state values are NEVER the target of any real
// transition.
function generateFakeBlocks(
  compiler: Compiler,
  // Reserves a fresh, never-reached state per fake block. Drawn from the same
  // alphabet as a real one, so a fake arm is indistinguishable from a real one
  // and the residue class of the alphabet — plain and encoded — is preserved.
  assignState: () => number,
): BasicBlock[] {
  const fakeCount = getRandomInt(1, MAX_FAKE_BLOCKS);

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
  ctx: EmitCtx,
): void {
  // 50% chance for single random jump.
  if (chance(50)) {
    emitStateTransition(
      out,
      rState,
      block.stateValue,
      choice(targetStates),
      loopTopLabel,
      ctx,
    );
    return;
  }

  // Two-way fork, gated on an OPAQUE PREDICATE.
  //
  // `state & ~state` is 0 and `state | ~state` is -1 for every possible state,
  // so which arm runs is fixed — but the value is computed FROM `state`, so a
  // lifter's constant propagation widens it to UNKNOWN and has to emit both
  // arms.  That is the point: a fake block stops being distinguishable from a
  // real branch.  Both instructions are marked, so the MBA layer buries the
  // invariant inside a handler where the `x & ~x` shape is no longer visible.
  //
  // Correctness is trivial here regardless of which arm runs: this is a dead
  // block, and both arms are ordinary state transitions.
  const skipLabel = ctx.compiler._makeLabel("cff_skip");
  const complement = emitUn(out, ctx, "UNARY_BITNOT", rState);
  const predicate = emitBin(
    out,
    ctx,
    chance(50) ? "BAND" : "BOR",
    rState,
    complement,
  );
  out.push([
    ctx.compiler.OP.JUMP_IF_TRUE!,
    dup(predicate),
    { type: "label", label: skipLabel },
  ]);
  emitStateTransition(
    out,
    rState,
    block.stateValue,
    choice(targetStates),
    loopTopLabel,
    ctx,
  );
  out.push([null, { type: "defineLabel", label: skipLabel }]);
  emitStateTransition(
    out,
    rState,
    block.stateValue,
    choice(targetStates),
    loopTopLabel,
    ctx,
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

  // The residue class every state value in this function belongs to.
  const stateTag = getRandomInt(0, (1 << STATE_TAG_BITS) - 1);

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

  // A register this function's transition handlers will read and not depend on.
  // It is what stops a devirtualizer's constant propagation from folding the
  // state machine: the handler's inputs stop being compiler-chosen constants,
  // so the next state is unknown to an analysis that has no value for it, and
  // the computed jump stays computed.  See utils/mba-taint.ts — including why
  // no choice of register can make the emitted program wrong.
  const taintReg = compiler.options.mba
    ? pickTaintRegister(instrs, compiler, fnId, maxId)
    : null;

  // Put this function's state machine into an encoded domain, if the option is
  // on and the opcode space can supply the two handlers it needs.  Both are
  // minted here, before anything is emitted: the encode/decode cannot be
  // lowered to plain bytecode (there is no IMUL opcode), so a partial
  // conversion would be a broken program rather than a weaker one.  Null means
  // this function emits its ordinary unencoded machine.
  //
  // Gated on `mba` because the handlers are MBA_OPS entries, and the runtime
  // pass that turns those into switch cases only runs when the option is on.
  let encoder = compiler.options.mba
    ? createStateEncoder(
        compiler,
        fnId,
        { bits: STATE_TAG_BITS, tag: stateTag },
        taintReg !== null,
      )
    : null;

  // The alphabet.  Under an encoding it is drawn from the pre-filtered pool, so
  // every value the state register can hold is inside the encoded residue class
  // the two handlers were built to assume.  A pool too small for this function
  // means that assumption cannot be guaranteed, and the encoder is dropped
  // rather than the assumption weakened — the unencoded machine is still a
  // state machine, it just loses the domain.
  let statePool: number[] | null = null;
  if (encoder) {
    statePool = buildStatePool(stateTag, encoder);
    if (statePool.length < blocks.length + 1 + MAX_FAKE_BLOCKS) {
      disposeStateEncoder(compiler, encoder);
      encoder = null;
      statePool = null;
    }
  }

  const usedStates = new Set<number>();
  const assignState = (): number =>
    statePool && statePool.length > 0
      ? statePool.pop()!
      : assignTaggedState(usedStates, stateTag);

  for (const block of blocks) block.stateValue = assignState();

  // Pick endState sentinel.  It carries the tag too — a transition can write it
  // (a block with no successor falls through to it), so it is a value the state
  // register really holds and must not fall outside the alphabet's domain.
  const endState = assignState();

  const startState = blocks[0].stateValue;

  // 1c. Inject fake (dead) blocks
  const fakeBlocks = generateFakeBlocks(compiler, assignState);
  blocks.push(...fakeBlocks);

  // 2. Build dispatch loop from Template
  const dispatch = buildDispatchTemplate(
    blocks,
    endState,
    startState,
    compiler,
    fnId,
    maxId,
    encoder,
  );
  const { rState, loopTopLabel, loopExitLabel } = dispatch;

  // Everything the emitters below need.  Each of them allocates its own
  // short-lived temporaries out of the reusable "cff" pool rather than sharing
  // a pinned scratch bank, which is both cheaper (slots are recycled) and what
  // lets mbaSuperOps see a single-use dataflow chain it can fuse.
  const ctx: EmitCtx = {
    compiler,
    fnId,
    maxId,
    encoder,
    // Only carried when the encoder is: the taint rides as an extra operand on
    // the encoded transition handlers, and the unencoded lowering is plain
    // bytecode with no handler to fold it into.
    taint: encoder && encoder.taint ? taintReg : null,
  };

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
      emitFakeBlock(out, block, rState, fakeTargetStates, loopTopLabel, ctx);
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
    // The seed is written as `state = blockState | 0` rather than a MOVE, so
    // that the value arrives through an instruction the MBA layer can rewrite:
    // mbaSuperOps folds both immediates into the BOR's handler, and the state
    // value stops being a legible integer load.
    //
    // Under an encoding the seed is E(blockState), and the BOR is doing double
    // duty: it is the instruction the MBA layer can rewrite, AND it applies
    // ToInt32 to an operand that arrived from the bytecode stream unsigned.
    // Both the fused and the unfused lowering agree on that, so the seed is
    // correct whether or not mbaSuperOps reached it.
    if (directEntryLabels.has(block.label)) {
      const seed = emitImm(
        out,
        ctx,
        encoder ? encoder.encode(block.stateValue) : block.stateValue,
      );
      emitBinTo(out, ctx, "BOR", rState, seed, emitImm(out, ctx, 0));
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
        ctx,
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
            ctx,
          );
        } else {
          // Target outside this function's blocks — keep original
          out.push(term);
        }
      } else {
        out.push(term);
      }
    } else if (
      term[0] === OP.JUMP_IF_FALSE ||
      term[0] === OP.JUMP_IF_TRUE
    ) {
      // Both conditional terminators lower to the SAME branchless transition;
      // only which target belongs to which polarity differs.
      //
      //   JUMP_IF_FALSE cond, target →  falsy: target, truthy: fallthrough
      //   JUMP_IF_TRUE  cond, target →  truthy: target, falsy: fallthrough
      //
      // No JUMP_IF_* and no skip label survive: the edge stops being control
      // flow and becomes data.  See emitBranchlessTransition.
      const cond = term[1] as RegisterOperand;
      const targetLabel = extractLabel(term[2]);
      const targetState =
        targetLabel === null ? undefined : labelToState.get(targetLabel);

      if (targetState !== undefined) {
        const fallthroughState = fallthroughStateMap.get(origIdx)!;
        const onTrue =
          term[0] === OP.JUMP_IF_TRUE ? targetState : fallthroughState;
        const onFalse =
          term[0] === OP.JUMP_IF_TRUE ? fallthroughState : targetState;

        emitBranchlessTransition(
          out,
          rState,
          cond,
          block.stateValue,
          onTrue,
          onFalse,
          loopTopLabel,
          ctx,
        );
      } else {
        // Target outside this function's blocks — keep the original branch.
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
