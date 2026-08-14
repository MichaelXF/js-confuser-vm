// Encoded-domain arithmetic (Chow-style internal encoding)
// ───────────────────────────────────────────────────────────────────────────
// An ENCODING is a per-function bijection E on int32.  A value stored under it
// never appears in its own form: the register holds E(v), and any operation on
// it is rewritten as E(f(E^-1(x))) — decode, compute, re-encode — fused into a
// single straight-line expression at build time and then MBA-expanded, so no
// step of the three is separable in the output.
//
// ── Why this is affordable HERE and not in general ───────────────────────────
// The literature applies this to a whole register file, and pays for it at
// every boundary where an encoded value meets native code: each one needs a
// decode, and each decode is a place the encoding leaks.
//
// This VM has a domain with NO such boundary — the controlFlowFlattening state
// register.  Nothing outside the dispatch loop reads it, no user value flows
// into it, and it never escapes to the host.  It is also entirely
// compiler-chosen, so its int32-ness is a fact rather than an analysis result.
// The encoding is therefore closed: E^-1 exists only inside generated handlers
// and never at a value-exit point.
//
// The VM's actual registers are NOT candidates — they hold arbitrary JS values
// (objects, strings, doubles, undefined), and E is only defined on int32.
//
// ── Equality survives, which is what makes it cheap ──────────────────────────
// E is a bijection, so E(a) === E(b) exactly when a === b.  The dispatch chain
// — the one part of the state machine that is walked once per ARM per
// transition — therefore compares encoded values directly and never decodes at
// all.  Only a state TRANSITION decodes, and that happens once per edge.  The
// cost lands on the rare path by construction.
//
// ── Round structure ──────────────────────────────────────────────────────────
// Every round is a bijection with a closed-form inverse, so E^-1 is derived
// rather than searched:
//
//   mul   imul(x, k), k odd        <->  imul(x, modInverse32(k))
//   add   x + c                    <->  x - c
//   xor   x ^ c                    <->  itself
//   rot   rotl(x, r)               <->  rotl(x, 32 - r)
//   xsr   x ^ (x >>> s)            <->  x ^= x>>>s, x>>>2s, x>>>4s, ...
//   xsl   x ^ (x << s)             <->  same, shifting the other way
//   pp3   degree-3 permutation polynomial  <->  its compositional inverse
//
// The first six are each linear over some structure (mod 2^32 or GF(2)^32).
// `pp3` is the one that is not, and it is why poly-utils exists.  The rotates
// and xorshifts are what stop the COMPOSITE from being a polynomial at all, so
// interpolating it — the standard attack on a pure PP encoding — has nothing to
// interpolate.
//
// ── Pinning ──────────────────────────────────────────────────────────────────
// Several nodes here carry a guarantee in their SHAPE that a value-preserving
// rewrite would destroy, and are marked `fixed` for the same reason
// mba-utils pins its truncations:
//
//   • The `|` joining a rotate's two halves.  Its right operand is UNSIGNED
//     (`>>>` yields a u32), and `a | b` is the only form that applies ToInt32
//     to it.  OR_RULES' `(a + b) - (a & b)` reproduces the value 2^32 too high.
//   • The `^` of a xorshift, for the same reason.
//   • The `| 0` that closes each round, which bounds magnitude for the next.
//
// Children of pinned nodes are still expanded — that is deliberate, and it is
// where the shift amounts and coefficients stop being literals.

import {
  mAdd,
  mImul,
  mNum,
  mOr,
  mShl,
  mSub,
  mUshr,
  mVar,
  mXor,
  modInverse32,
  pinned,
  type MBAExpr,
} from "./mba-utils.ts";
import { evalPoly, randomPP3, type Poly } from "./poly-utils.ts";
import { choice, getRandomInt } from "./random-utils.ts";

/**
 * One invertible step: an expression builder plus its build-time evaluator.
 *
 * `bitwise` marks the rounds that permute or mix BIT POSITIONS (rotate,
 * xorshift).  They are the ones that stop the composite being a polynomial
 * function — see createEncoding, which refuses to return an encoding without
 * at least one.
 */
interface Round {
  bitwise: boolean;
  forward: (x: MBAExpr) => MBAExpr;
  inverse: (x: MBAExpr) => MBAExpr;
  forwardValue: (x: number) => number;
  inverseValue: (x: number) => number;
}

/**
 * One round per binding, in evaluation order: each expression reads the
 * variable the previous one bound, and `result` names the last.
 */
export interface EncodingSteps {
  bindings: [string, MBAExpr][];
  result: MBAExpr;
}

