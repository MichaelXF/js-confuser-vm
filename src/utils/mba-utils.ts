// Mixed Boolean-Arithmetic (MBA) utilities
// ───────────────────────────────────────────────────────────────────────────
// An MBA identity rewrites a simple operation into an equivalent expression
// that mixes arithmetic (+ - *) with bitwise (& | ^ ~ << >>>) operators.  Since
// neither arithmetic laws nor boolean laws apply to the mixture, the result
// resists the pattern-matching that static devirtualizers are built on.
//
// This module is the shared MBA layer: an expression IR, a randomized rewrite
// engine, and two backends — a JS source printer (for Template-compiled code)
// and a bytecode emitter (for passes that build instructions directly).  Any
// future pass that wants MBA should build on these rather than hand-rolling
// identities.
//
// ── Correctness contract ─────────────────────────────────────────────────────
//
// Every rewrite here preserves the value MODULO 2^32.  That is the natural
// domain of the algebra and the only one in which the classic identities hold.
// Two rules follow from that and both are enforced by this module:
//
//   1. Every leaf (variable or constant) MUST hold an int32 value.  Callers are
//      responsible for this; for compiler-generated state machines (CFF state
//      values, deltas, PCs) it is true by construction.
//
//   2. The RESULT must be truncated back to int32 before it is compared or
//      stored, because JS `+ - *` are float64 and an intermediate may legally
//      land a multiple of 2^32 away from the true value.  truncMBA() does this
//      and every high-level builder below applies it.  (`| 0`, `^ 0` and `~~`
//      are all exact int32 truncations, chosen at random for diversity.)
//
// Magnitude safety: bitwise operators ToInt32 their operands, which resets
// intermediate magnitude to <= 2^31 at every bitwise node.  Only chains of
// pure +/-/* grow, and they grow by a small constant factor per rewrite level.
// With int32 leaves and MAX_DEPTH levels the worst case stays near 2^37 —
// far inside float64's exact-integer range (2^53), so no low bits are ever
// lost and the mod-2^32 invariant holds.  MAX_DEPTH exists to guarantee that.
//
// ── Why these identities and not "as many as possible" ───────────────────────
// A linear MBA (a sum of bitwise terms with CONSTANT coefficients) is fully
// determined by its behaviour on the 2^k bit-patterns of k variables, so it can
// be solved by evaluation regardless of how deeply it is nested.  Depth alone
// is therefore the weakest axis.  What actually costs an attacker is
//   • entangling MORE variables       (raises 2^k)          — see `noise`
//   • operators outside the algebra   (>>> , <<, logical !) — see zeroTest()
//   • never materialising the whole expression in one place — the caller's job
//     (in CFF, running before the dispatch loop splits blocks apart).
// The rule set below is chosen to hit all three.

import * as t from "@babel/types";
import { choice, chance, getRandomInt } from "./random-utils.ts";
import type { Bytecode, RegisterOperand } from "../types.ts";
import { Compiler } from "../compiler.ts";
import { allocReg } from "./pass-utils.ts";
import { U16_MAX, U32_MAX } from "./op-utils.ts";

// ── Expression IR ────────────────────────────────────────────────────────────

// `imul` is Math.imul — exact multiplication mod 2^32. It exists here for the
// frame-bound rules, which multiply by a full 32-bit modular inverse and so
// cannot use `*` (the product would blow past float64's exact range). It has no
// VM opcode, so it is only legal in expressions destined for a generated
// handler; emitMBA rejects it.
export type MBABinOp =
  | "+"
  | "-"
  | "*"
  | "^"
  | "&"
  | "|"
  | "<<"
  | ">>"
  | ">>>"
  | "imul";
export type MBAUnOp = "~" | "neg" | "not";

// `fixed` pins a node against further rewriting (its children are still
// expanded).  Needed wherever a node's exact SHAPE carries a guarantee the
// algebra does not: a `| 0` truncation, or a `& 0xffff` magnitude bound.  Both
// are semantics-preserving to rewrite but not guarantee-preserving — e.g.
// OR_RULES' `(x + y) - (x & y)` reproduces `x | 0`'s value without truncating,
// which would silently unbound a multiplicand. See MUL_IDENTITY_RULES.
export type MBAExpr =
  | { k: "var"; name: string }
  | { k: "num"; value: number }
  | { k: "bin"; op: MBABinOp; l: MBAExpr; r: MBAExpr; fixed?: boolean }
  | { k: "un"; op: MBAUnOp; v: MBAExpr; fixed?: boolean };

export const mVar = (name: string): MBAExpr => ({ k: "var", name });
export const mNum = (value: number): MBAExpr => ({ k: "num", value });

const bin = (op: MBABinOp, l: MBAExpr, r: MBAExpr): MBAExpr => ({
  k: "bin",
  op,
  l,
  r,
});
const un = (op: MBAUnOp, v: MBAExpr): MBAExpr => ({ k: "un", op, v });

export const mAdd = (l: MBAExpr, r: MBAExpr) => bin("+", l, r);
export const mSub = (l: MBAExpr, r: MBAExpr) => bin("-", l, r);
export const mMul = (l: MBAExpr, r: MBAExpr) => bin("*", l, r);
export const mXor = (l: MBAExpr, r: MBAExpr) => bin("^", l, r);
export const mAnd = (l: MBAExpr, r: MBAExpr) => bin("&", l, r);
export const mOr = (l: MBAExpr, r: MBAExpr) => bin("|", l, r);
export const mShl = (l: MBAExpr, r: MBAExpr) => bin("<<", l, r);
export const mImul = (l: MBAExpr, r: MBAExpr) => bin("imul", l, r);
export const mUshr = (l: MBAExpr, r: MBAExpr) => bin(">>>", l, r);
export const mShr = (l: MBAExpr, r: MBAExpr) => bin(">>", l, r);
export const mBNot = (v: MBAExpr) => un("~", v);
export const mNeg = (v: MBAExpr) => un("neg", v);
export const mLNot = (v: MBAExpr) => un("not", v);

// ── Rewrite rules ────────────────────────────────────────────────────────────
//
// Each rule is verified bit-by-bit: writing u = x_i and v = y_i for the i-th
// bit, the rule must reproduce the same integer contribution as the original.
// (e.g. x + y contributes u + v, and (x^y) + 2*(x&y) contributes
// (u + v - 2uv) + 2uv = u + v.)  Two's-complement sign bits cancel identically,
// so each identity holds over the full int32 range mod 2^32.

type BinRule = (x: MBAExpr, y: MBAExpr) => MBAExpr;
type UnRule = (x: MBAExpr) => MBAExpr;

const ADD_RULES: BinRule[] = [
  // (u+v-2uv) + 2uv
  (x, y) => mAdd(mXor(x, y), mMul(mNum(2), mAnd(x, y))),
  // same, but the doubling is a shift — equivalent mod 2^32
  (x, y) => mAdd(mXor(x, y), mShl(mAnd(x, y), mNum(1))),
  // (u+v-uv) + uv
  (x, y) => mAdd(mOr(x, y), mAnd(x, y)),
  // 2(u+v-uv) - (u+v-2uv)
  (x, y) => mSub(mMul(mNum(2), mOr(x, y)), mXor(x, y)),
  // (u+v-2uv) + uv + uv
  (x, y) => mAdd(mAdd(mXor(x, y), mAnd(x, y)), mAnd(x, y)),
];

const SUB_RULES: BinRule[] = [
  // ~y === -y-1, so x + ~y + 1 === x - y
  (x, y) => mAdd(mAdd(x, mBNot(y)), mNum(1)),
  // u(1-v) - (1-u)v = u - v
  (x, y) => mSub(mAnd(x, mBNot(y)), mAnd(mBNot(x), y)),
  // (u+v-2uv) - 2(1-u)v = u - v
  (x, y) => mSub(mXor(x, y), mMul(mNum(2), mAnd(mBNot(x), y))),
  // add-identity applied to x + ~y, then +1
  (x, y) =>
    mAdd(
      mAdd(mXor(x, mBNot(y)), mMul(mNum(2), mAnd(x, mBNot(y)))),
      mNum(1),
    ),
  // defer to the unary negation rules
  (x, y) => mAdd(x, mNeg(y)),
];

