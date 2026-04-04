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
  expect(bytecodeCommentSection).toMatch(/ LOAD_GLOBAL_\d_0_0 /);

  var result = await evalCode(output);
  expect(result).toEqual("Correct Value");
});
