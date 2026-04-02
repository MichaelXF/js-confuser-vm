import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Aliased Opcodes", async () => {
  var { code: output } = await obfuscate(
    `
    window.TEST_OUTPUT = "Correct Value";
    `,
    {
      aliasedOpcodes: true,
    },
  );

  var bytecodeCommentSection = output.split("var CONSTANTS")[0];
  expect(bytecodeCommentSection).toContain(" ALIAS_LOAD_GLOBAL_");

  var result = await evalCode(output);
  expect(result).toEqual("Correct Value");
});
