import { evalCode, obfuscate } from "../test-utils.js";

test("Variant #1: String Concealing encodes string", async () => {
  const sourceCode = `
  function greet(name) {
    return "Hello, " + name + "!";
  }
  window.TEST_OUTPUT = greet("World");
  `;

  var { code } = await obfuscate(sourceCode, {
    stringConcealing: true,
  });

  // Ensure the strings were encoded
  expect(code).not.toContain("Hello, ");
  expect(code).not.toContain("World");

  // Ensure the code still works
  const TEST_OUTPUT = await evalCode(code);
  expect(TEST_OUTPUT).toBe("Hello, World!");
});

test("Variant #2: String Concealing decode helper has no source locations", async () => {
  // The template inserted should not contain source node locations
  const sourceCode = `window.TEST_OUTPUT = "test";`;

  var { code } = await obfuscate(sourceCode, {
    stringConcealing: true,
  });

  const bytecodeCommentSection = code.split("var CONSTANTS")[0];

  const matches = [
    ...bytecodeCommentSection.matchAll(/\/\/(.+)\s(\d+:\d+-\d+:\d+)\s/g),
  ];

  // The input is one line, so all source locations must reference line 1 or below
  for (const match of matches) {
    const location = match[2]; // e.g. "1:0-1:27"
    const [startLine, endLine] = location.split("-").map((s) => parseInt(s));
    expect(startLine).toBeLessThanOrEqual(1);
    expect(endLine).toBeLessThanOrEqual(1);
  }
});
