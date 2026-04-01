// ensure self modifying works by:
// generate code with selfModifying enabled
// then ensure in the bytecode: OP_PATCH was used
// you may: create new compiler instance to read it's OP_PATCH
// with (randomizeOpcodes false), this OP_CODE int will be the same essentially

import { Compiler } from "../../src/compiler";
import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Specialized Opcodes", async () => {
  var { code: output } = await obfuscate(
    `
    window.TEST_OUTPUT = "Correct Value";
    `,
    {
      specializedOpcodes: true,
    },
  );

  // Ensure "Correct Value" became "LOAD_GLOBAL_0"
  var bytecodeCommentSection = output.split("var CONSTANTS")[0];
  expect(bytecodeCommentSection).toContain(" LOAD_GLOBAL_0 ");

  var result = await evalCode(output);
  expect(result).toEqual("Correct Value");
});
