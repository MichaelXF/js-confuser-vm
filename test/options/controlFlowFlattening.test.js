import { evalCode, obfuscate } from "../test-utils.js";

test("Variant #1: Control Flow Flattening with if-statement", async () => {
  let sourceCode = `
  function TestFunction() {
    if(true) {
      window.TEST_OUTPUT = "Correct Value";
    }
  }

  TestFunction();
  `;
  var { code } = await obfuscate(sourceCode, {
    controlFlowFlattening: true,
  });

  var cffLabelRegex = /\/\/ cff_block_/;
  expect(code).toMatch(cffLabelRegex);

  const TEST_OUTPUT = await evalCode(code);
  expect(TEST_OUTPUT).toBe("Correct Value");
});
