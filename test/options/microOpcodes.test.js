import { obfuscate } from "../test-utils.js";

test("Variant #1: Micro Opcodes", async () => {
  var sourceCode = `
    function greet(name) {
      var output = "Hello " + name + "!";
      window.TEST_OUTPUT = output;
    }
    greet("Internet User");
  `;

  var { code } = await obfuscate(sourceCode, {
    microOpcodes: true,
  });

  var { code: defaultCode } = await obfuscate(sourceCode, {});

  const getBytecodeSection = (code) => {
    return code.split("var CONSTANTS")[0];
  };

  expect(getBytecodeSection(code)).toContain("MICRO_ADD_0");
  expect(getBytecodeSection(defaultCode)).not.toContain("MICRO_ADD_0");
});