const XOR_RULES: BinRule[] = [
  (x, y) => mSub(mOr(x, y), mAnd(x, y)),
  (x, y) => mAnd(mOr(x, y), mBNot(mAnd(x, y))),
  (x, y) => mOr(mAnd(x, mBNot(y)), mAnd(mBNot(x), y)),
  (x, y) => mSub(mAdd(x, y), mMul(mNum(2), mAnd(x, y))),
  // ~((x&y) | ~(x|y)) === (x|y) & ~(x&y)
  (x, y) => mBNot(mOr(mAnd(x, y), mBNot(mOr(x, y)))),
];

const AND_RULES: BinRule[] = [
  (x, y) => mSub(mOr(x, y), mXor(x, y)),
  (x, y) => mSub(mAdd(x, y), mOr(x, y)),
  // De Morgan
  (x, y) => mBNot(mOr(mBNot(x), mBNot(y))),
  // (u|v) & ~(u^v) === uv
  (x, y) => mAnd(mOr(x, y), mBNot(mXor(x, y))),
];

const OR_RULES: BinRule[] = [
  (x, y) => mAdd(mAnd(x, y), mXor(x, y)),
  (x, y) => mSub(mAdd(x, y), mAnd(x, y)),
  (x, y) => mBNot(mAnd(mBNot(x), mBNot(y))),
  (x, y) => mOr(mXor(x, y), mAnd(x, y)),
];

const BIN_RULES: Partial<Record<MBABinOp, BinRule[]>> = {
  "+": ADD_RULES,
  "-": SUB_RULES,
  "^": XOR_RULES,
  "&": AND_RULES,
  "|": OR_RULES,
  // `*`, `<<` and `>>>` are structural (coefficients / bit tests), not rewritten.
};

const UN_RULES: Partial<Record<MBAUnOp, UnRule[]>> = {
  "~": [
    (x) => mSub(mNeg(x), mNum(1)), // ~x === -x - 1
    (x) => mNeg(mAdd(x, mNum(1))), // ~x === -(x + 1)
  ],
  neg: [
    (x) => mAdd(mBNot(x), mNum(1)), // -x === ~x + 1
    (x) => mBNot(mSub(x, mNum(1))), // -x === ~(x - 1)
  ],
  // `not` is the logical predicate at the very top of a zero test — leaving it
  // alone keeps the result a clean boolean for JUMP_IF_TRUE / JUMP_IF_FALSE.
};

// Identity expansions: rewrite x into an expression that also mentions an
// unrelated value t.  This is the rule that matters most — it manufactures a
// data dependency on a register the attacker must prove is irrelevant, and it
// raises the variable count that any evaluation-based solver has to cover.
// Valid for ANY int32 t.
const IDENTITY_RULES: BinRule[] = [
  (x, t) => mOr(mAnd(x, mBNot(t)), mAnd(x, t)), // (x&~t) | (x&t)
  (x, t) => mAdd(mAnd(x, mBNot(t)), mAnd(x, t)), // (x&~t) + (x&t)
  (x, t) => mXor(mXor(x, t), t),
  (x, t) => mSub(mAdd(x, t), t),
  (x, t) => mSub(mOr(x, t), mAnd(mBNot(x), t)), // (x|t) - (~x&t)
  (x, t) => mXor(mAnd(x, mBNot(t)), mAnd(x, t)), // (x&~t) ^ (x&t)
];

// Opaque zeros: expressions that are provably 0 for every t, used to make a
// constant load depend on a runtime register (so a lifter's constant
// propagation widens it to UNKNOWN instead of reading the value off).
const ZERO_RULES: BinRule[] = [
  (x, t) => mAdd(mSub(mXor(x, t), mOr(x, t)), mAnd(x, t)), // (x^t)-(x|t)+(x&t)
  (x, t) => mSub(mSub(mAdd(mAnd(x, t), mOr(x, t)), x), t), // (x&t)+(x|t)-x-t
  (x, t) => mSub(mSub(mXor(x, t), mAnd(x, mBNot(t))), mAnd(mBNot(x), t)),
];

// Arithmetic invariants — also always 0, but for a CARRY reason rather than a
// per-bit one.  That distinction is the whole point of keeping them separate:
// the standard way to simplify an MBA is to evaluate it across the 2^k
// bit-patterns at a single bit position, which resolves anything built from
// bitwise terms with constant coefficients.  "n*(n+1) is even" is not a
// property of any single bit position, so that technique does not see it.
//
// The 0xffff mask is load-bearing: it keeps the product under 2^32 so float64
// represents it exactly.  Without it an int32-sized operand would push the
// product past 2^53, the low bits would round away, and the invariant — which
// lives entirely in bit 0 — would break.
const ARITHMETIC_ZERO_RULES: UnRule[] = [
  // n * (n+1) is the product of consecutive integers, hence even.
  (x) => {
    const n = mAnd(x, mNum(0xffff));
    return mAnd(mMul(n, mAdd(n, mNum(1))), mNum(1));
  },
  // n^2 + n === n * (n+1), same invariant by a different route.
  (x) => {
    const n = mAnd(x, mNum(0xffff));
    return mAnd(mAdd(mMul(n, n), n), mNum(1));
  },
  // (x|1) always has bit 0 set.
  (x) => mSub(mAnd(mOr(x, mNum(1)), mNum(1)), mNum(1)),
  // A value and its complement share no bits.
  (x) => mAnd(x, mBNot(x)),
];

// Multiplicative identity expansions — the only rules here that multiply by a
// VARIABLE, which takes the result out of the linear MBA class entirely.  That
// matters because linear MBA (bitwise terms with constant coefficients) is
// decided by evaluating across the 2^k bit-patterns at one bit position; a
// variable coefficient is not a per-bit property, so that whole technique stops
// applying.  It also stops the output looking like the textbook two-variable
// forms that are trivial to recognise on sight.
//
// ── Why this is safe when a bare int32 × int32 is not ────────────────────────
// float64 holds integers exactly only to 2^53, and every MBA identity lives in
// the low bits.  An unbounded int32 product reaches 2^62 and rounds those bits
// away — measurably: `(a|b)^2 - (a&b)^2 == (a+b)*(a^b)` is a true identity that
// still fails on 13 of 256 int32 pairs for exactly this reason.
//
// So both multiplicands are pinned:
//   • `x` is truncated to int32   → |x| <= 2^31
//   • `t` is masked to 16 bits    → |t| <= 2^16
// giving a worst-case product of 2^47, which leaves 64x headroom under 2^53.
// Both pins use `fixed` nodes, because a rewrite that merely preserved their
// VALUE (`x | 0` → `(x + 0) - (x & 0)`) would drop the bound they exist for.
const MUL_IDENTITY_RULES: BinRule[] = [
  // (t|1) - (t & ~1) === 1 for every t: setting bit 0 and clearing it differ
  // by exactly one, whichever way bit 0 started.
  (x, t) => {
    const xt = pinnedTrunc(x);
    const t16 = pinnedMask16(t);
    return mSub(
      mMul(xt, mOr(t16, mNum(1))),
      mMul(xt, mAnd(t16, mBNot(mNum(1)))),
    );
  },
  // b + (b ^ 1) === 1 for b = t & 1, so x*b + x*(b^1) === x.
  (x, t) => {
    const xt = pinnedTrunc(x);
    const b = mAnd(pinnedMask16(t), mNum(1));
    return mAdd(mMul(xt, b), mMul(xt, mXor(b, mNum(1))));
  },
];

