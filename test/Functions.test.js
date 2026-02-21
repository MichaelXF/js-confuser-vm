import { virtualize } from "../src";
import { evalCode } from "./test-utils";

// ── Arguments ─────────────────────────────────────────────────────

test("Variant #1: Multiple arguments are received correctly", () => {
  const { code } = virtualize(`
    function sum(a, b, c) {
      return a + b + c;
    }
    window.TEST_OUTPUT = sum(1, 2, 3);
  `);

  expect(evalCode(code)).toBe(6);
});

test("Variant #2: Missing arguments default to undefined", () => {
  const { code } = virtualize(`
    function pack(a, b, c) {
      return [a, b, c];
    }
    window.TEST_OUTPUT = pack(1, 2);
  `);

  expect(evalCode(code)).toEqual([1, 2, undefined]);
});

// ── Default parameters ────────────────────────────────────────────

test("Variant #3: Default parameter used when argument is omitted", () => {
  const { code } = virtualize(`
    function greet(name, greeting = "Hello") {
      return greeting + ", " + name + "!";
    }
    window.TEST_OUTPUT = [greet("World"), greet("World", "Hi")];
  `);

  expect(evalCode(code)).toEqual(["Hello, World!", "Hi, World!"]);
});

test("Variant #4: Default parameter is an expression", () => {
  const { code } = virtualize(`
    function offset(x, base = 100) {
      return x + base;
    }
    window.TEST_OUTPUT = [offset(5), offset(5, 10)];
  `);

  expect(evalCode(code)).toEqual([105, 15]);
});

// ── Return values ─────────────────────────────────────────────────

test("Variant #5: Explicit return value", () => {
  const { code } = virtualize(`
    function max(a, b) {
      if (a > b) return a;
      return b;
    }
    window.TEST_OUTPUT = [max(3, 7), max(9, 4)];
  `);

  expect(evalCode(code)).toEqual([7, 9]);
});

test("Variant #6: Implicit return is undefined", () => {
  const { code } = virtualize(`
    function noReturn() {
      var x = 1;
    }
    window.TEST_OUTPUT = noReturn();
  `);

  expect(evalCode(code)).toBeUndefined();
});

// ── Recursive functions ───────────────────────────────────────────

test("Variant #7: Recursive function — factorial", () => {
  const { code } = virtualize(`
    function factorial(n) {
      if (n <= 1) return 1;
      return n * factorial(n - 1);
    }
    window.TEST_OUTPUT = factorial(5);
  `);

  expect(evalCode(code)).toBe(120);
});

test("Variant #8: Recursive function — fibonacci", () => {
  const { code } = virtualize(`
    function fib(n) {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
    window.TEST_OUTPUT = fib(8);
  `);

  expect(evalCode(code)).toBe(21);
});

// ── Function expressions ──────────────────────────────────────────

test("Variant #9: Function expression assigned to a variable", () => {
  const { code } = virtualize(`
    var double = function(x) { return x * 2; };
    window.TEST_OUTPUT = double(21);
  `);

  expect(evalCode(code)).toBe(42);
});

test("Variant #10: Function expression passed as an argument (higher-order)", () => {
  const { code } = virtualize(`
    function apply(fn, x) { return fn(x); }
    window.TEST_OUTPUT = apply(function(n) { return n * n; }, 7);
  `);

  expect(evalCode(code)).toBe(49);
});

test("Variant #11: Immediately invoked function expression (IIFE)", () => {
  const { code } = virtualize(`
    var result = (function(x, y) { return x + y; })(10, 32);
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe(42);
});

// ── this keyword ──────────────────────────────────────────────────

test("Variant #12: this is the receiver in a method call", () => {
  const { code } = virtualize(`
    var obj = {
      name: "Alice",
      greet: function() { return "Hello, " + this.name; }
    };
    window.TEST_OUTPUT = obj.greet();
  `);

  expect(evalCode(code)).toBe("Hello, Alice");
});

test("Variant #13: this is the new object inside a constructor", () => {
  const { code } = virtualize(`
    function Person(name, age) {
      this.name = name;
      this.age  = age;
    }
    var p = new Person("Bob", 30);
    window.TEST_OUTPUT = [p.name, p.age];
  `);

  expect(evalCode(code)).toEqual(["Bob", 30]);
});

// ── arguments object ──────────────────────────────────────────────

test("Variant #14: arguments.length reflects the call-site arity", () => {
  const { code } = virtualize(`
    function arity() { return arguments.length; }
    window.TEST_OUTPUT = [arity(), arity(1), arity(1, 2, 3)];
  `);

  expect(evalCode(code)).toEqual([0, 1, 3]);
});

test("Variant #15: arguments can be indexed and iterated", () => {
  const { code } = virtualize(`
    function sum() {
      var total = 0;
      var i = 0;
      while (i < arguments.length) {
        total = total + arguments[i];
        i++;
      }
      return total;
    }
    window.TEST_OUTPUT = sum(1, 2, 3, 4, 5);
  `);

  expect(evalCode(code)).toBe(15);
});
