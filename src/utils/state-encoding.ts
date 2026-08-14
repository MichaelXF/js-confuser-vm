// Encoded state machine for controlFlowFlattening
// ───────────────────────────────────────────────────────────────────────────
// controlFlowFlattening turns a function into a state machine whose `state`
// register selects the block to run.  By default that register holds the state
// value itself, which is what a static devirtualizer reads: the dispatch arms
// give it the alphabet, the transition deltas give it the edges, and the two
// together are the original CFG.
//
// This module puts the register into an ENCODED DOMAIN instead.  A per-function
// bijection E is drawn (see encoding-utils), the register holds E(s) rather than
// s, and every constant that reaches the bytecode is either an encoded state or
// an encoded delta — full-entropy 32-bit words with no readable structure.
//
// ── Why the hot path costs nothing ───────────────────────────────────────────
// E is a bijection, so E(a) === E(b) exactly when a === b.  The dispatch chain
// — walked once per ARM per transition, and the reason mbaExpand keeps a
// separate HOT budget — therefore compares encoded values directly and never
// decodes.  Its arms keep their relative-accumulator form, except that the walk
// moves by XOR rather than by addition, because encoded values have no additive
// structure worth telescoping through:
//
//     c = state ^ (state ^ E(s0));   if (state === c) ...
//     c = c ^ (E(s1) ^ E(s0));       if (state === c) ...
//
// Only a state TRANSITION decodes, and there is one of those per edge taken.
//
// ── The two handlers ─────────────────────────────────────────────────────────
// Both are minted here, per function, and both keep the delta as an OPERAND so
// that one handler serves every edge in the function rather than one handler
// per edge:
//
//   step:  state' = E( D(state) + Dd(p0) )
//   cond:  state' = E( D(state) + Dd(p0) + (m & Dd(p1)) )
//
// `Dd` is a second, cheaper bijection applied to the immediates.  Without it the
// operands would still be the small signed deltas of the plain state graph, and
// an attacker who read them would have the edge structure back — the encoding of
// the state alone would only cost them the labelling.
//
// The whole decode-compute-encode composite is built as ONE expression and then
// MBA-expanded, so no step of the three is separable in the output.
//
// ── All or nothing ───────────────────────────────────────────────────────────
// There is no IMUL opcode, and `MUL` is a float multiply that is not exact mod
// 2^32 for full-width operands — so E cannot be lowered to plain bytecode as a
// fallback.  A half-encoded state machine is a broken program, so both handlers
// are minted UP FRONT and createStateEncoder returns null if the opcode space
// cannot supply them.  The caller then emits its ordinary unencoded machine,
// which is self-consistent because the decision is per function.

import { Compiler } from "../compiler.ts";
import { createEncoding, type Encoding } from "./encoding-utils.ts";
import {
  entangleMBA,
  expandMBA,
  frameKeyConstants,
  mVar,
  mAdd,
  mAnd,
  mbaNodeCount,
  mbaVarNames,
  pinned,
  poisonMBA,
  poisonedLeaf,
  truncMBA,
  type FrameKey,
  type MBADomain,
  type MBAExpr,
  type MBAOptions,
} from "./mba-utils.ts";
import { nextFreeSlot } from "./op-utils.ts";
import { chance, getRandomInt } from "./random-utils.ts";

/** MBA variable names.  Deliberately clear of `v` / `c`, which mbaOpcodes
 *  reserves for the frame binding. */
const STATE_VAR = "a";
const MASK_VAR = "m";
const DELTA_VARS = ["p0", "p1"];
/** A register the handler reads and does not depend on — see utils/mba-taint. */
const TAINT_VAR = "t";

const FRAME_VAR = "v";
const FRAME_INV_VAR = "c";