// Frame-bound rules — the only ones here that are NOT identities, and the only
// ones whose correctness depends on WHICH FRAME is executing.
//
// Every other rule holds for whatever you substitute, so a reader cancels the
// extra operand by inspection: `x*(t&1) + x*((t&1)^1)` collapses to `x` without
// knowing anything about `t`. Pinning `t` to a constant does not help either if
// the constant is guessable — `x * (v - 630)` announces that `v` is 631.
//
// These take a different route. Every odd number has a multiplicative inverse
// mod 2^32, so for `v` odd and `c = modInverse32(v)`:
//
//     imul(imul(x, v), c) === x        (exactly, for every int32 x)
//
// The caller supplies `v` derived from the executing frame's SALT slot — the
// identity word of whichever function is running, see utils/frame-layout.ts —
// and `c` baked from the salt the handler's OWN function carries.
// Consequences:
//
//   • Neither literal resembles the salt, or each other.
//   • Run the same handler inside a different function and `v` changes,
//     `imul(v, c)` is no longer 1, and the result is garbage. The handler is
//     bound to one function, not merely to a frame shape.
//   • That also breaks lifting the handler out and probing it against
//     fabricated state, since fabricated state has no salt to supply.
//
// The salt is what makes this more than obscurity against reading. `c` still
// inverts back to `v` with the same Newton iteration used to build it, so an
// attacker holding the body can always recover the value it wants — but
// recovering a value is not the same as being able to SUPPLY it. The salt
// appears nowhere except one MAKE_CLOSURE operand and one slot of a live frame,
// nothing in the interpreter recomputes it, and it is 2^32 wide. This binding
// previously read the frame's register count, which is a small integer, is
// derivable from the frame itself, and which an interpreter oracle hands over
// on request.
type FrameRule = (x: MBAExpr, v: MBAExpr, c: MBAExpr) => MBAExpr;

const FRAME_BOUND_RULES: FrameRule[] = [
  (x, v, c) => mImul(mImul(x, v), c),
  (x, v, c) => mImul(mImul(x, c), v),
  // imul(v, c) is 1, so this is a single multiply by one — but only in the
  // right frame.
  (x, v, c) => mImul(x, mImul(v, c)),
  (x, v, c) => mImul(mImul(mImul(x, v), c), mImul(v, c)),
];

/**
 * Multiplicative inverse mod 2^32, for odd `n`. Newton iteration: each step
 * doubles the number of correct bits, so five steps cover 32 bits.
 * `imul(n, modInverse32(n)) === 1` for every odd n.
 */
export function modInverse32(n: number): number {
  let x = n | 0;
  for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(n, x)) | 0;
  return x | 0;
}

/** The two baked words of one frame binding, plus the value they undo. */
export interface FrameKey {
  /** Scramble applied to the frame's SALT slot at runtime. */
  mul: number;
  xor: number;
  /** modInverse32 of the scrambled salt this handler's own function carries. */
  inverse: number;
}

/**
 * Pick the scramble constants for one frame-bound handler, and the inverse that
 * undoes them for `salt`.
 *
 * `v = (imul(salt, mul) ^ xor) | 1` is always odd, so it always has an inverse
 * mod 2^32.  Redrawing until both words are large keeps them opaque: a small
 * multiplicand inverts to a well-known magic constant (modInverse32(3) is
 * 0xAAAAAAAB), and v === 1 would make the whole binding a no-op.
 *
 * Drawn by whichever bytecode pass registers the handler rather than by the
 * runtime pass that emits it, so the pair is part of the MBA_OPS record and the
 * build-time fit check can reproduce a real frame without re-deriving anything.
 */
export function frameKeyConstants(salt: number): FrameKey {
  const MIN_MAGNITUDE = 0xffff;
  for (let attempt = 0; ; attempt++) {
    // An odd multiplier keeps imul a bijection, so distinct salts stay distinct.
    const mul = (getRandomInt(1, 0x7fffffff) * 2 + 1) | 0;
    const xor = getRandomInt(1, 0x7fffffff) | 0;
    const v = ((Math.imul(salt, mul) ^ xor) | 1) | 0;
    const inverse = modInverse32(v);
    if (
      attempt > 32 ||
      (Math.abs(v) > MIN_MAGNITUDE && Math.abs(inverse) > MIN_MAGNITUDE)
    )
      return { mul, xor, inverse };
  }
}

/** The runtime value of the frame-binding variable `v` for a given salt. */
export function frameKeyValue(key: FrameKey, salt: number): number {
  return ((Math.imul(salt, key.mul) ^ key.xor) | 1) | 0;
}

/** Pin a node against rewriting.  Its children are still expanded. */
export function pinned(e: MBAExpr): MBAExpr {
  if (e.k === "bin") return { ...e, fixed: true };
  if (e.k === "un") return { ...e, fixed: true };
  return e;
}

// ── Domain-restricted identities ─────────────────────────────────────────────
//
// Every rule above this line is TOTAL: it holds for all of Z/2^32.  That is a
// stronger promise than this obfuscator actually has to make, and the surplus
// is what an attacker's simplifier runs on.
//
// The standard MBA simplifiers (SiMBA, MBA-Blast, GAMBA, and the sampling
// simplifier in JS-Confuser) share one method: evaluate the candidate and the
// rewrite over a sample of the FULL input space, and accept the rewrite only
// where they agree everywhere.  Their soundness rule is total equivalence.
//
// So stop being totally equivalent.  Where the compiler CHOOSES every value a
// variable can hold, the identity only has to hold on that set D.  A term that
// vanishes on D and nowhere else can then be added with any coefficient:
//
//     handler = core(a, b) + Z(a) - Z(b)
//
// On D this is exactly `core`.  Off D it is a different function, so:
//
//   • a sampler drawing from the full space sees a function matching no
//     candidate, and refuses every rewrite;
//   • a signature-based solver enumerating truth assignments computes the
//     signature of the wrong function entirely;
//   • a black-box classifier sampling the handler to identify its operator
//     gets no match.
//
// ── Where the probes actually land ───────────────────────────────────────────
//
// A domain only earns its size if the vector FIRES on the values a prober
// substitutes, and that is a sharper requirement than it looks.  A black-box
// classifier separates its probes into two populations: integers, which decide
// the fit, and everything else (floats, strings, NaN, objects), which it uses
// only to NARROW an already-passing candidate set.  The observed shape is
//
//     survivors = candidates matching every INTEGER probe
//     refined   = survivors matching every general probe
//     if (refined is empty) keep survivors      // general probes discarded
//
// so a vector that fires exclusively on non-integers changes nothing at all:
// it empties `refined`, the classifier falls back, and the integer fit stands.
// That is measurable — it is what happened to the `int32` vector below, which
// shipped in 175 places and cost an attacker nothing.
//
// Every domain therefore carries a `strength`:
//
//   FIRING — the vector is non-zero on ordinary small integers, so it lands in
//            the population that decides the fit.  These are the ones worth
//            spending on.
//   WEAK   — the vector is only non-zero outside int32 (or is zero everywhere
//            an attacker can reach).  Kept as filler, never relied on.
//
// The catch is that D has to be REAL.  Every domain below is one the compiler
// establishes by construction, never one an analysis inferred:
//
//   modTag  — controlFlowFlattening draws its state alphabet from ONE residue
//             class, in both the plain and the encoded domain, so states and
//             the deltas between them are congruent by construction.  FIRING:
//             a probe of 3 or 255 is off-tag with probability 1 - 2^-bits.
//   bool    — the value is a comparison result narrowed to 0/1.  FIRING: every
//             probe outside {0, 1}.
//   mask    — the value is a branchless select mask, 0 or -1 exactly.  FIRING:
//             every probe outside {0, -1}.
//   int32   — the precondition the whole MBA algebra already requires.  WEAK,
//             for the reason above; it survives as filler because it is free.
//
// Every vector is built from Math.imul, which keeps it int32 (so it cannot
// break the magnitude invariant) and — because there is no IMUL opcode — makes
// the whole family handler-only, exactly like FRAME_BOUND_RULES.  emitMBA
// rejects it if it ever reaches the bytecode backend.

/** What is known to be true of a variable in EVERY real execution. */
export interface MBADomain {
  /**
   * Always an int32.  WEAK — the vector it enables is zero on every integer,
   * so it only reaches probes a classifier is willing to discard.
   */
  int32?: boolean;
  /** Always congruent to `tag` modulo 2^`bits`.  FIRING. */
  modTag?: { bits: number; tag: number };
  /** Always exactly 0 or 1 (a narrowed comparison result).  FIRING. */
  bool?: boolean;
  /** Always exactly 0 or -1 (a branchless select mask).  FIRING. */
  mask?: boolean;
}

/**
 * True when `domain` supports a vector that is non-zero on ordinary integers —
 * i.e. one that reaches the probes a black-box classifier uses to DECIDE a fit
 * rather than the ones it discards.  The build-time fit check uses this to know
 * which handlers are required to match no operator.
 */
export function domainFires(domain: MBADomain): boolean {
  return !!(domain.modTag || domain.bool || domain.mask);
}

