import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Lifts the opcode switch into a VM.prototype[op] handler table", async () => {
  var { code: output } = await obfuscate(
    `
    function add(a, b) { return a + b; }
    function makeCounter() {
      var n = 0;
      return function () { n = n + 1; return n; };
    }
    var c = makeCounter();
    c();
    c();
    window.TEST_OUTPUT = add(40, 2) + ":" + c();
    `,
    {
      handlerTable: true,
    },
  );

  // The @SWITCH dispatch became VM.prototype[<opcode>] = function () { ... }.
  // With classObfuscation off, OP is not inlined, so keys stay as OP.X.
  expect(output).toMatch(/VMPrototype\[OP\.\w+\] = function/);

  // Ensure the switch itself became a single dynamic dispatch.
  expect(output).toMatch(/this\[op\]\(\)/);

  // Injected vars are scanned per-handler: `base` is the frame's REG_BASE
  // header slot, and a body that reads `base` but never names `fp` inlines
  // `this._f` instead of emitting an unused `fp` var.
  expect(output).toMatch(/var base = regs\[this\._f \+ SLOTS\.REG_BASE\];/);

  // Handlers that do touch header slots (jumps, RETURN, upvalues) get `fp`.
  expect(output).toMatch(/var fp = this\._f;/);

  // The implicit trailing `return;` produced by the break -> return rewrite is
  // dropped, so no handler ends in a bare return.
  expect(output).not.toMatch(/return;\s*}/);

  // Ensure the program still works
  var result = await evalCode(output);
  expect(result).toEqual("42:3");
});

test("Variant #2: Handler table stays correct with specialized opcodes + class obfuscation", async () => {
  var { code: output } = await obfuscate(
    `
    function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    window.TEST_OUTPUT = fib(10);
    `,
    {
      handlerTable: true,
      specializedOpcodes: true,
      classObfuscation: true,
    },
  );

  // classObfuscation declassifies the runtime first, so the table is no longer
  // a property of VM.prototype: it is a plain array declared inside the run
  // function, and the handlers read VM state through run's vm parameter.
  expect(output).not.toMatch(/VMPrototype/);
  expect(output).not.toMatch(/\.prototype\[[^\]]*\]\s*=/);
  expect(output).toMatch(/(\w+)\[\d+\] = function \(\) \{/);
  expect(output).not.toMatch(/this\[\w+\]\(\)/);

  // Recursion exercises RETURN -> halt across many frames; the ternary and
  // arithmetic exercise the injected frame/regs/base vars inside handlers.

  var result = await evalCode(output);
  expect(result).toEqual(55);
});

test("Variant #3: Handler table off leaves the switch dispatch intact", async () => {
  var { code: output } = await obfuscate(
    `
    window.TEST_OUTPUT = (function () { return 1 + 2; })();
    `,
    {
      handlerTable: false,
    },
  );

  // No handler table; the @SWITCH statement is still a switch.
  expect(output).toMatch(/switch \(/);
  expect(output).not.toMatch(/this\[op\]\(\)/);

  var result = await evalCode(output);
  expect(result).toEqual(3);
});
