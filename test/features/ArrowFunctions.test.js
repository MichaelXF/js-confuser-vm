import JsConfuserVM from "../../src";
import { obfuscate, evalCode } from "../test-utils";

// Basic forms
test("Variant #1: Concise body returns the expression value", async () => {
  const { code } = await obfuscate(`
    var double = x => x * 2;
    window.TEST_OUTPUT = double(21);
  `);

  expect(await evalCode(code)).toBe(42);
});

test("Variant #2: Block body with explicit return", async () => {
  const { code } = await obfuscate(`
    var add = (a, b) => { return a + b; };
    window.TEST_OUTPUT = add(40, 2);
  `);

  expect(await evalCode(code)).toBe(42);
});

test("Variant #3: No parameters", async () => {
  const { code } = await obfuscate(`
    var answer = () => 42;
    window.TEST_OUTPUT = answer();
  `);

  expect(await evalCode(code)).toBe(42);
});

test("Variant #4: Multiple statements in block body", async () => {
  const { code } = await obfuscate(`
    var compute = (a, b) => {
      var sum = a + b;
      var product = a * b;
      return sum + product;
    };
    window.TEST_OUTPUT = compute(3, 4);
  `);

  expect(await evalCode(code)).toBe(19);
});

test("Variant #5: Block body with no return is undefined", async () => {
  const { code } = await obfuscate(`
    var noop = () => { var x = 1; };
    window.TEST_OUTPUT = noop();
  `);

  expect(await evalCode(code)).toBeUndefined();
});

// Concise body returning an object literal
test("Variant #6: Parenthesized object literal concise body", async () => {
  const { code } = await obfuscate(`
    var makePoint = (x, y) => ({ x: x, y: y });
    window.TEST_OUTPUT = makePoint(3, 4);
  `);

  expect(await evalCode(code)).toEqual({ x: 3, y: 4 });
});

// Closures over outer variables
test("Variant #7: Arrow captures an outer variable (closure)", async () => {
  const { code } = await obfuscate(`
    function makeAdder(n) {
      return x => x + n;
    }
    var add10 = makeAdder(10);
    window.TEST_OUTPUT = add10(5);
  `);

  expect(await evalCode(code)).toBe(15);
});

test("Variant #8: Arrow mutates a captured outer variable", async () => {
  const { code } = await obfuscate(`
    function makeCounter() {
      var count = 0;
      return () => { count = count + 1; return count; };
    }
    var c = makeCounter();
    window.TEST_OUTPUT = [c(), c(), c()];
  `);

  expect(await evalCode(code)).toEqual([1, 2, 3]);
});

// Lexical `this`
test("Variant #9: Arrow inside a method inherits the method's this", async () => {
  const { code } = await obfuscate(`
    var obj = {
      name: "Alice",
      greet: function () {
        var inner = () => "Hello, " + this.name;
        return inner();
      }
    };
    window.TEST_OUTPUT = obj.greet();
  `);

  expect(await evalCode(code)).toBe("Hello, Alice");
});

test("Variant #10: Arrow preserves this across an array callback", async () => {
  const { code } = await obfuscate(`
    var obj = {
      factor: 3,
      scale: function (nums) {
        return nums.map(n => n * this.factor);
      }
    };
    window.TEST_OUTPUT = obj.scale([1, 2, 3]);
  `);

  expect(await evalCode(code)).toEqual([3, 6, 9]);
});

test("Variant #11: Arrow's this is NOT rebound when called as a method", async () => {
  const { code } = await obfuscate(`
    var outer = {
      name: "outer",
      make: function () {
        return () => this.name;
      }
    };
    var fn = outer.make();
    var holder = { name: "holder", fn: fn };
    // Even though fn is called as holder.fn(), the arrow keeps outer's this.
    window.TEST_OUTPUT = holder.fn();
  `);

  expect(await evalCode(code)).toBe("outer");
});

test("Variant #12: Nested arrows inherit this through multiple levels", async () => {
  const { code } = await obfuscate(`
    var obj = {
      value: 7,
      run: function () {
        var a = () => {
          var b = () => {
            var c = () => this.value;
            return c();
          };
          return b();
        };
        return a();
      }
    };
    window.TEST_OUTPUT = obj.run();
  `);

  expect(await evalCode(code)).toBe(7);
});

test("Variant #13: this in a top-level arrow matches a top-level function reference", async () => {
  const { code } = await obfuscate(`
    var arrowThis = (() => this)();
    window.TEST_OUTPUT = arrowThis === undefined || arrowThis === (function(){ return this; })();
  `);

  expect(await evalCode(code)).toBe(true);
});

// Lexical `arguments`
test("Variant #14: Arrow uses the enclosing function's arguments", async () => {
  const { code } = await obfuscate(`
    function outer() {
      var inner = () => arguments[0] + arguments[1];
      return inner();
    }
    window.TEST_OUTPUT = outer(20, 22);
  `);

  expect(await evalCode(code)).toBe(42);
});

test("Variant #15: Arrow reads enclosing arguments.length, not its own", async () => {
  const { code } = await obfuscate(`
    function outer() {
      return (() => arguments.length)();
    }
    window.TEST_OUTPUT = [outer(), outer(1), outer(1, 2, 3)];
  `);

  expect(await evalCode(code)).toEqual([0, 1, 3]);
});

// Parameters
test("Variant #16: Default parameters in an arrow", async () => {
  const { code } = await obfuscate(`
    var greet = (name, greeting = "Hello") => greeting + ", " + name + "!";
    window.TEST_OUTPUT = [greet("World"), greet("World", "Hi")];
  `);

  expect(await evalCode(code)).toEqual(["Hello, World!", "Hi, World!"]);
});

