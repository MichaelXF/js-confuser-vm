import { parse } from "@babel/parser";
import { generate } from "@babel/generator";
import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { Compiler } from "../../src/compiler.ts";
import { applyClassObfuscation } from "../../src/transforms/runtime/classObfuscation.ts";
import { applyDeclassify } from "../../src/transforms/runtime/declassify.ts";
import { evalCode, obfuscate } from "../test-utils.js";

const traverse = traverseImport.default || traverseImport;

// Strips `//` line comments so assertions only see real code
function stripLineComments(code) {
  return code.replace(/\/\/.*$/gm, "");
}

// Finds the handler-table dispatch — a computed call `TABLE[op]()` — and
// returns its NodePath, or null. Matching on the AST rather than on the
// generated text matters here: every name in the output is a one-or-two-letter
// mangled name, and property names come out of the same alphabet as variable
// names, so a textual search for `H[` also hits an unrelated `vm.H[idx]`.
function findDispatchPath(ast) {
  let found = null;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        t.isMemberExpression(callee) &&
        callee.computed &&
        t.isIdentifier(callee.object) &&
        t.isIdentifier(callee.property, { name: "op" }) &&
        path.node.arguments.length === 0
      ) {
        found = path;
        path.stop();
      }
    },
  });
  return found;
}

