import {
  mVar,
  mNum,
  printMBA,
  asBoolean,
  mbaToAST,
  mbaVarNames,
  mbaAddExpr,
  mbaSubExpr,
  mbaNegExpr,
  mbaBNotExpr,
  mbaBinExpr,
  mbaEqExpr,
  mbaNeExpr,
  mbaLtExpr,
  mbaGtExpr,
  mbaLteExpr,
  mbaGteExpr,
  mbaConstExpr,
  mbaZeroExpr,
  mbaOpaqueTrue,
  mbaOpaqueFalse,
  mImul,
  emitMBA,
  modInverse32,
} from "../src/utils/mba-utils.ts";
import generate from "@babel/generator";

// Every MBA identity must be EXACTLY equivalent to the operator it replaces,
// for int32 inputs, across every random rewrite the engine can produce. These
// run the builders many times over so a rule that is only occasionally wrong
// still gets caught.
const OPTS = { depth: 3, noise: ["x", "y", "n"] };
// Always-multiplicative with a raised budget: the shape most likely to overflow
// an intermediate or rewrite away a pinned bound. Roughly 100x the size of a
// production expression, so it runs at a lower trial count.
const STRESS = {
  depth: 4,
  leafDepth: 2,
  noise: ["x", "y", "n"],
  mulChance: 100,
  identityChance: 100,
};
const TRIALS = 25;
const STRESS_TRIALS = 3;

// int32 boundaries plus the sign-overflow pairs that break naive comparisons
const VALUES = [
  0, 1, 2, 3, -1, -2, 7, -7, 65535, 32768, 12345, 65536, 2147483647,
  -2147483648, 2147483646, -2147483647, 1073741824, -1073741824,
];

function evaluator(src) {
  return new Function("x", "y", "n", "return (" + src + ");");
}

/** Assert `build()` matches `expect()` over the int32 grid, `TRIALS` times. */
function checkIdentity(build, expect) {
  for (let trial = 0; trial < TRIALS; trial++) {
    const fn = evaluator(printMBA(build()));
    for (const x of VALUES) {
      for (const y of VALUES) {
        const n = VALUES[Math.abs(x + y) % VALUES.length] | 0;
        expect_(fn(x, y, n), expect(x, y), { x, y, n });
      }
    }
  }
}

/**
 * Same, but the noise variable sweeps the full int32 range rather than tracking
 * the operands. The multiplicative rules mask their noise operand internally,
 * so an unmasked caller must not be able to break the magnitude bound.
 */
function checkIdentityWithNoise(build, expect) {
  const NOISE = [0, 1, 2, 65535, 65536, 2147483647, -2147483648, -1, 1073741824];
  for (let trial = 0; trial < STRESS_TRIALS; trial++) {
    const fn = evaluator(printMBA(build()));
    for (const x of VALUES) {
      for (const y of VALUES) {
        for (const n of NOISE) expect_(fn(x, y, n), expect(x, y), { x, y, n });
      }
    }
  }
}

function expect_(got, want, ctx) {
  if (!Object.is(got, want)) {
    throw new Error(
      `MBA mismatch at ${JSON.stringify(ctx)}: got ${String(got)} (${typeof got}), want ${String(want)} (${typeof want})`,
    );
  }
}

const X = () => mVar("x");
const Y = () => mVar("y");

test("Variant #1: bitwise identities are exact", () => {
  checkIdentity(() => mbaBinExpr("&", X(), Y(), OPTS), (x, y) => x & y);
  checkIdentity(() => mbaBinExpr("|", X(), Y(), OPTS), (x, y) => x | y);
  checkIdentity(() => mbaBinExpr("^", X(), Y(), OPTS), (x, y) => x ^ y);
  checkIdentity(() => mbaBNotExpr(X(), OPTS), (x) => ~x);
});

test("Variant #2: arithmetic identities are exact under int32 wrap", () => {
  checkIdentity(() => mbaAddExpr(X(), Y(), OPTS), (x, y) => (x + y) | 0);
  checkIdentity(() => mbaSubExpr(X(), Y(), OPTS), (x, y) => (x - y) | 0);
  checkIdentity(() => mbaNegExpr(X(), OPTS), (x) => -x | 0);
});

test("Variant #3: relational comparisons survive sign overflow", () => {
  // (-2147483648) - 2147483647 overflows int32; a naive sign-of-difference
  // test gets these pairs wrong, so they are the point of the grid.
  checkIdentity(() => mbaLtExpr(X(), Y(), OPTS), (x, y) => x < y);
  checkIdentity(() => mbaGtExpr(X(), Y(), OPTS), (x, y) => x > y);
  checkIdentity(() => mbaLteExpr(X(), Y(), OPTS), (x, y) => x <= y);
  checkIdentity(() => mbaGteExpr(X(), Y(), OPTS), (x, y) => x >= y);
});

test("Variant #4: equality builders, coerced to real booleans", () => {
  checkIdentity(
    () => asBoolean(mbaEqExpr(X(), Y(), OPTS)),
    (x, y) => x === y,
  );
  checkIdentity(
    () => asBoolean(mbaNeExpr(X(), Y(), OPTS)),
    (x, y) => x !== y,
  );
});

