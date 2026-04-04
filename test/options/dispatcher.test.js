import { evalCode, obfuscate } from "../test-utils.js";

test("Variant #1: Dispatcher", async () => {
  let sourceCode = `
  function TestFunction() {
    if(true) {
      window.TEST_OUTPUT = "Correct Value";
    }
  }

  TestFunction();
  `
  var { code } = await obfuscate(sourceCode, {
    dispatcher: true
  });
  var { code: defaultCode } = await obfuscate(sourceCode, {});

  var dispatcherLabelRegex = /\/\/ dispatcher_/;

  expect(code).toMatch(dispatcherLabelRegex); // Ensure dispatcher was applied
  expect(defaultCode).not.toMatch(dispatcherLabelRegex); // Ensure dispatcher was not applied to default options

  // Ensure the program still works
  const TEST_OUTPUT = await evalCode(code);
  expect(TEST_OUTPUT).toBe("Correct Value");
});