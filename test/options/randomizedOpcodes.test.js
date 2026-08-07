import { Compiler } from "../../src/compiler.ts";
import { evalCode, obfuscate } from "../test-utils.js";

function slotsObject(code) {
  return /var SLOTS = \{[\s\S]*?\};/.exec(code)?.[0] ?? "";
}

test("Variant #1: Randomized Opcodes", async () => {
  const sourceCode = `
  console.log("Hello world!");
  `;

  const { code } = await obfuscate(sourceCode, {
    randomizeOpcodes: true,
  });

  const { code: defaultCode } = await obfuscate(sourceCode, {});

  const defaultCompiler = new Compiler();

  // var OP = { LOAD_CONST: N } ensure it was found but also changed
  expect(defaultCode).toContain("LOAD_CONST: " + defaultCompiler.OP.LOAD_CONST);
  expect(code).not.toContain("LOAD_CONST: " + defaultCompiler.OP.LOAD_CONST);
});

test("Variant #2: Provisions decoy header slots", async () => {
  const sourceCode = `
  var out = [];
  function push(x) { out.push(x); return out.length; }
  for (var i = 0; i < 5; i++) push(i * 2);
  window.TEST_OUTPUT = out.join(",") + ":" + push(99);
  `;

  const { code } = await obfuscate(sourceCode, {
    randomizeOpcodes: true,
  });

  expect(slotsObject(code)).toMatch(/NOISE_[A-Z_]+: \d+/);
  expect(await evalCode(code)).toEqual("0,2,4,6,8:6");
});

test("Variant #3: No decoy header slots without randomizeOpcodes", async () => {
  const { code } = await obfuscate(`window.TEST_OUTPUT = 1 + 1;`, {});

  expect(slotsObject(code)).toContain("PC: ");
  expect(slotsObject(code)).not.toContain("NOISE_");
  expect(await evalCode(code)).toEqual(2);
});

test("Variant #4: Decoy header slots survive the runtime passes", async () => {
  const sourceCode = `
  function fib(n) { var a = 0, b = 1, c = n; while (n-- > 1) { c = a + b; a = b; b = c; } return c; }
  var out = [];
  for (var i = 1; i <= 10; i++) out.push(fib(i));
  try { null.x; } catch (e) { out.push("caught"); }
  window.TEST_OUTPUT = out.join(",");
  `;

  const { code } = await obfuscate(sourceCode, {
    randomizeOpcodes: true,
    handlerTable: true,
    classObfuscation: true,
  });

  // classObfuscation inlines SLOTS, so the unprovisioned decoys fold to `void 0`
  expect(slotsObject(code)).toEqual("");
  expect(code).toContain('typeof void 0 === "number"');
  expect(await evalCode(code)).toEqual("1,1,2,3,5,8,13,21,34,55,caught");
});
