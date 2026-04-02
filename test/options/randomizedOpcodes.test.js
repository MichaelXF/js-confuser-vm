import { Compiler } from "../../src/compiler.ts";
import { obfuscate } from "../test-utils.js";

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