/**
 * Prefix for the alias bound to a source operand's RAW value — before the
 * tier-0 `~~` coercion.  The int32 vector must read this rather than the
 * coerced local, because the coercion is precisely what erases the evidence it
 * tests for.  mbaOpcodes binds it when the expression mentions it.
 */
export const RAW_PREFIX = "raw$";

/** A fresh odd multiplier — odd so a non-zero input cannot be zeroed out. */
const nullKey = () => (getRandomInt(1, 0x7fffffff) * 2 + 1) | 0;

/**
 * Every vector `domain` supports for the variable `name`, each tagged with
 * whether it fires on ordinary integers (see the section header).  Callers pick
 * from this rather than taking a random draw, so a firing vector is never
 * passed over in favour of filler.
 */
function nullVectorForms(
  name: string,
  domain: MBADomain,
): { firing: boolean; build: () => MBAExpr }[] {
  const forms: { firing: boolean; build: () => MBAExpr }[] = [];

  if (domain.modTag) {
    const { bits, tag } = domain.modTag;
    const mask = (1 << bits) - 1;
    // Zero exactly when x ≡ tag (mod 2^bits); non-zero for the 1 - 2^-bits of
    // integers that are not.
    forms.push({
      firing: true,
      build: () =>
        mImul(
          mXor(mAnd(mVar(name), mNum(mask)), mNum(tag & mask)),
          mNum(nullKey()),
        ),
    });
  }

  if (domain.bool) {
    // Zero exactly on {0, 1}: every other integer has a bit above bit 0 set.
    forms.push({
      firing: true,
      build: () => mImul(mAnd(mVar(name), mNum(~1)), mNum(nullKey())),
    });
    // Same domain by a different route — b*(b-1) is 0 for b in {0,1}.  The
    // 16-bit mask keeps the product inside float64's exact range, exactly as
    // MUL_IDENTITY_RULES does.
    forms.push({
      firing: true,
      build: () => {
        const b = pinnedMask16(mVar(name));
        return mImul(mMul(b, mSub(b, mNum(1))), mNum(nullKey()));
      },
    });
  }

  if (domain.mask) {
    // `x ^ (x >> 31)` folds a value onto its own sign: 0 becomes 0 and -1
    // becomes 0, while every other int32 keeps at least one bit.  That is
    // exactly the {0, -1} domain of a branchless select mask.
    forms.push({
      firing: true,
      build: () =>
        mImul(
          mXor(mVar(name), pinned(mShr(mVar(name), mNum(31)))),
          mNum(nullKey()),
        ),
    });
  }

  if (domain.int32) {
    // `x - (x | 0)` is the fractional part: 0 for every int32, non-zero for any
    // other finite number.  Scaling before imul is what keeps a small fraction
    // from being truncated away to nothing.
    //
    // WEAK: it is zero on every integer, so a classifier that decides its fit
    // on integer probes never sees it.  Kept because it costs nothing and does
    // reach a simplifier that samples the full value space.
    //
    // The subtraction is PINNED.  Several SUB_RULES route through `~`, which
    // applies ToInt32 to its operand and so discards the fraction — the rewrite
    // would still be correct (the term stays 0 on the domain) but the vector
    // would collapse to a constant zero and buy nothing at all.
    const raw = mVar(RAW_PREFIX + name);
    forms.push({
      firing: false,
      build: () =>
        mImul(
          mMul(pinned(mSub(raw, mOr(raw, mNum(0)))), mNum(0x10000)),
          mNum(nullKey()),
        ),
    });
  }

  return forms;
}

/**
 * An expression that is 0 for every value in `domain` and generically non-zero
 * outside it.  Returns null when the domain says nothing usable.
 */
export function mbaNullVector(
  name: string,
  domain: MBADomain,
): MBAExpr | null {
  const forms = nullVectorForms(name, domain);
  if (forms.length === 0) return null;
  const firing = forms.filter((f) => f.firing);
  return choice(firing.length > 0 ? firing : forms).build();
}

// Ways to fold a null vector into an expression without changing its value on
// the domain.  Each is an identity when `z` is 0 and `x` is an int32.
//
// Every rule here must also DIFFER from `x` for some z ≠ 0, or it is not a
// domain-restricted term at all — it is a plain identity wearing one's clothes,
// and it costs an attacker nothing.  `(x + z) - (z & z)` used to sit in this
// list and is exactly that: `z & z` is `z`, so it is `x` for every z.
const DOMAIN_IDENTITY_RULES: ((x: MBAExpr, z: MBAExpr) => MBAExpr)[] = [
  (x, z) => mAdd(x, z),
  (x, z) => mSub(x, z),
  (x, z) => mXor(x, z),
  (x, z) => mOr(x, mAnd(z, mNum(getRandomInt(0, U32_MAX) | 0))),
  (x, z) => mAdd(x, mImul(z, mNum(getRandomInt(0, U32_MAX) | 0))),
];

/**
 * The variable `name`, with a null vector over its own domain folded in.
 *
 * Where poisonMBA folds a vector at the ROOT of a finished expression, this
 * puts one on an OPERAND, before the expression is built around it.  That
 * difference decides whether the term is observable:
 *
 *   • A comparison cannot be poisoned at the root at all.  Folding an
 *     arithmetic term around `x === y` and re-coercing gives `!!(true + z)`,
 *     which is `true` for every z but -1 — so the handler still answers exactly
 *     like `===` on the probes a classifier draws, and the vector is wasted.
 *     Poisoning the operand instead makes the comparison itself disagree.
 *   • For anything else it is simply deeper: a root term sits outside every
 *     truncation, where a substitute-simplify-reinsert loop can lift it back
 *     out, while an operand term is entangled with everything downstream.
 *
 * FIRING forms only.  A weak vector placed here is pure size: it cannot change
 * an answer on any integer probe, and the engine already scatters weak vectors
 * through the leaves with a probability.  A leaf with nothing firing to offer
 * is left exactly as it was.
 *
 * Only the two rules that provably move the value are used — a vector folded
 * with `|` or `&` can leave `x` unchanged even when it fires. On the domain
 * both are exactly `x`, since `z` is 0 there.
 */
export function poisonedLeaf(
  name: string,
  domain: MBADomain | undefined,
): MBAExpr {
  if (!domain) return mVar(name);
  const firing = nullVectorForms(name, domain).filter((f) => f.firing);
  if (firing.length === 0) return mVar(name);
  const z = choice(firing).build();
  return pinned(
    truncMBA(chance(50) ? mAdd(mVar(name), z) : mXor(mVar(name), z)),
  );
}

/**
 * Pick a null vector from across every variable that carries a domain.
 *
 * The pool is built from ALL variables first and only then filtered, rather
 * than picking a variable and taking whatever it offers.  The difference
 * matters: a handler whose operands are int32-only and whose mask operand is a
 * genuine {0,-1} would otherwise spend most of its draws on the int32 filler
 * and never place the one vector that reaches an integer probe.
 */
function drawNullVector(o: ResolvedOptions): MBAExpr | null {
  const pool: { firing: boolean; build: () => MBAExpr }[] = [];
  for (const name of Object.keys(o.domains))
    pool.push(...nullVectorForms(name, o.domains[name]));
  if (pool.length === 0) return null;
  const firing = pool.filter((f) => f.firing);
  return choice(firing.length > 0 ? firing : pool).build();
}

/**
 * Fold `name` into `e` through a cancelling identity, so the expression READS
 * the variable without depending on it.
 *
 * The expansion engine already does this at the leaves for anything in `noise`,
 * but only with a probability — and a taint operand is not optional: its
 * register is appended to the instruction whether or not the draw happened to
 * use it, and a handler that declares an operand it never reads consumes the
 * wrong number of words from the bytecode stream.  Callers use this to turn the
 * engine's likelihood into a guarantee.
 *
 * Exact for any int32 `e` and ANY value of `name` — the identity rules hold
 * over all of Z/2^32, which is what makes a taint operand safe to point at a
 * register whose contents the compiler knows nothing about.
 */
export function entangleMBA(e: MBAExpr, name: string): MBAExpr {
  return pinned(truncMBA(choice(IDENTITY_RULES)(e, mVar(name))));
}