test("Variant #5: opaque predicates are invariant for every input", () => {
  checkIdentity(() => mbaZeroExpr(X(), OPTS), () => 0);
  checkIdentity(() => mbaOpaqueTrue(X(), OPTS), () => true);
  checkIdentity(() => mbaOpaqueFalse(X(), OPTS), () => false);
});

test("Variant #6: hidden constants still evaluate to the constant", () => {
  for (let i = 0; i < 40; i++) {
    const k = Math.floor(Math.random() * 65536);
    checkIdentity(() => mbaConstExpr(k, OPTS), () => k);
  }
});

test("Variant #7: hidden constants actually reference a runtime variable", () => {
  // A constant expanded only against other constants folds straight back to the
  // literal, which defeats the purpose — it must entangle a live variable.
  let entangled = 0;
  for (let i = 0; i < 50; i++) {
    if (mbaVarNames(mbaConstExpr(1234, OPTS)).length > 0) entangled++;
  }
  expect(entangled).toBe(50);
});

test("Variant #8: mbaToAST agrees with the source printer", () => {
  for (let i = 0; i < 60; i++) {
    const expr = mbaLtExpr(X(), Y(), OPTS);
    const viaPrinter = evaluator(printMBA(expr));
    const viaAST = evaluator(
      generate.default(mbaToAST(expr, (name) => ({ type: "Identifier", name })))
        .code,
    );
    for (const x of [0, -1, 5, -2147483648, 2147483647]) {
      for (const y of [0, 1, -5, 2147483647]) {
        expect_(viaAST(x, y, 3), viaPrinter(x, y, 3), { x, y, backend: "ast" });
      }
    }
  }
});

test("Variant #10: multiplicative rules stay exact at maximum budget", () => {
  // Variable-coefficient multiplication is only safe because both multiplicands
  // are pinned — `x` truncated to int32, the noise operand masked to 16 bits —
  // giving a worst-case product of 2^47 against float64's 2^53 exact limit.
  // Those pins are `fixed` nodes precisely so no rewrite can preserve their
  // VALUE while dropping the BOUND, and this is what would catch that.
  checkIdentityWithNoise(
    () => mbaAddExpr(X(), Y(), STRESS),
    (x, y) => (x + y) | 0,
  );
  checkIdentityWithNoise(
    () => mbaSubExpr(X(), Y(), STRESS),
    (x, y) => (x - y) | 0,
  );
  checkIdentityWithNoise(
    () => mbaBinExpr("&", X(), Y(), STRESS),
    (x, y) => x & y,
  );
  checkIdentityWithNoise(() => mbaLtExpr(X(), Y(), STRESS), (x, y) => x < y);
  checkIdentityWithNoise(() => mbaZeroExpr(X(), STRESS), () => 0);
  checkIdentityWithNoise(() => mbaOpaqueTrue(X(), STRESS), () => true);
});

test("Variant #11: noise variables and multiplication reach the output", () => {
  // Leaf identity expansion is the only path by which a foreign variable or a
  // multiplicative rule enters an expression, and leaves sit at the bottom of
  // the tree — so on a budget shared with operator rewrites it gets starved
  // entirely. This guards the split budget that fixes that.
  const SAMPLES = 300;
  let usesNoise = 0;
  let usesMul = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const expr = mbaAddExpr(mVar("a"), mVar("b"), {
      depth: 2,
      noise: ["a", "b", "k"],
    });
    if (mbaVarNames(expr).includes("k")) usesNoise++;
    if (/\*/.test(printMBA(expr))) usesMul++;
  }
  expect(usesNoise / SAMPLES).toBeGreaterThan(0.3);
  expect(usesMul / SAMPLES).toBeGreaterThan(0.3);
});

// Mirrors the scramble in transforms/runtime/mbaOpcodes.ts: the frame's
// register count is mixed into a large odd value, and the handler bakes that
// value's modular inverse.
const SCRAMBLE_MUL = 1995742819;
const SCRAMBLE_XOR = 38168123;
function frameKey(regCount) {
  const v = ((Math.imul(regCount, SCRAMBLE_MUL) ^ SCRAMBLE_XOR) | 1) | 0;
  return { v, c: modInverse32(v) };
}

const FRAME_OPTS = {
  depth: 3,
  leafDepth: 2,
  identityChance: 80,
  noise: ["x", "y"],
  frameVar: "v",
  invVar: "c",
  frameChance: 60,
};

