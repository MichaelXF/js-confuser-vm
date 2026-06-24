import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Emits ANTI_ opcodes and stays correct", async () => {
  var { code: output } = await obfuscate(
    `
    window.TEST_OUTPUT = 10 + 15 * 2 - 3;
    `,
    {
      antiInstrumentation: true,
    },
  );

  var bytecodeCommentSection = output.split("var CONSTANTS")[0];
  expect(bytecodeCommentSection).toContain(" ANTI_");

  var result = await evalCode(output);
  expect(result).toEqual(10 + 15 * 2 - 3);
});

test("Variant #2: Preserves arithmetic, comparison and string semantics", async () => {
  var { code: output } = await obfuscate(
    `
    function f(a, b) {
      var x = a * b + (a - b);
      var y = a < b;
      var z = "v=" + (a % 3) + ":" + (a & b);
      return [x, y, z];
    }
    var out = [];
    for (var i = 1; i <= 5; i++) out.push(f(i, i + 2).join(","));
    window.TEST_OUTPUT = out.join("|");
    `,
    {
      antiInstrumentation: true,
    },
  );

  function f(a, b) {
    var x = a * b + (a - b);
    var y = a < b;
    var z = "v=" + (a % 3) + ":" + (a & b);
    return [x, y, z];
  }
  var expected = [];
  for (var i = 1; i <= 5; i++) expected.push(f(i, i + 2).join(","));

  var result = await evalCode(output);
  expect(result).toEqual(expected.join("|"));
});

test("Variant #3: Works with the full opcode-obfuscation stack", async () => {
  var { code: output } = await obfuscate(
    `
    function fib(n) {
      var a = 0, b = 1, c = n;
      while (n-- > 1) { c = a + b; a = b; b = c; }
      return c;
    }
    var out = [];
    for (var i = 1; i <= 10; i++) out.push(fib(i));
    window.TEST_OUTPUT = out.join(",");
    `,
    {
      antiInstrumentation: true,
      specializedOpcodes: true,
      macroOpcodes: true,
      aliasedOpcodes: true,
      shuffleOpcodes: true,
      randomizeOpcodes: true,
      concealConstants: true,
    },
  );

  var result = await evalCode(output);
  expect(result).toEqual("1,1,2,3,5,8,13,21,34,55");
});
