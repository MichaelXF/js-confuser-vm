// Polynomial algebra over Z/2^32 — build time only
// ───────────────────────────────────────────────────────────────────────────
// This exists for ONE job: to produce a degree-3 permutation polynomial mod
// 2^32 together with its compositional inverse, so that encoding-utils can use
// a genuinely non-linear round whose decode is a closed-form expression rather
// than a runtime search.
//
// ── Why a permutation polynomial ─────────────────────────────────────────────
// The rest of the encoding rounds (multiply-by-odd, rotate, xorshift) are all
// affine over their respective structures: each is linear in GF(2) or linear
// mod 2^32.  A composition of them is still solvable by an attacker who is
// willing to work in the right basis.  A degree-3 term is not: it takes the
// round out of every linear algebra the standard MBA solvers are built on.
//
// ── Rivest's criterion ───────────────────────────────────────────────────────
// P(x) = a0 + a1x + a2x^2 + a3x^3 permutes Z/2^n exactly when
//
//     a1 is odd,   a2 + a4 + ... is even,   a3 + a5 + ... is even
//
// which for degree 3 is: a1 odd, a2 even, a3 even.  (Rivest, "Permutation
// polynomials modulo 2^w", 2001.)  randomPP3() draws inside that set, so every
// polynomial it returns is a bijection by construction — there is no
// probabilistic step and no verification needed for the FORWARD direction.
//
// ── Inverting one ────────────────────────────────────────────────────────────
// The inverse is another polynomial function on Z/2^32, but not of degree 3.
// It is computed here by a fixed-point iteration, which is exact rather than
// approximate for a reason specific to this ring:
//
//   Normalise P to R(x) = x + g(x) with every coefficient of g EVEN (possible
//   because a1 is odd, hence invertible, and a2/a3 are even).  Then
//
//       S_0(y) = y,      S_{k+1}(y) = y - g(S_k(y))
//
//   converges to R^-1.  The error after step k satisfies
//
//       S_{k+1} - R^-1  =  -[g(S_k) - g(R^-1)]
//                       =  -(S_k - R^-1) * [c2*(a+b) + c3*(a^2+ab+b^2)]
//
//   and the bracket is even because c2 and c3 are, so the 2-adic valuation of
//   the error grows by at least one per iteration.  34 iterations therefore
//   drive it past 2^32, where it is exactly zero.  No convergence check is
//   needed; the bound is structural.
//
// ── Keeping the degree bounded ───────────────────────────────────────────────
// Each iteration triples the degree, so without reduction the representation
// explodes.  The reduction is the falling factorial
//
//     (x)_34 = x(x-1)(x-2)...(x-33)
//
// which is identically 0 mod 2^32 for EVERY integer x, because it is divisible
// by 34! and v2(34!) = 34 - popcount(34) = 32.  It is monic, so reducing modulo
// it is ordinary polynomial division and cannot change the FUNCTION the
// polynomial represents — only its representation.  That keeps every
// intermediate at degree <= 33.
//
// Note this means the monomial representation is not unique mod 2^32 (x^34 and
// its reduction are different polynomials denoting the same function).  Nothing
// here depends on uniqueness; verifyPP() checks the function, not the form.
//
// All arithmetic runs on BigInt.  This is compile-time-only code — a few
// thousand BigInt multiplies per build — and the alternative (32-bit limbs)
// would buy speed nobody needs at the cost of a much easier place to be wrong.

import { getRandomInt } from "./random-utils.ts";

const M = 1n << 32n;

/** Coefficients in the monomial basis, index = degree, each a u32. */
export type Poly = number[];

type BigPoly = bigint[];

const norm = (v: bigint): bigint => ((v % M) + M) % M;

function trim(p: BigPoly): BigPoly {
  const q = p.map(norm);
  while (q.length > 1 && q[q.length - 1] === 0n) q.pop();
  return q;
}

function polyAdd(a: BigPoly, b: BigPoly): BigPoly {
  const out: BigPoly = new Array(Math.max(a.length, b.length)).fill(0n);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0n) + (b[i] ?? 0n);
  return trim(out);
}

function polySub(a: BigPoly, b: BigPoly): BigPoly {
  const out: BigPoly = new Array(Math.max(a.length, b.length)).fill(0n);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0n) - (b[i] ?? 0n);
  return trim(out);
}

function polyMul(a: BigPoly, b: BigPoly): BigPoly {
  const out: BigPoly = new Array(a.length + b.length - 1).fill(0n);
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return trim(out);
}

function polyScale(a: BigPoly, k: bigint): BigPoly {
  return trim(a.map((c) => c * k));
}

// (x)_34 — monic, degree 34, and identically zero mod 2^32 (see header).
const FALLING_34: BigPoly = (() => {
  let p: BigPoly = [1n];
  for (let i = 0; i < 34; i++) p = polyMul(p, [norm(BigInt(-i)), 1n]);
  return p;
})();

const FF_DEGREE = FALLING_34.length - 1;

/** Reduce modulo (x)_34 — preserves the function, bounds the degree at 33. */
function polyReduce(p: BigPoly): BigPoly {
  let q = trim(p);
  while (q.length - 1 >= FF_DEGREE) {
    const lead = q[q.length - 1];
    if (lead === 0n) {
      q.pop();
      continue;
    }
    const shift = q.length - 1 - FF_DEGREE;
    const shifted: BigPoly = new Array(shift)
      .fill(0n)
      .concat(polyScale(FALLING_34, lead));
    q = trim(polySub(q, shifted));
  }
  return q;
}