/**
 * Fold domain-restricted null vectors into an already-built expression.
 *
 * Applied at the ROOT by the handler builders; the expansion engine applies the
 * same rules at the leaves, which is what stops the term from being a separable
 * summand a substitute-simplify-reinsert loop could lift back out.
 */
export function poisonMBA(e: MBAExpr, options?: MBAOptions): MBAExpr {
  const o = resolve(options);
  if (o.poisonChance <= 0) return e;
  let out = e;
  // Two draws: one term is a lone summand, two are a pair whose variables
  // differ, which is the shape the concept describes (`+ Z(a) - Z(b)`).
  const rounds = chance(50) ? 1 : 2;
  for (let i = 0; i < rounds; i++) {
    if (!chance(o.poisonChance)) continue;
    const z = drawNullVector(o);
    if (!z) break;
    out = choice(DOMAIN_IDENTITY_RULES)(out, z);
  }
  // Pinned: a poisoned subtree may still be composed into a larger expression
  // and expanded again (mbaSuperOps does exactly that), and an unpinned `| 0`
  // can be rewritten into a form that preserves the value only modulo 2^32 —
  // which is not a truncation at all.
  return out === e ? e : pinned(truncMBA(out));
}

// ── Key-selected semantics ───────────────────────────────────────────────────
//
// Every rule above this line is an IDENTITY: the expression it produces is
// equal to the operation it replaced, for every input.  That is exactly the
// property a black-box attacker exploits.  A deobfuscator does not have to
// simplify an MBA to defeat it — it can run the handler on sampled inputs and
// match the results against a table of candidate operators.  Depth, variable
// count and non-linearity are all irrelevant to that attack, because they do
// not change what the function COMPUTES.
//
// The way out (Loki, USENIX Sec '22) is to stop shipping a handler that equals
// any single operator.  One handler hosts TWO semantics and a per-site key
// picks which one runs:
//
//     f(a, b, k) = select(op0(a, b), op1(a, b), selector(k))
//
// Sampling f over (a, b) with k fixed now yields whichever operator that CALL
// SITE asked for, and the same handler yields a different one at the next site.
// There is no single operator to match the handler against, so a table-driven
// classifier gets no answer at all.
//
// Honest limits.  An attacker who fully simplifies the body still sees both
// candidate operators sitting in a select, and then has to recover the selector
// bit from `k` — a bounded amount of work, not a wall.  What this buys is that
// the cheap attack (sample the handler, read off the operator) stops working,
// and the expensive one has to model a third input.  Callers should also feed
// `s` and `k` into `noise`, which raises the arity any evaluation-based solver
// has to cover from two variables to four.

/**
 * Constants for one merged handler's selector derivation.  `mul` is odd so
 * `k -> imul(k ^ xor, mul)` is a bijection: exactly half of the 2^32 possible
 * key operands select each semantic, and both halves are dense, so a site can
 * always draw a fresh random key rather than reusing a recognisable literal.
 */
export interface SelectorKey {
  mul: number;
  xor: number;
  shift: number;
  /**
   * Every key operand this handler is ever given is congruent to `tag` modulo
   * 2^KEY_TAG_BITS.  Nothing in the selector derivation depends on that — it is
   * a DOMAIN the compiler establishes so the handler body can carry null
   * vectors over `k` that vanish for every real key and fire for a probe.
   * See "Domain-restricted identities".
   */
  tag: number;
}

/** Bits of the key operand reserved for the domain tag.  See SelectorKey. */
export const KEY_TAG_BITS = 3;

export function makeSelectorKey(): SelectorKey {
  return {
    // Odd multiplier — keeps the mixing step invertible.
    mul: (getRandomInt(1, 0x7fffffff) * 2 + 1) | 0,
    xor: getRandomInt(1, 0x7fffffff) | 0,
    // Any bit of the product will do; picking a random one stops the low bit of
    // `k` from being the answer.
    //
    // It may not be one of the bottom KEY_TAG_BITS, though.  Bit s of a product
    // depends only on bits 0..s of its operands, and the bottom KEY_TAG_BITS of
    // every key operand are pinned to `tag` — so a shift below that would make
    // the selector a CONSTANT, and findSelectorOperand could never satisfy the
    // other semantic.
    shift: getRandomInt(KEY_TAG_BITS, 31),
    tag: getRandomInt(0, (1 << KEY_TAG_BITS) - 1),
  };
}

/**
 * The selector bit carried by key operand `k`.  MUST stay in lockstep with
 * selectorSource() below — that is the whole contract between the bytecode pass
 * that chooses `k` and the handler that decodes it.
 */
export function applySelector(k: number, key: SelectorKey): 0 | 1 {
  return ((Math.imul(k ^ key.xor, key.mul) >>> key.shift) & 1) as 0 | 1;
}

/** JS source for applySelector(), for the generated handler body. */
export function selectorSource(kExpr: string, key: SelectorKey): string {
  return `((Math.imul(${kExpr} ^ ${key.xor}, ${key.mul}) >>> ${key.shift}) & 1)`;
}

/**
 * A key operand whose selector bit is `want` AND whose low bits carry the
 * handler's domain tag.  Drawn at random rather than derived, so no two sites
 * share a key even when they select the same semantic: one draw in
 * 2^(KEY_TAG_BITS+1) qualifies, which still leaves ~2^28 keys per semantic.
 */
export function findSelectorOperand(key: SelectorKey, want: 0 | 1): number {
  const mask = (1 << KEY_TAG_BITS) - 1;
  for (;;) {
    // `>>> 0` because `&` and `|` yield a SIGNED int32, and a negative operand
    // fails serialization (bytecode slots are u32).
    const k = (((getRandomInt(0, U32_MAX) & ~mask) | key.tag) >>> 0);
    if (applySelector(k, key) === want) return k;
  }
}

/**
 * Branchless two-way select: yields `buildZero()` when `sel` is even and
 * `buildOne()` when it is odd.
 *
 * The two branches are passed as THUNKS, not expressions: the first form below
 * needs two independent expansions of the same semantic, and re-drawing gives
 * two structurally different subtrees that happen to be equal — which is a lot
 * less legible than the same subtree written twice.
 *
 * Both branches must already be fully expanded and int32-truncated (i.e. they
 * come from the high-level builders above).  The skeleton assembled here is
 * deliberately NOT run through expandMBA: doing so could rewrite a `~~` or
 * `| 0` produced by truncMBA into a form that preserves the value but drops the
 * truncation, which is the same trap ltExpr documents.
 */
export function mbaSelectExpr(
  buildZero: () => MBAExpr,
  buildOne: () => MBAExpr,
  sel: MBAExpr,
): MBAExpr {
  // `sel & 1` is pinned: the magnitude argument below depends on this factor
  // being 0 or 1, and a value-preserving rewrite of `& 1` would not keep it.
  const s: MBAExpr = { k: "bin", op: "&", l: sel, r: mNum(1), fixed: true };

  // Both forms are exact for s in {0, 1}, and both stay far inside float64's
  // exact-integer range: every branch is int32-truncated (<= 2^31) and the only
  // multiplications are by 0 or 1.
  if (chance(50)) {
    // z + s*(o - z'), with z and z' independent expansions of the same value.
    return truncMBA(
      mAdd(buildZero(), mMul(s, mSub(buildOne(), buildZero()))),
    );
  }
  // s*o + (s^1)*z — the classic branchless select, and a different shape.
  return truncMBA(
    mAdd(mMul(s, buildOne()), mMul(mXor(s, mNum(1)), buildZero())),
  );
}

// ── Expansion engine ─────────────────────────────────────────────────────────

