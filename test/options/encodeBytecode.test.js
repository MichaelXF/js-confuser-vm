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
      encodeBytecode: true,
    },
  );

  var bytecodeSection = output.split("var BYTECODE")[1];
  expect(bytecodeSection).not.toContain("[" + compiler.OP.TRY_SETUP); // ensure OP_PATCH is used

  var result = await evalCode(output);
  expect(result).toEqual("Correct Value");
});
