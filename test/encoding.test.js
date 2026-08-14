import {
  createEncoding,
} from "../src/utils/encoding-utils.ts";
import {
  evalPoly,
  invertPP,
  randomPP3,
  verifyPP,
} from "../src/utils/poly-utils.ts";
import {
  expandMBA,
  mVar,
  mbaNullVector,
  mbaAddExpr,
  poisonMBA,
  printMBA,
} from "../src/utils/mba-utils.ts";

// int32 boundaries, sign-overflow pairs, and the low-bit patterns the
// permutation-polynomial rounds are most likely to get wrong.
const VALUES = [
  0, 1, 2, 3, 4, 7, 8, -1, -2, -3, -8, 65535, 65536, 32768, 12345, -12345,
  2147483647, -2147483648, 2147483646, -2147483647, 1073741824, -1073741824,
  0x55555555, -0x55555555 | 0, 0x0f0f0f0f, 987654321,
];

const TRIALS = 12;

// ── Permutation polynomials ──────────────────────────────────────────────────

test("Variant #1: degree-3 permutation polynomials invert exactly", () => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const { forward, inverse } = randomPP3();

    // Rivest's criterion — the reason the forward direction is a bijection by
    // construction rather than by luck.  (`& 1` rather than `% 2`: coefficients
    // may be negative int32s, and `-6 % 2` is -0.)
    expect(forward[1] & 1).toBe(1); // a1 odd
    expect(forward[2] & 1).toBe(0); // a2 even
    expect(forward[3] & 1).toBe(0); // a3 even

    expect(verifyPP(forward, inverse, VALUES)).toBe(true);

    // And the other way round: a permutation's inverse is a permutation.
    for (const x of VALUES) {
      expect(evalPoly(inverse, evalPoly(forward, x))).toBe(x | 0);
    }
  }
});

test("Variant #2: the inverse is a permutation over a random sweep", () => {
  const { forward, inverse } = randomPP3();
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const x = (Math.random() * 2 ** 32) | 0;
    expect(evalPoly(inverse, evalPoly(forward, x))).toBe(x);
    seen.add(evalPoly(forward, x));
  }
  // A bijection cannot collide on 2000 distinct inputs (bar birthday luck far
  // below any plausible flake rate).
  expect(seen.size).toBeGreaterThan(1990);
});

test("Variant #3: inverting a non-permutation is rejected", () => {
  // a1 even — not a permutation, and silently "inverting" one would corrupt
  // every encoded value in a build.
  expect(() => invertPP([1, 2, 4, 6])).toThrow(/odd/);
});

// ── Encodings ────────────────────────────────────────────────────────────────

/**
 * Compile an encoding's step sequence into a callable.  Bindings are emitted in
 * order exactly as mbaOpcodes does, so this exercises the same lowering the
 * generated handler gets.
 */
function compileSteps(steps, argName) {
  const lines = steps.bindings.map(
    ([name, expr]) => `var ${name} = ${printMBA(expr)};`,
  );
  lines.push(`return ${printMBA(steps.result)};`);
  return new Function(argName, lines.join("\n"));
}

test("Variant #4: encode/decode round-trips over the int32 grid", () => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const enc = createEncoding(true);
    const encode = compileSteps(enc.encodeSteps(mVar("x"), (i) => `e${i}`), "x");
    const decode = compileSteps(enc.decodeSteps(mVar("x"), (i) => `d${i}`), "x");

    for (const x of VALUES) {
      const e = encode(x);
      expect(e | 0).toBe(e); // the encoded domain is int32
      expect(decode(e)).toBe(x | 0);
    }
  }
});

test("Variant #5: the build-time evaluator agrees with the expression", () => {
  // controlFlowFlattening encodes its state constants with encodeValue() at
  // build time, and the handler decodes them with the expression at runtime.
  // If the two ever disagreed the dispatch chain would simply never match.
  for (let trial = 0; trial < TRIALS; trial++) {
    const enc = createEncoding(true);
    const encode = compileSteps(enc.encodeSteps(mVar("x"), (i) => `e${i}`), "x");
    const decode = compileSteps(enc.decodeSteps(mVar("x"), (i) => `d${i}`), "x");

    for (const x of VALUES) {
      expect(enc.encodeValue(x)).toBe(encode(x));
      expect(enc.decodeValue(x)).toBe(decode(x));
      expect(enc.decodeValue(enc.encodeValue(x))).toBe(x | 0);
    }
  }
});

test("Variant #6: round-trip survives MBA expansion at a high budget", () => {
  // The MBA rules preserve a value only MODULO 2^32, so a round whose outermost
  // operator merely LOOKS self-truncating (`x ^ c`) stops being so once it is
  // rewritten — XOR_RULES' `(x + y) - 2*(x & y)` is arithmetic, and lands a
  // multiple of 2^32 out. That value then feeds the next round and the
  // composite is no longer a bijection. Every binding therefore ends in a
  // pinned `| 0`; this is what proves it.
  //
  // The trial count is deliberately high. This failure is probabilistic — it
  // needs a particular round at a particular position drawing a particular
  // rewrite — and at four trials it reproduced roughly one run in ten, which is
  // worse than useless in a suite.
  const STRESS = {
    depth: 3,
    leafDepth: 2,
    identityChance: 100,
    mulChance: 100,
    noise: ["x"],
  };
  const TRIALS_STRESS = 60;

  for (let trial = 0; trial < TRIALS_STRESS; trial++) {
    const enc = createEncoding(true);
    const expand = (steps) => ({
      bindings: steps.bindings.map(([n, e]) => [n, expandMBA(e, STRESS)]),
      result: steps.result,
    });
    const encode = compileSteps(
      expand(enc.encodeSteps(mVar("x"), (i) => `e${i}`)),
      "x",
    );
    const decode = compileSteps(
      expand(enc.decodeSteps(mVar("x"), (i) => `d${i}`)),
      "x",
    );

    for (const x of VALUES) {
      const e = encode(x);
      // Asserted separately from the round-trip: an encoded value that has left
      // int32 is the actual defect, and checking it here says WHICH direction
      // broke instead of only that the pair no longer composes.
      expect(e | 0).toBe(e);
      expect(decode(e)).toBe(x | 0);
    }
  }
});