export interface MBAOptions {
  /** Maximum rewrite levels.  Clamped to MAX_DEPTH (see magnitude note above). */
  depth?: number;
  /** % chance an eligible operator node is rewritten. */
  rewriteChance?: number;
  /** % chance a leaf is identity-expanded. */
  identityChance?: number;
  /**
   * How many times a single path may be identity-expanded at the leaves.
   * Budgeted separately from `depth` — see rewrite() for why sharing starves
   * leaf expansion, which is the only place noise variables enter.
   */
  leafDepth?: number;
  /**
   * Name of a variable holding an ODD value derived from live per-frame state.
   * Paired with `invVar`, the baked modular inverse of the value that frame is
   * expected to hold. Unlike `noise`, these appear in positions that are wrong
   * for any other frame, so they cannot be cancelled by inspection.
   * See FRAME_BOUND_RULES. Both must be supplied together.
   */
  frameVar?: string;
  /** Name of the variable holding `modInverse32(frameVar)`. */
  invVar?: string;
  /** % of leaf expansions that use the frame binding (when one is supplied). */
  frameChance?: number;
  /**
   * % of leaf expansions that use a MULTIPLICATIVE identity rather than a
   * purely bitwise one.  Multiplying by a variable leaves the linear MBA class,
   * so this is the knob that decides how much of the output is beyond what
   * bit-position evaluation can resolve.
   */
  mulChance?: number;
  /**
   * Variable names that may be used as MBA noise operands.  They must be in
   * scope at the use site and must hold int32 values.  Entangling real
   * registers is what gives the expansion its teeth — with no noise the result
   * is a plain single-variable MBA.
   */
  noise?: string[];
  /**
   * What is known to be true of each variable in every REAL execution, keyed by
   * variable name.  Supplying one lets the engine add terms that vanish on that
   * domain and nowhere else, which breaks the total-equivalence rule every
   * sampling simplifier relies on.  See "Domain-restricted identities".
   *
   * Handler-only: the vectors are built from Math.imul, which has no opcode.
   * Only ever describe a domain the COMPILER establishes; a domain an analysis
   * merely inferred turns an analysis bug into a wrong answer.
   */
  domains?: Record<string, MBADomain>;
  /** % chance a leaf expansion / root fold uses a domain null vector. */
  poisonChance?: number;
  /** Always rewrite the root node (used for constant hiding). */
  forceRoot?: boolean;
}

type ResolvedOptions = Required<MBAOptions>;

// See the magnitude-safety note in the file header: these bounds are what keep
// every intermediate inside float64's exact-integer range.
//
// leafDepth is clamped harder than depth because it is the dominant term in
// expression SIZE — identity and multiplicative rules both duplicate their
// subject, so each leaf level multiplies the tree by roughly 10-15x, against
// ~2x for an operator level. Measured on `a + b` with every knob maxed:
// leafDepth 1 -> ~3KB, 2 -> ~55KB, 3 -> ~460KB. Two is generous headroom over
// the default of 1; three is a foot-gun.
const MAX_DEPTH = 6;
const MAX_LEAF_DEPTH = 2;

const DEFAULTS: ResolvedOptions = {
  depth: 3,
  rewriteChance: 85,
  identityChance: 40,
  mulChance: 40,
  leafDepth: 1,
  noise: [],
  domains: {},
  poisonChance: 0,
  frameVar: "",
  invVar: "",
  frameChance: 50,
  forceRoot: false,
};

function resolve(options: MBAOptions | undefined): ResolvedOptions {
  const o = { ...DEFAULTS, ...(options ?? {}) };
  o.depth = Math.max(0, Math.min(MAX_DEPTH, o.depth));
  o.leafDepth = Math.max(0, Math.min(MAX_LEAF_DEPTH, o.leafDepth));
  // Spreading an explicit `undefined` overrides the default rather than falling
  // back to it, so a caller passing `frameVar: cond ? name : undefined` would
  // otherwise leave this set-but-nameless and emit a reference to `undefined`.
  o.frameVar = o.frameVar || "";
  o.invVar = o.invVar || "";
  o.noise = o.noise ?? [];
  o.domains = o.domains ?? {};
  o.poisonChance = o.poisonChance ?? 0;
  // The frame binding needs BOTH halves; half of it is meaningless.
  if (!o.frameVar || !o.invVar) {
    o.frameVar = "";
    o.invVar = "";
  }
  return o;
}

function mapChildren(e: MBAExpr, f: (c: MBAExpr) => MBAExpr): MBAExpr {
  if (e.k === "bin")
    return { k: "bin", op: e.op, l: f(e.l), r: f(e.r), fixed: e.fixed };
  if (e.k === "un") return { k: "un", op: e.op, v: f(e.v), fixed: e.fixed };
  return e;
}

/** `e | 0`, pinned so no rewrite can drop the truncation. */
function pinnedTrunc(e: MBAExpr): MBAExpr {
  return { k: "bin", op: "|", l: e, r: mNum(0), fixed: true };
}

/** `e & 0xffff`, pinned so no rewrite can drop the 16-bit magnitude bound. */
function pinnedMask16(e: MBAExpr): MBAExpr {
  return { k: "bin", op: "&", l: e, r: mNum(0xffff), fixed: true };
}

// `d` is the OPERATOR budget and `leafD` the LEAF budget; they are separate on
// purpose.  Leaf identity expansion is where the foreign noise variable and the
// multiplicative rules enter the tree — the two things that take the result out
// of the small, recognisable two-variable family.  But leaves sit at the very
// bottom, so on a shared budget they are always the first thing starved: at
// depth 2 the root rewrite spends one level and its children the other, and
// recursion returns before a leaf is ever reached.  Splitting the budgets is
// what makes `noise` actually reach the output.
//
// Both budgets only ever decrease, and every rewrite consumes one, so the tree
// stays finite.
function rewrite(
  e: MBAExpr,
  d: number,
  o: ResolvedOptions,
  root = false,
  leafD = o.leafDepth,
): MBAExpr {
  const forced = root && o.forceRoot;

  if (e.k === "num" || e.k === "var") {
    // Expanding a leaf against a CONSTANT leaves a constant-only expression,
    // which any lifter folds straight back to the literal.  Only a variable
    // operand actually hides it, so leaves demand one — the frame binding
    // counts, since those are variables too.
    const hasFrame = o.frameVar !== "";
    const hasDomain =
      o.poisonChance > 0 && Object.keys(o.domains).length > 0;
    if ((o.noise.length === 0 && !hasFrame && !hasDomain) || leafD <= 0)
      return e;
    if (!forced && !chance(o.identityChance)) return e;

    // A domain-restricted fold beats both of the others.  An identity rule
    // cancels by inspection for whatever value its operand holds; a frame-bound
    // rule at least has to be evaluated, but it IS still an identity in the
    // right frame.  This one is not an identity at all outside D, so a
    // simplifier sampling the full space measures a different function and
    // refuses every rewrite it would otherwise make.
    //
    // The vector itself is folded in un-rewritten: the leaf under it is
    // expanded as usual, but rewriting the vector's own children would only
    // spend budget weakening what it detects (an identity rule applies ToInt32
    // to its subject, which is exactly the evidence the int32 vector reads).
    if (hasDomain && chance(o.poisonChance)) {
      const z = drawNullVector(o);
      if (z)
        return choice(DOMAIN_IDENTITY_RULES)(
          rewrite(e, d, o, false, leafD - 1),
          z,
        );
    }

    if (o.noise.length === 0 && !hasFrame) return e;

    // A frame-bound rule is worth more than a plain identity: it cannot be
    // cancelled by inspection, only evaluated, and only in the right frame.
    const useFrame = hasFrame && (o.noise.length === 0 || chance(o.frameChance));
    const expanded = useFrame
      ? choice(FRAME_BOUND_RULES)(e, mVar(o.frameVar), mVar(o.invVar))
      : (chance(o.mulChance)
          ? choice(MUL_IDENTITY_RULES)
          : choice(IDENTITY_RULES))(e, mVar(choice(o.noise)));

    return mapChildren(expanded, (c) => rewrite(c, d, o, false, leafD - 1));
  }

  const rules: (BinRule | UnRule)[] | undefined =
    e.k === "bin" ? BIN_RULES[e.op] : UN_RULES[e.op];

  // A pinned node keeps its own shape — it encodes a truncation or a magnitude
  // bound that a value-preserving rewrite could still destroy.
  const mayRewrite = !e.fixed && d > 0 && !!rules && rules.length > 0;

  if (mayRewrite && (forced || chance(o.rewriteChance))) {
    const expanded =
      e.k === "bin"
        ? (choice(rules!) as BinRule)(e.l, e.r)
        : (choice(rules!) as UnRule)(e.v);
    // Recurse into the children of the REPLACEMENT (not the replacement
    // itself), so each level of `depth` applies at most one rule per node and
    // the tree stays bounded.
    return mapChildren(expanded, (c) => rewrite(c, d - 1, o, false, leafD));
  }

  // Keep DESCENDING even with the operator budget spent, so leaves further down
  // still get their turn.  Nothing is rewritten on the way, so this cannot grow
  // the tree.
  return mapChildren(e, (c) => rewrite(c, d - 1, o, false, leafD));
}