// The index of `path`'s statement within `blockNode.body`, or null when the
// path sits in some deeper block (inside a handler function, say) instead of
// directly alongside the table declaration.
function siblingStatementIndex(path, blockNode) {
  const stmt = path.getStatementParent();
  if (!stmt || !stmt.parentPath || stmt.parentPath.node !== blockNode)
    return null;
  return stmt.key;
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

test("Variant #5: handlerTable's table is a local of the run function", async () => {
  const { code } = await obfuscate(`window.TEST_OUTPUT = 6 * 7;`, {
    classObfuscation: true,
    handlerTable: true,
  });

  // The VM.prototype alias handlerTable uses on its own is gone: declassify
  // ran first, so there is no prototype left to hang a table off.
  expect(code).not.toContain("VMPrototype");

  const ast = parse(code, { sourceType: "unambiguous" });
  const dispatch = findDispatchPath(ast);
  expect(dispatch).not.toBeNull();

  // Dispatch goes through a local binding, not a property of a live object:
  // `H[op]()`, never `this[op]()`.
  expect(t.isThisExpression(dispatch.node.callee.object)).toBe(false);

  const table = dispatch.node.callee.object.name;
  const binding = dispatch.scope.getBinding(table);
  expect(binding).toBeDefined();

  // A plain empty array declared as a local of the enclosing run function —
  // so it is unreachable from outside a live call to it.
  expect(binding.kind).toBe("var");
  expect(t.isFunction(binding.scope.block)).toBe(true);
  expect(binding.path.node.init).toMatchObject({
    type: "ArrayExpression",
    elements: [],
  });

  // Every handler assignment sitting alongside the declaration has to come
  // after it — a write hoisted above `var H = []` would be `undefined[0] = ...`
  // the moment the run function is entered.
  const declStmt = binding.path.getStatementParent();
  const blockNode = declStmt.parentPath.node;
  const uses = binding.referencePaths
    .map((p) => siblingStatementIndex(p, blockNode))
    .filter((i) => i !== null);

  expect(uses.length).toBeGreaterThan(0);
  expect(Math.min(...uses)).toBeGreaterThan(declStmt.key);

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

test("Variant #7: Lowers the runtime's classes to bare objects and hides the helpers", async () => {
  const { code } = await obfuscate(`window.TEST_OUTPUT = [1, 2, 3].join("-");`, {
    classObfuscation: true,
  });
  const output = stripLineComments(code);

  // No prototype method definitions survive, so there is nothing to
  // monkey-patch: `VM.prototype._operand = ...` and friends are gone. (A bare
  // `shell.prototype = closure.prototype` stays — that one is load-bearing for
  // `new` and `instanceof` on VM closures.)
  expect(output).not.toMatch(/\.prototype\.\w+\s*=[^=]/);

  // Constructors became factories, so no call site uses `new` on them and no
  // `this` is left anywhere except the closure shell's own receiver.
  expect(output).not.toMatch(/\bnew (VM|Closure|Upvalue)\b/);
  expect(output).not.toMatch(/this\s*\./);

  // Each factory hands back an object literal.
  expect(output).toMatch(/function VM\([^)]*\)\s*\{\s*return \{/);

  // The Upvalue class is referenced only from a helper that sinks into the run
  // function, so the whole thing — name included — disappears from the top level.
  expect(output).not.toContain("Upvalue");

  expect(await evalCode(code)).toEqual("1-2-3");
});

test("Variant #8: Recursion inside a host-invoked callback stays on VM frames", async () => {
  // `map` calls the closure shell from host code, which spins up a sub-VM.
  // Recursion inside that sub-VM has to resolve through CLOSURE_MAP and take
  // the _pushFrame fast path; if each level allocated another sub-VM instead,
  // depth would cost JS stack frames and blow up well before 400.
  const { code } = await obfuscate(
    `
    function down(n) { return n === 0 ? 0 : 1 + down(n - 1); }
    var out = [400, 401].map(function (x) { return down(x); });
    window.TEST_OUTPUT = out.join(",");
    `,
    { classObfuscation: true, handlerTable: true },
  );

  expect(await evalCode(code)).toEqual("400,401");
});

test("Variant #9: Guest constructors, prototypes and instanceof still work", async () => {
  const { code } = await obfuscate(
    `
    function Point(x, y) { this.x = x; this.y = y; }
    Point.prototype.sum = function () { return this.x + this.y; };
    var p = new Point(3, 4);
    window.TEST_OUTPUT = p.sum() + ":" + (p instanceof Point);
    `,
    { classObfuscation: true, handlerTable: true },
  );

  expect(await evalCode(code)).toEqual("7:true");
});

test("Variant #10: Partial-arity internal calls survive parameter shuffling", async () => {
  // `this._constant()` leaves both of its operand params defaulted while
  // specializedOpcodes emits `this._constant(idx, key)` fully applied. Both
  // shapes have to keep working once the parameter list is padded, extended
  // with fakes and permuted.
  const { code } = await obfuscate(
    `
    var s = "the quick brown fox";
    window.TEST_OUTPUT = s.toUpperCase() + "|" + (7 * 6);
    `,
    {
      classObfuscation: true,
      specializedOpcodes: true,
      concealConstants: true,
      handlerTable: true,
    },
  );

  expect(await evalCode(code)).toEqual("THE QUICK BROWN FOX|42");
});

// The declassify half of the option rewrites receivers into arguments, which
// is only sound while a call site's receiver type is knowable from the method
// name alone. These check that it refuses — leaving the AST untouched — rather
// than guessing, since a wrong guess is a silently miscompiled runtime.
describe("Variant #11: Declassify refuses receivers it cannot resolve", () => {
  const RUN = `var op = 0; /* @SWITCH */ switch (op) { case 0: break; }`;

  function declassify(source) {
    const ast = parse(source, { sourceType: "unambiguous" });
    const compiler = new Compiler();
    applyDeclassify(ast, compiler);
    return { compiler, code: generate(ast).code };
  }

  test("bails when two classes share a method name", () => {
    const { compiler, code } = declassify(`
      function A(v) { this.v = v; }
      A.prototype.read = function () { return this.v; };
      A.prototype.run = function () { ${RUN} };
      function B(v) { this.v = v; }
      B.prototype.read = function () { return this.v * 2; };
      /* @BOOT */
      var a = new A(1);
    `);

    expect(compiler.declassify).toBeNull();
    expect(code).toContain("A.prototype.read =");
    expect(code).toContain("B.prototype.read =");
  });

  test("bails when a method escapes as a value", () => {
    const { compiler, code } = declassify(`
      function A(v) { this.v = v; }
      A.prototype.read = function () { return this.v; };
      A.prototype.run = function () { var f = this.read; ${RUN} };
      /* @BOOT */
      var a = new A(1);
    `);

    expect(compiler.declassify).toBeNull();
    expect(code).toContain("A.prototype.read =");
  });

  test("lowers the class when every receiver is resolvable", () => {
    const { compiler, code } = declassify(`
      function A(v) { this.v = v; }
      A.prototype.read = function () { return this.v; };
      A.prototype.run = function () { var r = this.read(); ${RUN} };
      /* @BOOT */
      var a = new A(1);
      a.run();
    `);

    expect(compiler.declassify).not.toBeNull();
    expect(code).not.toContain(".prototype.");

    // The constructor became a factory and the method a free function taking
    // the receiver as its first argument.
    expect(code).toMatch(/function A\(v\)\s*\{\s*return \{\s*v: v\s*\};\s*\}/);
    expect(code).toMatch(/A_read\(a\w*\)/);
    expect(code).toContain("A_run(a)");

    // `read` is only reachable from `run`, so it sinks inside it.
    expect(code).toMatch(/function A_run\([\s\S]*function A_read\(/);
  });
});