export interface Encoding {
  /**
   * E(x) / E^-1(x) as a SEQUENCE of single-round bindings.
   *
   * This is the form callers should use, and the reason is size.  MBAExpr is a
   * tree with no sharing, so every reference to a subexpression is a full copy
   * of it — and several rounds reference their input more than once: a rotate
   * twice, a xorshift inverse three or four times, and the Horner evaluation of
   * an inverse polynomial once per degree.  Written as one expression those
   * multiply, and a five-round composite measured between 10^4 and 10^6 nodes
   * before any MBA expansion at all.  Binding each round to a temporary makes
   * the cost additive instead: every round then reads a variable LEAF, so its
   * expression is a few dozen nodes whatever the rounds around it do.
   */
  encodeSteps: (x: MBAExpr, name: (i: number) => string) => EncodingSteps;
  decodeSteps: (x: MBAExpr, name: (i: number) => string) => EncodingSteps;
  /** E(n) as an int32, at build time. */
  encodeValue: (n: number) => number;
  /** E^-1(n) as an int32, at build time. */
  decodeValue: (n: number) => number;
}

/** `e | 0`, pinned — bounds magnitude for whatever consumes it. */
const trunc = (e: MBAExpr): MBAExpr => pinned(mOr(e, mNum(0)));

// ── Round constructors ───────────────────────────────────────────────────────

function mulRound(): Round {
  const k = (getRandomInt(0, 0x7fffffff) * 2 + 1) | 0; // odd
  const kInv = modInverse32(k);
  return {
    bitwise: false,
    forward: (x) => mImul(x, mNum(k)),
    inverse: (x) => mImul(x, mNum(kInv)),
    forwardValue: (x) => Math.imul(x, k),
    inverseValue: (x) => Math.imul(x, kInv),
  };
}

function addRound(): Round {
  const c = getRandomInt(0, 0xffffffff) | 0;
  return {
    bitwise: false,
    forward: (x) => trunc(mAdd(x, mNum(c))),
    inverse: (x) => trunc(mSub(x, mNum(c))),
    forwardValue: (x) => (x + c) | 0,
    inverseValue: (x) => (x - c) | 0,
  };
}

function xorRound(): Round {
  const c = getRandomInt(0, 0xffffffff) | 0;
  return {
    bitwise: false,
    forward: (x) => mXor(x, mNum(c)),
    inverse: (x) => mXor(x, mNum(c)),
    forwardValue: (x) => x ^ c,
    inverseValue: (x) => x ^ c,
  };
}

// rotl(x, r) === (x << r) | (x >>> (32 - r)).  r is kept in 1..31: at r === 0
// the right half becomes `x >>> 32`, which JavaScript evaluates as `x >>> 0`
// (shift counts are taken mod 32) and the round would not be a rotation.
function rotRound(): Round {
  const r = getRandomInt(1, 31);
  const rot = (x: number, by: number) =>
    ((x << by) | (x >>> (32 - by))) | 0;
  const build = (by: number) => (x: MBAExpr) =>
    pinned(mOr(mShl(x, mNum(by)), mUshr(x, mNum(32 - by))));
  return {
    bitwise: true,
    forward: build(r),
    inverse: build(32 - r),
    forwardValue: (x) => rot(x, r),
    inverseValue: (x) => rot(x, 32 - r),
  };
}

// y = x ^ (x >>> s).  Writing T for "shift right by s", that is (I + T)x over
// GF(2)^32, and T is nilpotent (T^k = 0 once k*s >= 32), so the inverse is the
// finite series I + T + T^2 + ...  — i.e. y ^ (y>>>s) ^ (y>>>2s) ^ ...
function xorShiftRound(left: boolean): Round {
  const s = getRandomInt(7, 16);
  const shiftExpr = (x: MBAExpr, by: number) =>
    left ? mShl(x, mNum(by)) : mUshr(x, mNum(by));
  const shiftValue = (x: number, by: number) => (left ? x << by : x >>> by);

  return {
    bitwise: true,
    forward: (x) => pinned(mXor(x, shiftExpr(x, s))),
    inverse: (x) => {
      // Every term reads the SAME input, so this is a fan-out rather than a
      // chain — no intermediate needs naming, and the expression stays flat.
      let acc = x;
      for (let by = s; by < 32; by += s) acc = pinned(mXor(acc, shiftExpr(x, by)));
      return acc;
    },
    forwardValue: (x) => x ^ shiftValue(x, s),
    inverseValue: (x) => {
      let acc = x;
      for (let by = s; by < 32; by += s) acc = acc ^ shiftValue(x, by);
      return acc;
    },
  };
}

