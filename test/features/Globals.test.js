import { evalCode, obfuscate } from "../test-utils.js";

test("Variant #1: Undeclared global should throw ReferenceError", async () => {
  var { code } = await obfuscate(`
    console2.log("Hello world!");
    `);

  var caught;
  try {
    await evalCode(code);
  } catch (err) {
    caught = err;
  }

  expect(caught.constructor.name).toStrictEqual("ReferenceError");
  expect(caught.toString()).toContain("console2 is not defined");
});

test("Variant #2: Typeof on undeclared global should not throw", async () => {
  var { code } = await obfuscate(`
    window.TEST_OUTPUT = typeof console2;
    `);

  var TEST_OUTPUT = await evalCode(code);

  expect(TEST_OUTPUT).toStrictEqual("undefined");
});
