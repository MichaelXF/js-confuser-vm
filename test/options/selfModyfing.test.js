// ensure self modifying works by:
// generate code with selfModifying enabled
// then ensure in the bytecode: OP_PATCH was used
// you may: create new compiler instance to read it's OP_PATCH
// with (randomizeOpcodes false), this OP_CODE int will be the same essentially

import { Compiler } from "../../src/compiler";
import { evalCode, obfuscate } from "../test-utils";

const compiler = new Compiler();

test("Variant #1: Self Modifying function", async () => {
  var { code: output } = await obfuscate(
    `
    function myFunction(){
      try {} catch (e) {} // easily detectable op code
      window.TEST_OUTPUT = "Correct Value";
    }

    myFunction()
    `,
    {
      selfModifying: true,
    },
  );

  var bytecodeSection = output.split("var BYTECODE")[1];
  expect(bytecodeSection).toContain("]");
  expect(bytecodeSection).toContain("[" + compiler.OP.PATCH); // ensure OP_PATCH is used

  var result = await evalCode(output);
  expect(result).toEqual("Correct Value");
});