// Bits of the ENCODED state word reserved for a residue tag.
//
// controlFlowFlattening already draws its plain state alphabet from one residue
// class, which is what lets the handler's interior — the decoded state, the
// sum, the next state — carry vectors that vanish on real values.  But the
// dispatch chain never decodes: it compares E(s) directly, so the only thing it
// ever touches is the encoded word, and the plain tag says nothing about that.
//
// So the encoded words get a tag of their own.  E is fixed first and the state
// values are then drawn to satisfy `E(s) & mask === tag` (see stateFilter), so
// this costs a rejection loop at compile time and nothing at runtime.  Four
// bits leaves 1/16 of the 8192 tagged plain values usable — around 500 per
// function, against block counts in the tens — and makes 15 of every 16 integer
// probes off-domain.
const ENC_TAG_BITS = 4;

// A transition handler is a dozen or so bindings — one per encoding round, plus
// the arithmetic in the middle — and each is expanded on its own.  The budget is
// per BINDING, so it is set low: the handler's opacity comes from the encoding
// it already carries, and depth spent here is paid on every edge taken.
const STEP_MBA: MBAOptions = {
  depth: 1,
  leafDepth: 1,
  identityChance: 30,
  mulChance: 20,
  poisonChance: 35,
};

// Bounds on the TOTAL, summed across every binding and the result.
const MIN_NODES = 200;
const MAX_NODES = 3000;
const DRAW_ATTEMPTS = 8;

export interface StateEncoder {
  /** E(plain), as the u32 a bytecode operand carries. */
  encode(plain: number): number;
  /** Dd^-1(delta) — the operand form of a signed plain-domain delta. */
  encodeDelta(delta: number): number;
  /** `dst = E(D(a) + Dd(p0))` */
  stepOp: number;
  /** `dst = E(D(a) + Dd(p0) + (m & Dd(p1)))` */
  condOp: number;
  /**
   * Whether a candidate plain state may be used: true when its encoding lands
   * in this function's encoded residue class.  The caller draws states through
   * it so `encodedDomain` below is a fact about every value the state register
   * can hold, rather than a claim about most of them.
   */
  stateFilter(plain: number): boolean;
  /**
   * The domain of the ENCODED state word — what the register itself holds, and
   * therefore what the dispatch chain's operands satisfy.  Handed to the MBA
   * passes through MBA_DOMAINS_SYM.
   */
  encodedDomain: MBADomain;
  /**
   * The domain of an encoded DELTA immediate in the dispatch chain, which walks
   * the accumulator by `c ^= E(si) ^ E(si-1)`.  Both operands carry the same
   * tag, so their XOR carries a tag of zero.
   */
  encodedDeltaDomain: MBADomain;
  /**
   * The taint register these handlers read, if any.  Present exactly when the
   * caller supplied one; the transition instructions must then carry it as a
   * trailing operand, in the order `srcNames` records.
   */
  taint: boolean;
}

/** A handler body: the bindings to evaluate in order, and the final value. */
interface Handler {
  bindings: [string, MBAExpr][];
  expr: MBAExpr;
}

const handlerSize = (h: Handler) =>
  h.bindings.reduce((n, [, e]) => n + mbaNodeCount(e), mbaNodeCount(h.expr));

const handlerVars = (h: Handler) =>
  h.bindings.flatMap(([, e]) => mbaVarNames(e)).concat(mbaVarNames(h.expr));

/**
 * Draw until the frame binding and the taint operand actually land somewhere in
 * the body and the total size is inside the band.  A handler is generated once,
 * so redrawing turns a likelihood into a guarantee — the same argument
 * mbaExpand's redraw() makes.
 *
 * The taint is not optional in the way the frame binding is.  Its operand is
 * appended to every transition instruction whether or not the expansion reached
 * it, and a handler that declares an operand it never reads consumes the wrong
 * number of words from the bytecode stream — so a draw without it is rejected
 * outright rather than merely disfavoured.
 */
