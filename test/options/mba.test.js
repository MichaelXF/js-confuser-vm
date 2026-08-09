import { evalCode, obfuscate } from "../test-utils.js";

test("Variant #1: integer arithmetic, bitwise ops and comparisons still work", async () => {
  const sourceCode = `
  function TestFunction(limit) {
    var acc = 0;
    for (var i = 0; i < 40; i++) {
      acc = acc + i;
      acc = acc ^ (i << 1);
      acc = acc & 65535;
      if (acc > 1000) { acc = acc - 999; }
    }
    return acc;
  }

  window.TEST_OUTPUT = TestFunction(40);
  `;

  const { code } = await obfuscate(sourceCode, { mba: true });
  expect(await evalCode(code)).toBe(836); // value of the plain JS program
});

test("Variant #2: non-integer values are left alone", async () => {
  // `+` on strings must stay concatenation and floats must stay exact — the
  // analysis has to reject both rather than apply int32 semantics.
  const sourceCode = `
  var s = "a";
  for (var i = 0; i < 4; i++) { s = s + i; }
  var f = 1.5 + 2.25;
  window.TEST_OUTPUT = s + "|" + f;
  `;

  const { code } = await obfuscate(sourceCode, { mba: true });
  expect(await evalCode(code)).toBe("a0123|3.75");
});

test("Variant #3: comparison results stay real booleans", async () => {
  const sourceCode = `
  var a = 7, b = 7, c = 9;
  window.TEST_OUTPUT = [
    a === b, a !== c, a < c, a > c, a <= b, a >= b,
    typeof (a === b), typeof (a < c), -a, ~a
  ].join(",");
  `;

  const { code } = await obfuscate(sourceCode, { mba: true });
  expect(await evalCode(code)).toBe(
    "true,true,true,false,true,true,boolean,boolean,-7,-8",
  );
});

test("Variant #4: @js-confuser-vm-no-mba opts a function out", async () => {
  // Outside MBA this stays exact; int32 semantics would wrap it to -294967296.
  const sourceCode = `
  /* @js-confuser-vm-no-mba */
  function TestFunction(a, b) {
    return (a | 0) + (b | 0);
  }

  window.TEST_OUTPUT = TestFunction(2000000000, 2000000000);
  `;

  const { code } = await obfuscate(sourceCode, { mba: true });
  expect(await evalCode(code)).toBe(4000000000);
});

test("Variant #5: @js-confuser-vm-int makes parameters eligible", async () => {
  const sourceCode = `
  /* @js-confuser-vm-int */
  function TestFunction(a, b) {
    return (a + b) ^ (a & b);
  }

  window.TEST_OUTPUT = TestFunction(12, 34);
  `;

  const { code } = await obfuscate(sourceCode, { mba: true });
  expect(await evalCode(code)).toBe(46);
});

test("Variant #6: integer operators are replaced in the bytecode", async () => {
  const sourceCode = `
  function TestFunction() {
    var acc = 0;
    for (var i = 0; i < 10; i++) {
      acc = acc + i;
      acc = acc ^ 3;
      if (acc > 5) { acc = acc & 31; }
    }
    return acc;
  }

  window.TEST_OUTPUT = TestFunction();
  `;

  const tally = async (options) => {
    const { code } = await obfuscate(sourceCode, {
      encodeBytecode: false,
      ...options,
    });
    const counts = {};
    for (const line of code.split("\n")) {
      if (!/^\s*\/\/\s*\[/.test(line)) continue;
      const match = /\],\s*([A-Z_0-9,]+)/.exec(line);
      if (match)
        for (const name of match[1].split(","))
          counts[name] = (counts[name] || 0) + 1;
    }
    return { counts, output: await evalCode(code) };
  };

  const plain = await tally({});
  const mba = await tally({ mba: true });

  // Same answer either way.
  expect(mba.output).toBe(plain.output);

  // GT is the probe worth using: no MBA rule ever emits a comparison, so its
  // disappearance means the source `>` really was rewritten. Counting BXOR or
  // BAND would prove nothing either way — they are the mixture's own building
  // blocks, so MBA drives them up rather than down.
  expect(plain.counts.GT).toBeGreaterThan(0);
  expect(mba.counts.GT || 0).toBe(0);

  // Each site independently becomes either an inline expansion (which grows the
  // bitwise mixture in the bytecode) or a generated MBA_* opcode (which grows
  // nothing — same operands, different opcode). Asserting on only one of those
  // would fail whenever the random split happens to favour the other, so this
  // checks the union.
  const bitwise = (counts) =>
    (counts.BAND || 0) + (counts.BOR || 0) + (counts.BXOR || 0);
  const generated = Object.keys(mba.counts).filter((n) =>
    n.startsWith("MBA_"),
  ).length;

  expect(bitwise(mba.counts) + generated).toBeGreaterThan(
    bitwise(plain.counts) * 2,
  );
});

test("Variant #7: composes with the other transforms", async () => {
  const sourceCode = `
  function fib(n) {
    var a = 0, b = 1, c = n;
    while (n-- > 1) { c = a + b; a = b; b = c; }
    return c;
  }

  var total = 0;
  for (var i = 1; i <= 20; i++) { total = total + fib(i); }
  window.TEST_OUTPUT = total;
  `;

  const { code } = await obfuscate(sourceCode, {
    mba: true,
    controlFlowFlattening: true,
    dispatcher: true,
    antiInstrumentation: true,
    aliasedOpcodes: true,
    macroOpcodes: true,
    encodeBytecode: true,
    concealConstants: true,
    handlerTable: true,
  });

  expect(await evalCode(code)).toBe(17710);
});