test("Variant #17: Rest parameters in an arrow", async () => {
  const { code } = await obfuscate(`
    var sum = (...nums) => {
      var total = 0;
      for (var i = 0; i < nums.length; i++) total += nums[i];
      return total;
    };
    window.TEST_OUTPUT = sum(1, 2, 3, 4, 5);
  `);

  expect(await evalCode(code)).toBe(15);
});

test("Variant #18: Rest parameter with leading named param in an arrow", async () => {
  const { code } = await obfuscate(`
    var first = (a, ...rest) => [a, rest.length];
    window.TEST_OUTPUT = first(42, 1, 2, 3);
  `);

  expect(await evalCode(code)).toEqual([42, 3]);
});

// Higher-order / currying
test("Variant #19: Curried arrows (arrow returning arrow)", async () => {
  const { code } = await obfuscate(`
    var add = a => b => c => a + b + c;
    window.TEST_OUTPUT = add(1)(2)(3);
  `);

  expect(await evalCode(code)).toBe(6);
});

test("Variant #20: Immediately invoked arrow expression (IIAFE)", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = ((x, y) => x + y)(10, 32);
  `);

  expect(await evalCode(code)).toBe(42);
});

test("Variant #21: Arrow passed to a higher-order array method", async () => {
  const { code } = await obfuscate(`
    var nums = [1, 2, 3, 4, 5, 6];
    window.TEST_OUTPUT = nums
      .filter(n => n % 2 === 0)
      .map(n => n * n)
      .reduce((acc, n) => acc + n, 0);
  `);

  expect(await evalCode(code)).toBe(56); // 4 + 16 + 36
});

test("Variant #22: Recursion through a named variable holding an arrow", async () => {
  const { code } = await obfuscate(`
    var factorial = n => (n <= 1 ? 1 : n * factorial(n - 1));
    window.TEST_OUTPUT = factorial(5);
  `);

  expect(await evalCode(code)).toBe(120);
});

// Closure-capture-in-loop semantics
test("Variant #23: Each arrow from a factory captures its own value", async () => {
  const { code } = await obfuscate(`
    function makeGetter(value) {
      return () => value;
    }
    var fns = [];
    for (var i = 0; i < 3; i++) {
      fns.push(makeGetter(i));
    }
    window.TEST_OUTPUT = [fns[0](), fns[1](), fns[2]()];
  `);

  expect(await evalCode(code)).toEqual([0, 1, 2]);
});

// Nesting: arrow captures enclosing arguments/this when the enclosing
// function's named params are UNUSED in its own body (slot-reservation edge case).
test("Variant #24: Arrow captures arguments of an enclosing fn with unused params", async () => {
  const { code } = await obfuscate(`
    function abc(a, b, c) {
      var x = () => arguments[0] + arguments[1] + arguments[2];
      return x();
    }
    window.TEST_OUTPUT = abc(1, 2, 3);
  `);

  expect(await evalCode(code)).toBe(6);
});

test("Variant #25: Arrow logs the enclosing arguments object (length + values)", async () => {
  const { code } = await obfuscate(`
    function abc(a, b, c) {
      var x = () => [arguments.length, arguments[0], arguments[2]];
      return x();
    }
    window.TEST_OUTPUT = abc(10, 20, 30);
  `);

  expect(await evalCode(code)).toEqual([3, 10, 30]);
});

test("Variant #26: Direct arguments access with unused named params", async () => {
  const { code } = await obfuscate(`
    function pick(a, b, c) {
      return arguments[1];
    }
    window.TEST_OUTPUT = pick("x", "y", "z");
  `);

  expect(await evalCode(code)).toBe("y");
});

test("Variant #27: Arrow captures this of an enclosing method with unused params", async () => {
  const { code } = await obfuscate(`
    var obj = {
      label: "ok",
      run: function (a, b, c) {
        var x = () => this.label;
        return x();
      }
    };
    window.TEST_OUTPUT = obj.run(1, 2, 3);
  `);

  expect(await evalCode(code)).toBe("ok");
});

test("Variant #28: Arrow uses both enclosing this and arguments together", async () => {
  const { code } = await obfuscate(`
    var obj = {
      base: 100,
      run: function (a, b) {
        var x = () => this.base + arguments[0] + arguments[1];
        return x();
      }
    };
    window.TEST_OUTPUT = obj.run(2, 3);
  `);

  expect(await evalCode(code)).toBe(105);
});

test("Variant #29: Mixed used/unused params with arrow capturing arguments", async () => {
  const { code } = await obfuscate(`
    function f(a, b, c, d) {
      // only b is used directly; arrow reads the full arguments
      var doubleB = b * 2;
      var all = () => arguments.length + ":" + arguments[3];
      return doubleB + "|" + all();
    }
    window.TEST_OUTPUT = f(1, 5, 9, 7);
  `);

  expect(await evalCode(code)).toBe("10|4:7");
});

test("Variant #30: Mixed regular function and arrow this binding", async () => {
  const { code } = await obfuscate(`
    var obj = {
      vals: [1, 2, 3],
      base: 100,
      sumWithBase: function () {
        var total = 0;
        this.vals.forEach(function (v) {
          // regular function: bind own this via the second forEach arg
          total += v;
        });
        var withBase = this.vals.map(v => v + this.base);
        return [total, withBase];
      }
    };
    window.TEST_OUTPUT = obj.sumWithBase();
  `);

  expect(await evalCode(code)).toEqual([6, [101, 102, 103]]);
});