test("Variant #12: frame-bound rules are exact inside their own frame", () => {
  const inFrame = (regCount, build, want) => {
    const { v, c } = frameKey(regCount);
    for (let trial = 0; trial < STRESS_TRIALS; trial++) {
      const fn = new Function(
        "x",
        "y",
        "v",
        "c",
        "return (" + printMBA(build()) + ");",
      );
      for (const x of VALUES)
        for (const y of VALUES)
          expect_(fn(x, y, v, c), want(x, y), { x, y, regCount });
    }
  };
  // Includes 0 and 1 — a raw register count there would make the binding
  // degenerate, so this is where the scramble earns its place.
  for (const regCount of [0, 1, 2, 3, 7, 631, 65535]) {
    inFrame(regCount, () => mbaAddExpr(X(), Y(), FRAME_OPTS), (x, y) => (x + y) | 0);
    inFrame(regCount, () => mbaSubExpr(X(), Y(), FRAME_OPTS), (x, y) => (x - y) | 0);
    inFrame(regCount, () => mbaBinExpr("&", X(), Y(), FRAME_OPTS), (x, y) => x & y);
    inFrame(regCount, () => mbaBNotExpr(X(), FRAME_OPTS), (x) => ~x);
    inFrame(regCount, () => mbaLtExpr(X(), Y(), FRAME_OPTS), (x, y) => x < y);
  }
});

test("Variant #13: frame-bound rules are WRONG in any other frame", () => {
  // This is the whole point. A rule that stayed correct in a foreign frame
  // would be an identity — cancellable by inspection, and worth nothing.
  const baked = frameKey(631);
  let bound = 0;
  let tested = 0;
  for (let i = 0; i < 150; i++) {
    const expr = mbaAddExpr(X(), Y(), FRAME_OPTS);
    if (!mbaVarNames(expr).includes("v")) continue;
    tested++;
    const fn = new Function(
      "x",
      "y",
      "v",
      "c",
      "return (" + printMBA(expr) + ");",
    );
    let differs = false;
    for (const otherCount of [0, 1, 17, 42, 1000, 4096, 65535]) {
      const wrong = frameKey(otherCount); // foreign frame's v, this handler's c
      for (const [x, y] of [[3, 5], [100, 200], [-7, 9], [65535, 1]]) {
        if (!Object.is(fn(x, y, wrong.v, baked.c), (x + y) | 0)) differs = true;
      }
    }
    if (differs) bound++;
  }
  expect(tested).toBeGreaterThan(80);
  expect(bound / tested).toBeGreaterThan(0.95);
});

test("Variant #14: the scramble keeps baked constants opaque", () => {
  // A raw register count would be small, and the inverse of a small number is a
  // recognisable magic constant (modInverse32(3) is 0xAAAAAAAB); a count of 0
  // would invert to 1 and make the binding a no-op. Both must be scrambled away.
  for (const regCount of [0, 1, 2, 3, 5, 7, 9, 17, 631]) {
    const { v, c } = frameKey(regCount);
    expect(Math.abs(v)).toBeGreaterThan(0xffff);
    expect(Math.abs(c)).toBeGreaterThan(0xffff);
    // Neither baked word may sit next to the value it encodes.
    for (const near of [regCount, regCount - 1, regCount + 1]) {
      expect(v).not.toBe(near);
      expect(c).not.toBe(near);
    }
    expect(Math.imul(v, c) | 0).toBe(1);
  }
});

test("Variant #15: an absent frame binding never emits a reference to one", () => {
  // Spreading `frameVar: undefined` overrides the default rather than falling
  // back to it, which produced a reference to a variable literally named
  // "undefined". Half a binding is also meaningless and must be dropped whole.
  for (let i = 0; i < 60; i++) {
    for (const opts of [
      { depth: 2, noise: ["x", "y"] },
      { depth: 2, noise: ["x", "y"], frameVar: undefined, invVar: undefined },
      { depth: 2, noise: ["x", "y"], frameVar: "v" }, // no invVar — incomplete
      { depth: 2, noise: undefined, frameVar: undefined },
    ]) {
      const names = mbaVarNames(mbaAddExpr(X(), Y(), opts));
      expect(names).not.toContain("undefined");
      expect(names).not.toContain("");
      expect(names).not.toContain("v");
    }
  }
});

test("Variant #16: imul never reaches the bytecode backend", () => {
  // Frame-bound rules are handler-only — the VM has no IMUL opcode, so an
  // expression carrying one must fail loudly rather than emit a broken
  // instruction.
  const withImul = mImul(mVar("a"), mVar("b"));
  expect(() =>
    emitMBA([], withImul, new Map(), {
      compiler: { OP: {} },
      fnId: 0,
      maxId: new Map(),
      scratch: [],
      pinned: false,
    }),
  ).toThrow(/no VM opcode/);
});

test("Variant #9: expansion actually rewrites (no silent pass-through)", () => {
  // Rewriting is probabilistic by design, so this asserts the distribution
  // rather than any single draw: the great majority of sites must end up
  // mixing bitwise operators into the arithmetic, and none may come back as a
  // bare `x + y`.
  const SAMPLES = 200;
  let mixed = 0;
  let total = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const src = printMBA(mbaAddExpr(X(), Y(), OPTS));
    expect(src).not.toBe("(x + y)");
    if (/[&|^~]/.test(src)) mixed++;
    total += src.length;
  }
  expect(mixed / SAMPLES).toBeGreaterThan(0.75);
  expect(total / SAMPLES).toBeGreaterThan(40);
});
