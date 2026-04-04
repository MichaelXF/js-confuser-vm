import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Concealed Constants", async () => {
  var sourceCode = `
    window.TEST_OUTPUT = ["My Secret String", 123456789];
  `;

  var { code } = await obfuscate(sourceCode, {
    concealConstants: true,
  });

  var { code: defaultCode } = await obfuscate(sourceCode, {});

  function getConstantsSection(code) {
    return code.split("var CONSTANTS")[1].split("var BYTECODE")[0];
  }

  // Ensure the constants are concealed in the obfuscated code
  expect(getConstantsSection(code)).not.toContain("My Secret String");
  expect(getConstantsSection(code)).not.toContain("123456789");

  // Ensure the constants are still present in the default obfuscated code
  expect(getConstantsSection(defaultCode)).toContain("My Secret String");
  expect(getConstantsSection(defaultCode)).toContain("123456789");

  // Ensure the obfuscated code still works
  var result = await evalCode(code);
  expect(result).toEqual(["My Secret String", 123456789]);
});