function drawHandler(
  build: (o: MBAOptions) => Handler,
  options: MBAOptions,
  wantFrame: boolean,
  wantTaint: boolean,
): Handler {
  // Folded into the RESULT of any draw that missed it, rather than the draw
  // being rejected: a rejection loop makes it likely, and likely is not enough
  // when the operand is emitted unconditionally.
  //
  // The residue-class vector needs no equivalent guarantee — transition() poisons
  // the state and mask operands themselves, upstream of the decode, so every
  // draw carries one by construction and carries it on the INSIDE.
  const withTaint = (h: Handler): Handler => {
    if (!wantTaint || handlerVars(h).includes(TAINT_VAR)) return h;
    return { bindings: h.bindings, expr: entangleMBA(h.expr, TAINT_VAR) };
  };

  let smallest: Handler | null = null;
  let smallestSize = Infinity;

  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    // Step the budget down as attempts run out, so the ceiling is a real bound
    // rather than a preference.
    const rung: MBAOptions =
      attempt < DRAW_ATTEMPTS / 2
        ? options
        : { ...options, depth: 0, identityChance: 15, mulChance: 10 };
    const candidate = build(rung);
    if (wantFrame && !handlerVars(candidate).includes(FRAME_VAR)) continue;
    const size = handlerSize(candidate);
    if (size >= MIN_NODES && size <= MAX_NODES) return withTaint(candidate);
    if (size < smallestSize) {
      smallest = candidate;
      smallestSize = size;
    }
  }
  return withTaint(smallest ?? build(options));
}

/**
 * Give back the two opcode slots an encoder reserved.
 *
 * Needed because the encoder has to exist before the caller can tell whether it
 * is usable — the state alphabet is drawn through it (see StateEncoder's
 * `stateFilter`), so "is there room for this function's states inside the
 * encoded residue class?" is only answerable after E has been drawn and both
 * handlers minted.
 */
export function disposeStateEncoder(
  compiler: Compiler,
  encoder: StateEncoder,
): void {
  for (const op of [encoder.stepOp, encoder.condOp]) {
    delete compiler.MBA_OPS[op];
    delete compiler.OP_NAME[op];
  }
}

