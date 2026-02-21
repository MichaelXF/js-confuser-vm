import { virtualize } from "../src";
import { evalCode } from "./test-utils";

test("Variant #1: Basic closure captures a single variable", () => {
  const { code } = virtualize(`
    function makeGreeter(greeting) {
      return function(name) {
        return greeting + ", " + name + "!";
      };
    }
    var greet = makeGreeter("Hello");
    window.TEST_OUTPUT = greet("World");
  `);

  expect(evalCode(code)).toBe("Hello, World!");
});

test("Variant #2: Closure captures multiple variables", () => {
  const { code } = virtualize(`
    function makeRange(min, max) {
      return function(x) {
        return x >= min && x <= max;
      };
    }
    var inRange = makeRange(1, 10);
    window.TEST_OUTPUT = [inRange(5), inRange(0), inRange(10)];
  `);

  expect(evalCode(code)).toEqual([true, false, true]);
});

test("Variant #3: Closure captures from outer function (counter)", () => {
  const { code } = virtualize(`
    function makeCounter() {
      var count = 0;
      return function() {
        count = count + 1;
        return count;
      };
    }
    var counter = makeCounter();
    counter();
    counter();
    window.TEST_OUTPUT = counter();
  `);

  expect(evalCode(code)).toBe(3);
});

test("Variant #4: Closure modifies a captured variable", () => {
  const { code } = virtualize(`
    function makeAccumulator(initial) {
      var total = initial;
      return function(n) {
        total = total + n;
        return total;
      };
    }
    var acc = makeAccumulator(10);
    acc(5);
    acc(3);
    window.TEST_OUTPUT = acc(2);
  `);

  expect(evalCode(code)).toBe(20);
});

test("Variant #5: Nested closures (multi-level capture)", () => {
  const { code } = virtualize(`
    function outer(x) {
      return function middle(y) {
        return function inner(z) {
          return x + y + z;
        };
      };
    }
    window.TEST_OUTPUT = outer(1)(2)(3);
  `);

  expect(evalCode(code)).toBe(6);
});

test("Variant #6: Two closures sharing the same mutable cell", () => {
  const { code } = virtualize(`
    function makeGetterSetter() {
      var value = 0;
      var get = function() { return value; };
      var set = function(v) { value = v; };
      return [get, set];
    }
    var pair = makeGetterSetter();
    var get = pair[0];
    var set = pair[1];
    set(42);
    window.TEST_OUTPUT = get();
  `);

  expect(evalCode(code)).toBe(42);
});

test("Variant #7: Closure exits VM", () => {
  const { code } = virtualize(`
    function makeClosure() {
      var captured = "I am captured";
      return function() {
        return captured;
      };
    }
      
    window.TEST_OUTPUT = makeClosure();
    `);

  const closure = evalCode(code);
  expect(typeof closure).toStrictEqual("function");
  expect(closure()).toStrictEqual("I am captured");
});