test("Variant #7: no encoding is a pure polynomial", () => {
  // A composite built only from multiplies, adds, xors and a pp3 round is
  // still a polynomial function, and interpolating it is the standard attack.
  // At least one bit-permuting round is mandatory — see createEncoding.
  for (let trial = 0; trial < 20; trial++) {
    const enc = createEncoding(true);
    const src = enc.encodeSteps(mVar("x"), (i) => `e${i}`).bindings
      .map(([, e]) => printMBA(e))
      .join(" ");
    expect(/<<|>>>/.test(src)).toBe(true);
  }
});

// ── Domain-restricted null vectors ───────────────────────────────────────────

test("Variant #8: null vectors vanish on their domain", () => {
  const int32Vec = () =>
    new Function("raw$a", `return ${printMBA(mbaNullVector("a", { int32: true }))};`);
  const tagVec = () =>
    new Function(
      "a",
      `return ${printMBA(mbaNullVector("a", { modTag: { bits: 3, tag: 5 } }))};`,
    );
  const boolVec = () =>
    new Function("b", `return ${printMBA(mbaNullVector("b", { bool: true }))};`);
  const maskVec = () =>
    new Function("m", `return ${printMBA(mbaNullVector("m", { mask: true }))};`);

  for (let trial = 0; trial < TRIALS; trial++) {
    const f32 = int32Vec();
    for (const x of VALUES) expect(f32(x)).toBe(0);

    const ftag = tagVec();
    for (const x of VALUES) expect(ftag((x & ~7) | 5)).toBe(0);

    const fbool = boolVec();
    for (const x of [0, 1]) expect(fbool(x)).toBe(0);

    const fmask = maskVec();
    for (const x of [0, -1]) expect(fmask(x)).toBe(0);
  }
});

test("Variant #9: null vectors are NOT zero off their domain", () => {
  // This is the whole point and the easy thing to get silently wrong: a vector
  // that is identically zero everywhere still passes every correctness test
  // above while buying nothing at all. A sampling simplifier only refuses a
  // rewrite because the function DIFFERS on the probes it draws.
  let nonZero32 = 0;
  let nonZeroTag = 0;
  let nonZeroBool = 0;
  let nonZeroMask = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const f32 = new Function(
      "raw$a",
      `return ${printMBA(mbaNullVector("a", { int32: true }))};`,
    );
    // The non-integer probes a soundness-checking simplifier uses.
    for (const x of [0.5, 1.25, -3.75, 1e-3, 2147483647.5])
      if (f32(x) !== 0) nonZero32++;

    const ftag = new Function(
      "a",
      `return ${printMBA(mbaNullVector("a", { modTag: { bits: 3, tag: 5 } }))};`,
    );
    for (const x of [0, 1, 2, 3, 4, 6, 7]) if (ftag(x) !== 0) nonZeroTag++;

    // The two FIRING domains: their vectors have to be non-zero on ordinary
    // small integers, because those are the probes a black-box classifier
    // decides a fit on. A vector that only fires on floats or strings is
    // discarded by the classifier's fallback and buys nothing — which is
    // exactly what the int32 vector above is worth on its own.
    const fbool = new Function(
      "b",
      `return ${printMBA(mbaNullVector("b", { bool: true }))};`,
    );
    for (const x of [2, 3, 7, 255, -1]) if (fbool(x) !== 0) nonZeroBool++;

    const fmask = new Function(
      "m",
      `return ${printMBA(mbaNullVector("m", { mask: true }))};`,
    );
    for (const x of [1, 2, 3, 7, 255]) if (fmask(x) !== 0) nonZeroMask++;
  }

  expect(nonZero32).toBe(TRIALS * 5);
  expect(nonZeroTag).toBe(TRIALS * 7);
  expect(nonZeroBool).toBe(TRIALS * 5);
  expect(nonZeroMask).toBe(TRIALS * 5);
});

test("Variant #10: poisoned expressions agree on-domain and differ off it", () => {
  const domains = { a: { int32: true }, b: { int32: true } };
  const options = {
    depth: 2,
    leafDepth: 1,
    identityChance: 70,
    mulChance: 40,
    noise: ["a", "b"],
    domains,
    poisonChance: 100,
  };

  let differed = 0;
  let samples = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const expr = poisonMBA(mbaAddExpr(mVar("a"), mVar("b"), options), options);
    const src = printMBA(expr);
    const fn = new Function("a", "b", "raw$a", "raw$b", `return ${src};`);

    // On the domain the handler is still exactly `(a + b) | 0`.
    for (const a of VALUES)
      for (const b of VALUES) expect(fn(a, b, a, b)).toBe((a + b) | 0);

    // Off it — the float probes — it is a different function, which is what
    // makes a total-equivalence simplifier refuse the rewrite.
    for (const [a, b] of [
      [0.5, 1],
      [1, 2.25],
      [-3.5, 7],
      [10.125, -4],
    ]) {
      samples++;
      if (fn(a, b, a, b) !== (a + b) | 0) differed++;
    }
  }

  expect(samples).toBeGreaterThan(0);
  expect(differed).toBe(samples);
});
