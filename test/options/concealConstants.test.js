import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Concealed Constants", async () => {
  var { code: output } = await obfuscate(
    `
      window.TEST_OUTPUT = ["My Secret String", 123456789];
    `,
    {
      concealConstants: true,
    },
  );

  var constantsSection = output
    .split("var CONSTANTS")[1]
    .split("var BYTECODE")[0];
  expect(constantsSection).not.toContain("My Secret String");
  expect(constantsSection).not.toContain("123456789");

  var result = await evalCode(output);
  expect(result).toEqual(["My Secret String", 123456789]);
});