/** Rewrite `e` into a randomly chosen equivalent MBA expression. */
export function expandMBA(e: MBAExpr, options?: MBAOptions): MBAExpr {
  const o = resolve(options);
  return rewrite(e, o.depth, o, true);
}

/**
 * Truncate to int32.  Required on any value that is about to be compared or
 * stored — see the correctness contract in the file header.
 */
export function truncMBA(e: MBAExpr): MBAExpr {
  switch (getRandomInt(0, 2)) {
    case 0:
      return mOr(e, mNum(0));
    case 1:
      return mXor(e, mNum(0));
    default:
      return mBNot(mBNot(e));
  }
}

// ── High-level builders ──────────────────────────────────────────────────────
// Each returns a fully expanded, int32-truncated expression.

/** `l + r` */
export function mbaAddExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  return truncMBA(expandMBA(mAdd(l, r), o));
}

/** `l - r` */
export function mbaSubExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  return truncMBA(expandMBA(mSub(l, r), o));
}

/** `value`, hidden behind an identity expansion over a live noise register. */
export function mbaConstExpr(value: number, o?: MBAOptions): MBAExpr {
  return truncMBA(expandMBA(mNum(value), { ...(o ?? {}), forceRoot: true }));
}

/**
 * An opaque zero built over `seed` — always 0, but not foldable, because
 * `seed` is a runtime value.
 */
export function mbaZeroExpr(seed: MBAExpr, o?: MBAOptions): MBAExpr {
  const opts = resolve(o);
  // Half the time use a two-operand bit identity (entangles a second register),
  // half the time a carry invariant (escapes bit-position evaluation).
  if (chance(50)) {
    const noise =
      opts.noise.length > 0
        ? mVar(choice(opts.noise))
        : mNum(getRandomInt(1, U16_MAX));
    return truncMBA(expandMBA(choice(ZERO_RULES)(seed, noise), o));
  }
  return truncMBA(expandMBA(choice(ARITHMETIC_ZERO_RULES)(seed), o));
}

/** Coerce to a real boolean — `!!e`. */
export function asBoolean(e: MBAExpr): MBAExpr {
  return mLNot(mLNot(e));
}

/**
 * An opaque predicate: always `true`, but its value is not statically
 * derivable because it is computed from the runtime value of `seed`.
 *
 * Note this is a different contract from mbaConstExpr — a predicate must be
 * invariant for EVERY possible input, not merely correct for one.
 */
export function mbaOpaqueTrue(seed: MBAExpr, o?: MBAOptions): MBAExpr {
  return mLNot(mbaZeroExpr(seed, o));
}

/** An opaque predicate that is always `false`. */
export function mbaOpaqueFalse(seed: MBAExpr, o?: MBAOptions): MBAExpr {
  return asBoolean(mbaZeroExpr(seed, o));
}

// A zero test over an int32 `t`.  `>>> 31` and the logical `!` sit outside the
// linear-MBA algebra, so an evaluation-based simplifier cannot fold the
// predicate back into a comparison even after simplifying `t` itself.
function zeroTest(t: MBAExpr, wantZero: boolean): MBAExpr {
  // `t | -t` has its sign bit set for every t !== 0, and is 0 only for t === 0.
  const signOfNonZero = () => mUshr(mOr(t, mNeg(t)), mNum(31)); // 1 iff t !== 0
  const forms: (() => MBAExpr)[] = wantZero
    ? [
        () => mLNot(t),
        () => mLNot(mOr(t, mNeg(t))),
        () => mLNot(signOfNonZero()),
        () => mXor(signOfNonZero(), mNum(1)),
      ]
    : [
        () => t,
        () => mOr(t, mNeg(t)),
        () => signOfNonZero(),
        () => mLNot(mLNot(t)),
      ];
  return choice(forms)();
}

/** Truthy iff `l === r` (both must be int32). */
export function mbaEqExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  const diff = truncMBA(expandMBA(chance(50) ? mXor(l, r) : mSub(l, r), o));
  return zeroTest(diff, true);
}

/** Truthy iff `l !== r` (both must be int32). */
export function mbaNeExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  const diff = truncMBA(expandMBA(chance(50) ? mXor(l, r) : mSub(l, r), o));
  return zeroTest(diff, false);
}

// ── Relational comparison ────────────────────────────────────────────────────
//
// Signed `<` cannot be done by testing the sign of `x - y`: the difference of
// two int32s ranges over ±2^32 and truncating it back to int32 flips the sign
// exactly when the subtraction overflows.  The standard branchless form
// corrects for that — `x < y` is the sign bit of
//
//     (x & ~y) | (~(x ^ y) & ((x - y) mod 2^32))
//
// The first term decides it when the operands differ in sign; the second is
// consulted only when they agree, and then the subtraction cannot overflow.
//
// The three sub-terms are each expanded and truncated INDEPENDENTLY, and the
// skeleton that combines them is left alone.  Expanding the skeleton would let
// a rewrite reach the `| 0` that pins the difference to mod 2^32 — and some
// `|` identities (`(x + y) - (x & y)`) do not truncate, so the correction term
// would silently stop being exact.
function ltExpr(x: MBAExpr, y: MBAExpr, o?: MBAOptions): MBAExpr {
  const diffSign = truncMBA(expandMBA(mAnd(x, mBNot(y)), o));
  const sameSign = truncMBA(expandMBA(mBNot(mXor(x, y)), o));
  const diff = truncMBA(expandMBA(mSub(x, y), o));
  return mUshr(mOr(diffSign, mAnd(sameSign, diff)), mNum(31));
}

/** `l < r` as a real boolean (both must be int32). */
export function mbaLtExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  return asBoolean(ltExpr(l, r, o));
}

/** `l > r` — i.e. `r < l`. */
export function mbaGtExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  return asBoolean(ltExpr(r, l, o));
}

/** `l <= r` — i.e. `!(r < l)`. */
export function mbaLteExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  return mLNot(ltExpr(r, l, o));
}

/** `l >= r` — i.e. `!(l < r)`. */
export function mbaGteExpr(l: MBAExpr, r: MBAExpr, o?: MBAOptions): MBAExpr {
  return mLNot(ltExpr(l, r, o));
}

/** Unary negation, `-v`. */
export function mbaNegExpr(v: MBAExpr, o?: MBAOptions): MBAExpr {
  return truncMBA(expandMBA(mNeg(v), o));
}

/** Bitwise complement, `~v`. */
export function mbaBNotExpr(v: MBAExpr, o?: MBAOptions): MBAExpr {
  return truncMBA(expandMBA(mBNot(v), o));
}

/** A binary bitwise/arithmetic op, dispatched by operator. */
export function mbaBinExpr(
  op: MBABinOp,
  l: MBAExpr,
  r: MBAExpr,
  o?: MBAOptions,
): MBAExpr {
  return truncMBA(expandMBA(bin(op, l, r), o));
}

// ── Backend 1: JS source ─────────────────────────────────────────────────────

/**
 * Print as a JS expression.  Fully parenthesised — the output is fed to the
 * compiler (via Template), never read by a human, so precedence bugs are a far
 * bigger risk than verbosity.
 */
export function printMBA(e: MBAExpr): string {
  switch (e.k) {
    case "var":
      return e.name;
    case "num":
      return e.value < 0 ? `(${e.value})` : String(e.value);
    case "bin":
      return e.op === "imul"
        ? `Math.imul(${printMBA(e.l)}, ${printMBA(e.r)})`
        : `(${printMBA(e.l)} ${e.op} ${printMBA(e.r)})`;
    case "un":
      switch (e.op) {
        case "~":
          return `(~${printMBA(e.v)})`;
        case "neg":
          return `(-${printMBA(e.v)})`;
        default:
          return `(!${printMBA(e.v)})`;
      }
  }
}

// ── Backend 2: Babel AST ─────────────────────────────────────────────────────