/** f(g(x)), reduced.  Horner over f's coefficients. */
function polyCompose(f: BigPoly, g: BigPoly): BigPoly {
  let acc: BigPoly = [0n];
  for (let i = f.length - 1; i >= 0; i--) {
    acc = polyReduce(polyMul(acc, g));
    acc = polyAdd(acc, [f[i]]);
  }
  return polyReduce(acc);
}

/** Multiplicative inverse mod 2^32 of an odd BigInt. */
function bigInverse(n: bigint): bigint {
  let x = norm(n);
  for (let i = 0; i < 6; i++) x = norm(x * (2n - norm(n * x)));
  return x;
}

/** Evaluate `p` at `x` mod 2^32, returning an int32. */
export function evalPoly(p: Poly, x: number): number {
  let acc = 0n;
  const xv = norm(BigInt(x));
  for (let i = p.length - 1; i >= 0; i--)
    acc = norm(acc * xv + norm(BigInt(p[i])));
  return Number(BigInt.asIntN(32, acc));
}

function toPoly(p: BigPoly): Poly {
  return p.map((c) => Number(norm(c)));
}

function toBig(p: Poly): BigPoly {
  return trim(p.map((c) => norm(BigInt(c))));
}

/**
 * Compositional inverse of a Rivest-valid degree-3 permutation polynomial.
 * See the header for why the iteration is exact rather than approximate.
 */
export function invertPP(P: Poly): Poly {
  const p = toBig(P);
  const a0 = p[0] ?? 0n;
  const a1 = p[1] ?? 0n;
  if (a1 % 2n === 0n)
    throw new Error("invertPP: a1 must be odd (not a permutation)");

  // R(x) = a1^-1 * (P(x) - a0) = x + g(x), every coefficient of g even.
  const u = bigInverse(a1);
  const R = polyScale([0n, a1, p[2] ?? 0n, p[3] ?? 0n], u);
  const g: BigPoly = [0n, 0n, R[2] ?? 0n, R[3] ?? 0n];

  let S: BigPoly = [0n, 1n];
  // One iteration per bit of error, plus two for luck — the valuation grows by
  // at least one per step, so 34 is a proof rather than a guess.
  for (let i = 0; i < 34; i++) S = polyReduce(polySub([0n, 1n], polyCompose(g, S)));

  // P^-1(y) = S(u * (y - a0))
  return toPoly(polyCompose(S, polyScale([norm(-a0), 1n], u)));
}

/** True when `inverse(forward(x)) === x` for every x in the sample. */
export function verifyPP(forward: Poly, inverse: Poly, samples: number[]) {
  for (const x of samples) {
    if (evalPoly(inverse, evalPoly(forward, x)) !== (x | 0)) return false;
  }
  return true;
}

// The forward polynomial is always degree 3; the INVERSE is whatever the ring
// hands back, and its degree is what the decode costs at runtime (one Math.imul
// per level in a Horner chain).
//
// Degree falls off sharply with the 2-adic valuation of a2/a3, because a more
// divisible perturbation drives the error down faster and higher coefficients
// reach 2^32 sooner.  Measured over random draws:
//
//     v2(a2,a3) >= 1  ->  inverse degree 29..33
//     v2(a2,a3) >= 2  ->  16..29
//     v2(a2,a3) >= 3  ->  10..21
//     v2(a2,a3) >= 4  ->  11..15
//     v2(a2,a3) >= 8  ->   5..7
//
// The trade is real and runs the other way: a2 divisible by 2^k means the
// quadratic term cannot affect the low k bits, so the polynomial is affine
// there.  Drawing at valuation 2 and REJECTING on inverse degree keeps the
// non-linearity reaching down to bit 2 while capping the runtime cost — the
// low bits are re-mixed by the rotate and xorshift rounds either way.
const MIN_VALUATION = 2;
const MAX_INVERSE_DEGREE = 16;
const DRAW_ATTEMPTS = 24;

/** A random u32 whose low `bits` bits are zero. */
function randomWithValuation(bits: number): number {
  return (getRandomInt(0, 0xffffffff) << bits) | 0;
}

/**
 * A random Rivest-valid degree-3 permutation polynomial and its inverse.
 * The forward direction is a bijection by construction; the pair is verified
 * over a sample anyway, because a silent break here would corrupt every
 * encoded value in the build rather than fail loudly.
 */
export function randomPP3(): { forward: Poly; inverse: Poly } {
  const samples = [
    0, 1, -1, 2, -2, 3, 7, -7, 0x7fffffff, -0x80000000, 0xffff, 0x10000,
    123456789, -123456789, 0x40000000, -0x40000000,
  ];

  let best: { forward: Poly; inverse: Poly } | null = null;

  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    // Widen the valuation as attempts run out: a higher one always yields a
    // lower inverse degree, so this terminates.
    const valuation = MIN_VALUATION + Math.floor(attempt / 6);
    const forward: Poly = [
      getRandomInt(0, 0xffffffff),
      (getRandomInt(0, 0x7fffffff) * 2 + 1) | 0, // a1 odd
      randomWithValuation(valuation), // a2 even
      randomWithValuation(valuation), // a3 even
    ];

    const inverse = invertPP(forward);
    if (!verifyPP(forward, inverse, samples)) continue;

    const candidate = { forward, inverse };
    if (inverse.length - 1 <= MAX_INVERSE_DEGREE) return candidate;
    if (best === null || inverse.length < best.inverse.length) best = candidate;
  }

  if (best === null)
    throw new Error("randomPP3: no verifiable permutation polynomial found");
  return best;
}