/** Horner evaluation of `p`, exact mod 2^32 because every step is Math.imul. */
function hornerExpr(p: Poly, x: MBAExpr): MBAExpr {
  let acc: MBAExpr = mNum(p[p.length - 1] | 0);
  for (let i = p.length - 2; i >= 0; i--)
    acc = mAdd(mImul(acc, x), mNum(p[i] | 0));
  return trunc(acc);
}

function pp3Round(): Round {
  const { forward, inverse } = randomPP3();
  return {
    bitwise: false,
    forward: (x) => hornerExpr(forward, x),
    inverse: (x) => hornerExpr(inverse, x),
    forwardValue: (x) => evalPoly(forward, x),
    inverseValue: (x) => evalPoly(inverse, x),
  };
}

// ── Composition ──────────────────────────────────────────────────────────────

// Enough rounds that no two encodings in a build resemble each other, few
// enough that a decode stays affordable on the transition path.  The pp3 round
// dominates the cost (its inverse is a Horner chain of up to 16 Math.imuls);
// everything else is a handful of operations.
const MIN_ROUNDS = 4;
const MAX_ROUNDS = 6;

const BITWISE_KINDS: (() => Round)[] = [
  rotRound,
  () => xorShiftRound(false),
  () => xorShiftRound(true),
];

const CHEAP_KINDS: (() => Round)[] = [
  mulRound,
  addRound,
  xorRound,
  ...BITWISE_KINDS,
];

/**
 * A fresh random bijection on int32.
 *
 * `polynomial` adds a degree-3 permutation polynomial round — the only source
 * of genuine algebraic non-linearity, and the expensive one.  It is off for
 * encodings applied to values that are decoded on a frequently executed path.
 */
export function createEncoding(polynomial = true): Encoding {
  const rounds: Round[] = [];
  const count = getRandomInt(MIN_ROUNDS, MAX_ROUNDS);

  for (let i = 0; i < count; i++) rounds.push(choice(CHEAP_KINDS)());

  // Without a bit-permuting round the whole composite is a polynomial function
  // — multiplies, adds, xors with constants and a pp3 round all are — and a
  // polynomial encoding is exactly what interpolation recovers.  A rotate or a
  // xorshift is what takes it out of that class, so one is mandatory rather
  // than merely likely.
  if (!rounds.some((r) => r.bitwise))
    rounds[getRandomInt(0, rounds.length - 1)] = choice(BITWISE_KINDS)();

  if (polynomial) {
    // Placed in the interior rather than at either end: a polynomial round at
    // the boundary would leave the outermost operation of E (or of E^-1)
    // recognisable as a Horner chain, which is the shape an attacker looking
    // for a PP encoding greps for.
    rounds.splice(getRandomInt(1, rounds.length - 1), 0, pp3Round());
  }

  const steps = (
    x: MBAExpr,
    name: (i: number) => string,
    forward: boolean,
  ): EncodingSteps => {
    const order = forward ? rounds : [...rounds].reverse();
    const bindings: [string, MBAExpr][] = [];
    let cur = x;
    order.forEach((round, i) => {
      const bound = name(i);
      // Every binding is truncated, and the truncation is PINNED.
      //
      // Rounds whose outermost operator is bitwise (`^`, `|`) look like they
      // truncate themselves, and they do — until the caller expands them.  The
      // MBA rules preserve a value only MODULO 2^32 (mba-utils' correctness
      // contract says so outright), and XOR_RULES' `(x + y) - 2*(x & y)` is
      // arithmetic, so a rewritten `x ^ c` can land a multiple of 2^32 away
      // instead of clearing the slop its operator would have cleared.  That
      // then feeds the next round as a non-int32, and the composite stops being
      // a bijection.
      //
      // So the invariant is made structural rather than incidental: every
      // binding ends in a `| 0` that no rewrite may touch, which means every
      // round receives an exact int32 whatever expansion does to the interior.
      bindings.push([
        bound,
        trunc(forward ? round.forward(cur) : round.inverse(cur)),
      ]);
      cur = mVar(bound);
    });
    return { bindings, result: cur };
  };

  return {
    encodeSteps: (x, name) => steps(x, name, true),
    decodeSteps: (x, name) => steps(x, name, false),
    encodeValue: (n) => rounds.reduce((acc, r) => r.forwardValue(acc), n | 0),
    decodeValue: (n) =>
      rounds.reduceRight((acc, r) => r.inverseValue(acc), n | 0),
  };
}