export function createStateEncoder(
  compiler: Compiler,
  fnId: number,
  stateTag: { bits: number; tag: number },
  /**
   * True when the caller will append a taint register to every transition
   * instruction it emits.  See utils/mba-taint.ts for what that is for.
   */
  hasTaint: boolean,
): StateEncoder | null {
  // Reserve both opcodes before building anything — see "All or nothing".
  const stepOp = nextFreeSlot(compiler);
  if (stepOp === -1) return null;
  // Claim the slot immediately: nextFreeSlot reads OP_NAME, so without this the
  // second call could hand back the same number.
  compiler.OP_NAME[stepOp] = `MBA_OPQ_${stepOp}`;
  const condOp = nextFreeSlot(compiler);
  if (condOp === -1) {
    delete compiler.OP_NAME[stepOp];
    return null;
  }
  compiler.OP_NAME[condOp] = `MBA_OPQ_${condOp}`;

  const state: Encoding = createEncoding(true);
  // Immediates get a cheap encoding: their decode runs on the same path as the
  // state's, and one polynomial round per transition is enough.
  const imm: Encoding = createEncoding(false);

  // The residue class the ENCODED words land in. Fixed here, after E is drawn,
  // and enforced by rejecting plain states whose encoding misses it.
  const encMask = (1 << ENC_TAG_BITS) - 1;
  const encTag = getRandomInt(0, encMask);

  const frameBound = chance(85);
  const frame: FrameKey | null = frameBound
    ? frameKeyConstants(compiler.fnDescriptors[fnId]?.salt ?? 0)
    : null;

  // Domains are per HANDLER, not shared: a domain naming a variable the
  // handler has no operand for would put a reference to it in the body, and
  // there would be nothing to bind it to.
  //
  // Every value that reaches either handler is a word this compiler chose — the
  // state register only ever holds E(s), the mask is 0 or -1, and the
  // immediates are its own encoded deltas.  So these are facts here rather than
  // inferences, and two of them are worth more than int32-ness:
  //
  //   a  the encoded state, which lands in one residue class by construction
  //      (see ENC_TAG_BITS) — so 15 of every 16 integers a prober substitutes
  //      are outside the set this handler has to be correct on;
  //   m  the branchless mask, which is 0 or -1 and nothing else.
  //
  // The taint operand gets no domain at all: it is a user register, and the
  // only thing the compiler knows about it is that it holds SOMETHING.
  // `extra` names intermediates that are in scope AT THIS POINT and carry a
  // domain of their own — see the plain-domain composition in transition().
  const stateDomain: MBADomain = {
    int32: true,
    modTag: { bits: ENC_TAG_BITS, tag: encTag },
  };
  const maskDomain: MBADomain = { int32: true, mask: true };

  const optionsFor = (
    withMask: boolean,
    extra: Record<string, MBADomain>,
    budget: MBAOptions,
  ): MBAOptions => {
    const domains: Record<string, MBADomain> = { ...extra };
    domains[STATE_VAR] = stateDomain;
    if (withMask) domains[MASK_VAR] = maskDomain;
    return {
      ...budget,
      // The taint joins the noise pool: entangling it is what puts it in the
      // expression at all, and every rule that consumes a noise operand is an
      // identity, so the handler's value stays independent of it.
      noise: hasTaint ? [STATE_VAR, TAINT_VAR] : [STATE_VAR],
      domains,
      ...(frameBound ? { frameVar: FRAME_VAR, invVar: FRAME_INV_VAR } : {}),
    };
  };

  // Decode the state, decode each delta, add them, re-encode.  Every round is
  // its own binding and every binding is expanded on its own, so the decode,
  // the arithmetic and the encode are one undifferentiated run of opaque
  // assignments rather than three recognisable phases.
  const transition = (withMask: boolean, budget: MBAOptions): Handler => {
    const bindings: [string, MBAExpr][] = [];
    const take = (steps: { bindings: [string, MBAExpr][]; result: MBAExpr }) => {
      bindings.push(...steps.bindings);
      return steps.result;
    };

    // The state operand goes into the decode ALREADY POISONED over its own
    // residue class.  Every round of E⁻¹ then runs on the poisoned word, so the
    // term is inside the entire handler rather than folded around its result —
    // which is what stops a prober from watching the vector at the outside and
    // subtracting it back off.  On a real encoded state the vector is 0, so the
    // decode sees exactly what it always saw.
    const decoded = take(
      state.decodeSteps(poisonedLeaf(STATE_VAR, stateDomain), (i) => `zd${i}`),
    );
    // The first index at which the decoded state is bound and readable — the
    // binding that PRODUCES it may not reference itself.
    const plainFrom = bindings.length;
    const decodedName = decoded.k === "var" ? decoded.name : null;

    const d0 = take(imm.decodeSteps(mVar(DELTA_VARS[0]), (i) => `zi${i}`));

    let sum: MBAExpr = mAdd(decoded, d0);
    if (withMask) {
      const d1 = take(imm.decodeSteps(mVar(DELTA_VARS[1]), (i) => `zj${i}`));
      // `m` is 0 or -1, so this contributes the second delta or nothing — the
      // branchless form controlFlowFlattening already relies on.  Poisoned over
      // that same {0, -1} set: anything else fed in here selects neither.
      sum = mAdd(sum, mAnd(poisonedLeaf(MASK_VAR, maskDomain), d1));
    }
    bindings.push(["zs", pinned(truncMBA(sum))]);
    const sumIndex = bindings.length - 1;

    const encoded = state.encodeSteps(mVar("zs"), (i) => `ze${i}`);
    bindings.push(...encoded.bindings);

    // ── The two layers compose here ──────────────────────────────────────────
    // Inside this handler the decoded value is a PLAIN state, and every plain
    // state controlFlowFlattening chose lies in one residue class mod 2^bits —
    // as does every delta between two of them, and therefore their sum.  So
    // the bindings downstream of the decode can carry vectors that vanish on
    // that class and nowhere else, on top of the int32 vectors over the
    // sources.
    //
    // The scoping is load-bearing.  A vector over `zd*` folded into a binding
    // that runs BEFORE it would read a hoisted `var` still holding undefined,
    // and `(undefined & 7) ^ tag` is `tag` — non-zero, so it would corrupt
    // every transition rather than vanish.  Domains are therefore introduced by
    // POSITION: a binding may only use the intermediates already bound above it.
    const plainDomain: MBADomain = {
      modTag: { bits: stateTag.bits, tag: stateTag.tag },
    };

    const optionsAt = (index: number): MBAOptions => {
      const extra: Record<string, MBADomain> = {};
      // The decoded state itself, once it exists.
      if (decodedName && index >= plainFrom) extra[decodedName] = plainDomain;
      // And the sum, which is the NEXT state and so equally tagged.
      if (index > sumIndex) extra.zs = plainDomain;
      return optionsFor(withMask, extra, budget);
    };

    return {
      // The truncation goes on AFTER expansion, which is the only placement
      // that needs no pinning to be safe: nothing rewrites it afterwards.  Each
      // binding therefore holds an exact int32 no matter what the expansion did
      // to its interior — see the same argument in encoding-utils' steps().
      bindings: bindings.map(([name, e], i) => {
        const o = optionsAt(i);
        return [name, pinned(truncMBA(expandMBA(poisonMBA(e, o), o)))];
      }),
      expr: encoded.result,
    };
  };

  const step = drawHandler(
    (o) => transition(false, o),
    STEP_MBA,
    frameBound,
    hasTaint,
  );
  const cond = drawHandler(
    (o) => transition(true, o),
    STEP_MBA,
    frameBound,
    hasTaint,
  );

  const register = (
    op: number,
    handler: Handler,
    srcNames: string[],
    srcKinds: ("reg" | "imm")[],
    withMask: boolean,
  ) => {
    compiler.MBA_OPS[op] = {
      bindings: handler.bindings,
      // There is no operator this replaced — a transition is a decode, an add
      // and an encode fused together.  JUMP is recorded only so the registry
      // entry names something real.
      originalOp: compiler.OP.JUMP!,
      arity: 1 + srcNames.length,
      expr: handler.expr,
      // Exact either way (every source is int32 by construction), and applying
      // it unconditionally keeps generated handlers from splitting into two
      // populations told apart by whether they coerce.
      normalize: true,
      fnId: frameBound ? fnId : null,
      frame: frame ?? undefined,
      srcNames,
      srcKinds,
      taintNames: hasTaint ? [TAINT_VAR] : undefined,
      domains: withMask
        ? { [STATE_VAR]: stateDomain, [MASK_VAR]: maskDomain }
        : { [STATE_VAR]: stateDomain },
    };
  };

  // The taint rides LAST, after the immediates, so the handler's operand reads
  // stay in instruction order and the caller can append it unconditionally.
  register(
    stepOp,
    step,
    hasTaint
      ? [STATE_VAR, DELTA_VARS[0], TAINT_VAR]
      : [STATE_VAR, DELTA_VARS[0]],
    hasTaint ? ["reg", "imm", "reg"] : ["reg", "imm"],
    false,
  );
  register(
    condOp,
    cond,
    hasTaint
      ? [STATE_VAR, MASK_VAR, DELTA_VARS[0], DELTA_VARS[1], TAINT_VAR]
      : [STATE_VAR, MASK_VAR, DELTA_VARS[0], DELTA_VARS[1]],
    hasTaint
      ? ["reg", "reg", "imm", "imm", "reg"]
      : ["reg", "reg", "imm", "imm"],
    true,
  );

  return {
    // `>>> 0` on both: a bytecode slot is a u32, and the encodings produce
    // signed int32s.  mbaOpcodes coerces every immediate back with `| 0` on the
    // way in, so the handler sees the same value that went out.
    encode: (plain) => state.encodeValue(plain) >>> 0,
    // The handler DECODES this operand, so what the instruction must carry is
    // the word that decodes TO the delta — i.e. its encoding.
    encodeDelta: (delta) => imm.encodeValue(delta) >>> 0,
    stepOp,
    condOp,
    // Drawn against the SIGNED encoding, matching what the dispatch chain
    // compares and what a handler reads back after its `| 0`.
    stateFilter: (plain) => (state.encodeValue(plain) & encMask) === encTag,
    encodedDomain: stateDomain,
    // Both encoded words carry `encTag`, so `E(si) ^ E(si-1)` carries 0.
    encodedDeltaDomain: {
      int32: true,
      modTag: { bits: ENC_TAG_BITS, tag: 0 },
    },
    taint: hasTaint,
  };
}
