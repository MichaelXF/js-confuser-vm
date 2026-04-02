import { Compiler } from "../../src/compiler";
import { evalCode, obfuscate } from "../test-utils";

const compiler = new Compiler();

test("Variant #1: Encode Bytecode", async () => {
  var sourceCode = `
    function myFunction(){
      try {} catch (e) {} // easily detectable op code
      window.TEST_OUTPUT = "Correct Value";
    }

    myFunction()
  `;

  var { code } = await obfuscate(sourceCode, {
    encodeBytecode: true,
  });

  var { code: defaultCode } = await obfuscate(sourceCode, {
    encodeBytecode: false,
  });

  // var BYTECODE = [47, 2, ...];
  // var MAIN_START_PC = 0;
  const getBytecodeSection = (code) => {
    return code.split("var BYTECODE")[1].split("var MAIN_START_PC")[0];
  };

  var knownOpcode = ", " + compiler.OP.TRY_SETUP + ", ";

  expect(getBytecodeSection(defaultCode)).toContain(knownOpcode); // ensure OP_TRY_SETUP is found
  expect(getBytecodeSection(code)).not.toContain(knownOpcode); // ensure OP_TRY_SETUP is not found as it's encoded

  var result = await evalCode(code);
  expect(result).toEqual("Correct Value");
});
