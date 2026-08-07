import { parse } from "@babel/parser";
import { generate } from "@babel/generator";
import { Compiler } from "../../src/compiler.ts";
import { applyClassObfuscation } from "../../src/transforms/runtime/classObfuscation.ts";
import { evalCode, obfuscate } from "../test-utils.js";

// Strips `//` line comments so assertions only see real code
function stripLineComments(code) {
  return code.replace(/\/\/.*$/gm, "");
}

test("Variant #1: Renames internal VM classes' fields/methods and stays correct", async () => {
  const sourceCode = `
    function makeCounter() {
      var n = 0;
      return function () {
        n++;
        return n;
      };
    }
    var counter = makeCounter();
    counter();
    counter();
    window.TEST_OUTPUT = counter();
  `;

  var { code: defaultCode } = await obfuscate(sourceCode, {});
  var { code } = await obfuscate(sourceCode, { classObfuscation: true });

  const defaultNames = [
    "captureUpvalue",
    "_closeUpvaluesFor",
    "_pushFrame",
    "_absSlot",
    "_openUpvalues",
  ];

  // Sanity check: the unobfuscated runtime really does contain these names,
  // so their absence below is a meaningful signal, not a tautology.
  for (const name of defaultNames) {
    expect(defaultCode).toContain(name);
  }

  // classObfuscation should have mangled every one of them away from actual
  // code (stale comments mentioning the old names are not rewritten).
  const codeWithoutComments = stripLineComments(code);
  for (const name of defaultNames) {
    expect(codeWithoutComments).not.toContain(name);
  }

  // Ensure the program still works
  const result = await evalCode(code);
  expect(result).toBe(3);
});

test("Variant #2: Inlines OP and SENTINELS into literal values", async () => {
  const sourceCode = `window.TEST_OUTPUT = 1 + 2;`;

  var { code: defaultCode } = await obfuscate(sourceCode, {});
  var { code } = await obfuscate(sourceCode, { classObfuscation: true });

  // Baseline: by default the opcode table and sentinel object are real
  // top-level declarations, and case tests read from them.
  expect(defaultCode).toContain("var OP = {");
  expect(defaultCode).toContain("var SENTINELS = {");
  expect(defaultCode).toMatch(/case OP\.\w+:/);

  // classObfuscation should fold every OP.X / SENTINELS.X access down to its
  // literal value and drop both declarations entirely.
  expect(code).not.toContain("var OP = {");
  expect(code).not.toContain("var SENTINELS = {");
  expect(code).not.toMatch(/case OP\.\w+:/);
  expect(code).toMatch(/case \d+:/);

  const result = await evalCode(code);
  expect(result).toBe(3);
});

test("Variant #3: Combined with encodeBytecode, still inlines and executes correctly", async () => {
  const sourceCode = `
    function myFunction() {
      try {
      } catch (e) {} // easily detectable opcode
      window.TEST_OUTPUT = "Correct Value";
    }
    myFunction();
  `;

  var { code } = await obfuscate(sourceCode, {
    classObfuscation: true,
    encodeBytecode: true,
  });

  // BYTECODE becomes a single string literal under encodeBytecode, so it's
  // a scalar-inlining candidate too — its declaration should be gone and its
  // value moved straight into the decodeBytecode(...) call site.
  expect(code).not.toContain("var BYTECODE");
  expect(code).not.toContain("var OP = {");
  expect(code).not.toContain("var SENTINELS = {");
  expect(code).toMatch(/decodeBytecode\("[A-Za-z0-9+/=]+"\)/);

  const result = await evalCode(code);
  expect(result).toEqual("Correct Value");
});

test("Variant #4: Statement shuffling keeps a prototype alias ahead of its uses", () => {
  // handlerTable's shape: an alias declaration followed by assignments through
  // it. Shuffling one of those assignments above the declaration would produce
  // `undefined[0] = ...` at load time.
  const source = `
    function VM(a) { this.x = a; }
    VM.prototype.run = function () { return this.x; };
    var VMPrototype = VM.prototype;
    ${Array.from(
      { length: 12 },
      (_, i) => `VMPrototype[${i}] = function () { return ${i}; };`,
    ).join("\n")}
    /* @BOOT */
    var vm = new VM(1);
  `;

  for (let round = 0; round < 10; round++) {
    const ast = parse(source, { sourceType: "unambiguous" });
    applyClassObfuscation(ast, new Compiler());

    const code = generate(ast).code;
    const declAt = code.indexOf("var VMPrototype =");
    const firstUseAt = code.indexOf("VMPrototype[");

    expect(declAt).toBeGreaterThanOrEqual(0);
    expect(firstUseAt).toBeGreaterThan(declAt);
  }
});

test("Variant #5: handlerTable's handler table is assigned after its alias", async () => {
  const { code } = await obfuscate(`window.TEST_OUTPUT = 6 * 7;`, {
    classObfuscation: true,
    handlerTable: true,
  });

  expect(code.indexOf("VMPrototype[")).toBeGreaterThan(
    code.indexOf("var VMPrototype ="),
  );
  expect(await evalCode(code)).toEqual(42);
});

test("Variant #6: Works with the full opcode-obfuscation stack", async () => {
  const sourceCode = `
    function fib(n) {
      var a = 0, b = 1, c = n;
      while (n-- > 1) {
        c = a + b;
        a = b;
        b = c;
      }
      return c;
    }
    var out = [];
    for (var i = 1; i <= 10; i++) out.push(fib(i));
    window.TEST_OUTPUT = out.join(",");
  `;

  var { code } = await obfuscate(sourceCode, {
    classObfuscation: true,
    antiInstrumentation: true,
    specializedOpcodes: true,
    macroOpcodes: true,
    aliasedOpcodes: true,
    shuffleOpcodes: true,
    randomizeOpcodes: true,
    concealConstants: true,
    encodeBytecode: true,
  });

  const result = await evalCode(code);
  expect(result).toEqual("1,1,2,3,5,8,13,21,34,55");
});