/**
 * Build a Babel expression.  `resolve` turns an MBA variable name into whatever
 * expression holds it at the use site — a plain identifier for a generated
 * opcode handler, but it can be any expression.
 *
 * Used by the runtime pass that synthesises MBA_* handler bodies; the bytecode
 * emitter below is the equivalent for passes that build instructions instead.
 */
export function mbaToAST(
  e: MBAExpr,
  resolve: (name: string) => t.Expression,
): t.Expression {
  switch (e.k) {
    case "var":
      return resolve(e.name);
    case "num":
      return e.value < 0
        ? t.unaryExpression("-", t.numericLiteral(-e.value))
        : t.numericLiteral(e.value);
    case "bin":
      return e.op === "imul"
        ? t.callExpression(
            t.memberExpression(t.identifier("Math"), t.identifier("imul")),
            [mbaToAST(e.l, resolve), mbaToAST(e.r, resolve)],
          )
        : t.binaryExpression(
            e.op as t.BinaryExpression["operator"],
            mbaToAST(e.l, resolve),
            mbaToAST(e.r, resolve),
          );
    case "un":
      return t.unaryExpression(
        e.op === "~" ? "~" : e.op === "neg" ? "-" : "!",
        mbaToAST(e.v, resolve),
        true,
      );
  }
}

// ── Backend 2b: direct evaluation ────────────────────────────────────────────

/**
 * Evaluate `e` against a variable environment, using exactly the semantics the
 * emitted JavaScript has.
 *
 * This exists for the build-time fit check (utils/mba-fit-check.ts), which has
 * to answer the same question an attacker's black-box classifier asks — "what
 * does this handler compute on these inputs?" — without generating, parsing and
 * running the handler.  Keeping it here rather than in the checker keeps it
 * next to the printer and the AST backend it has to agree with.
 *
 * An unbound variable is a build bug (mbaOpcodes would emit a bare identifier
 * and fail at runtime), so it throws rather than defaulting.
 */
export function evalMBA(e: MBAExpr, env: Map<string, unknown>): any {
  switch (e.k) {
    case "num":
      return e.value;
    case "var": {
      if (!env.has(e.name))
        throw new Error(`evalMBA: unbound variable "${e.name}"`);
      return env.get(e.name);
    }
    case "un": {
      const v = evalMBA(e.v, env);
      if (e.op === "~") return ~v;
      if (e.op === "neg") return -v;
      return !v;
    }
    case "bin": {
      const l = evalMBA(e.l, env);
      const r = evalMBA(e.r, env);
      switch (e.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "^":
          return l ^ r;
        case "&":
          return l & r;
        case "|":
          return l | r;
        case "<<":
          return l << r;
        case ">>":
          return l >> r;
        case ">>>":
          return l >>> r;
        default:
          return Math.imul(l, r);
      }
    }
  }
}

/** Total nodes in `e` — a size proxy for callers that want to reject a draw. */
export function mbaNodeCount(e: MBAExpr): number {
  if (e.k === "bin") return 1 + mbaNodeCount(e.l) + mbaNodeCount(e.r);
  if (e.k === "un") return 1 + mbaNodeCount(e.v);
  return 1;
}

/** Every distinct variable name referenced by `e`, in first-seen order. */
export function mbaVarNames(e: MBAExpr): string[] {
  const seen: string[] = [];
  const walk = (n: MBAExpr) => {
    if (n.k === "var") {
      if (!seen.includes(n.name)) seen.push(n.name);
    } else if (n.k === "bin") {
      walk(n.l);
      walk(n.r);
    } else if (n.k === "un") {
      walk(n.v);
    }
  };
  walk(e);
  return seen;
}

// ── Backend 3: bytecode ──────────────────────────────────────────────────────

// `imul` is absent on purpose: the VM has no IMUL opcode, so an expression
// containing one cannot be lowered to bytecode. It only ever appears in
// frame-bound rules, which are handler-only; walk() rejects it explicitly
// rather than emitting a broken instruction.
const BIN_OPCODE: Partial<Record<MBABinOp, string>> = {
  "+": "ADD",
  "-": "SUB",
  "*": "MUL",
  "^": "BXOR",
  "&": "BAND",
  "|": "BOR",
  "<<": "SHL",
  ">>": "SHR",
  ">>>": "USHR",
};

const UN_OPCODE: Record<MBAUnOp, string> = {
  "~": "UNARY_BITNOT",
  neg: "UNARY_NEG",
  not: "UNARY_NOT",
};

export interface MBAEmitContext {
  compiler: Compiler;
  fnId: number;
  maxId: Map<number, number>;
  /**
   * Depth-indexed scratch registers, grown on demand and reused across every
   * emitMBA() call that shares this context.  emitMBA evaluates like a stack
   * machine — a node at depth d writes scratch[d] and its right subtree only
   * ever touches scratch[d+1..] — so one register per tree LEVEL is enough no
   * matter how many expressions are emitted.
   */
  scratch: RegisterOperand[];
  /** Mark allocated scratch registers `pinned` (no slot reuse). */
  pinned: boolean;
}

export function createMBAEmitContext(
  compiler: Compiler,
  fnId: number,
  maxId: Map<number, number>,
  pinned = false,
): MBAEmitContext {
  return { compiler, fnId, maxId, scratch: [], pinned };
}

// Operand objects must be unique (other passes mutate them in place), but
// resolveRegisters derives a register's pool key from each operand INSTANCE —
// so a copy has to carry `kind` / `scopeId` / `pinned` too, or the same virtual
// register would be split across two pools.  ref() deliberately drops those, so
// this spreads instead.
function mref(r: RegisterOperand, pinned: boolean): RegisterOperand {
  const o: RegisterOperand = { ...r };
  if (pinned) o.pinned = true;
  return o;
}

function scratchAt(ctx: MBAEmitContext, depth: number): RegisterOperand {
  while (ctx.scratch.length <= depth) {
    const r = allocReg(ctx.fnId, ctx.maxId);
    if (ctx.pinned) r.pinned = true;
    ctx.scratch.push(r);
  }
  return ctx.scratch[depth];
}

/**
 * Lower `e` to instructions appended to `out`, and return the register holding
 * the result.
 *
 * `env` maps MBAExpr variable names to the registers that hold them.  The
 * returned register is scratch and is CLOBBERED by the next emitMBA() call on
 * the same context — consume it immediately (typically with a MOVE).
 */
export function emitMBA(
  out: Bytecode,
  e: MBAExpr,
  env: Map<string, RegisterOperand>,
  ctx: MBAEmitContext,
): RegisterOperand {
  const OP = ctx.compiler.OP as Record<string, number>;
  const P = ctx.pinned;

  const walk = (node: MBAExpr, depth: number): RegisterOperand => {
    switch (node.k) {
      case "var": {
        const r = env.get(node.name);
        if (!r) throw new Error(`emitMBA: unbound MBA variable "${node.name}"`);
        return r;
      }

      case "num": {
        const dst = scratchAt(ctx, depth);
        // LOAD_INT operands are serialized as unsigned slots, so a negative
        // literal has to be built rather than loaded.
        out.push([OP.LOAD_INT, mref(dst, P), Math.abs(node.value)]);
        if (node.value < 0)
          out.push([OP.UNARY_NEG, mref(dst, P), mref(dst, P)]);
        return dst;
      }

      case "un": {
        const a = walk(node.v, depth);
        const dst = scratchAt(ctx, depth);
        // dst may alias `a`; every unary handler reads its source before
        // writing its destination, so in-place is safe.
        out.push([OP[UN_OPCODE[node.op]], mref(dst, P), mref(a, P)]);
        return dst;
      }

      case "bin": {
        const opName = BIN_OPCODE[node.op];
        if (!opName)
          throw new Error(
            `emitMBA: "${node.op}" has no VM opcode — frame-bound rules are ` +
              `handler-only and must not reach the bytecode backend`,
          );
        // Left lands in scratch[depth]; the right subtree is confined to
        // scratch[depth+1..] so it cannot clobber it.
        const a = walk(node.l, depth);
        const b = walk(node.r, depth + 1);
        const dst = scratchAt(ctx, depth);
        // dst may alias `a`; binary handlers latch the first source into a
        // local before writing the destination, so in-place is safe.
        out.push([OP[opName], mref(dst, P), mref(a, P), mref(b, P)]);
        return dst;
      }
    }
  };

  return walk(e, 0);
}
