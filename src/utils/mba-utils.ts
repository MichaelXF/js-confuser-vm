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
import { U16_MAX } from "./op-utils.ts";

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
// The caller supplies `v` derived from a per-frame quantity (the executing
// frame's register count) and `c` baked from the value that frame is EXPECTED
// to have. Consequences:
//
//   • Neither literal resembles the register count. `c` for 631 is 74872647.
//     There is no small number sitting next to it to read the answer off.
//   • Run the same handler in a frame with a different register count and `v`
//     changes, `imul(v, c)` is no longer 1, and the result is garbage. The
//     handler is bound to its frame.
//   • That also breaks lifting the handler out and probing it with fabricated
//     state, since fabricated state has the wrong register count.
//
// This is obscurity against READING, not against a solver: `c` inverts back to
// `v` with the same Newton iteration used to build it, and a register count has
// a tiny domain. It raises the cost of understanding a handler, not of
// mechanically solving one.
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
    if ((o.noise.length === 0 && !hasFrame) || leafD <= 0) return e;
    if (!forced && !chance(o.identityChance)) return e;

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
