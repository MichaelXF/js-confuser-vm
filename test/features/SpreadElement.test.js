import { obfuscate, evalCode } from "../test-utils";

test("Variant #1: Spread array into plain function call", async () => {
  const { code } = await obfuscate(`
    function sum(a, b, c) { return a + b + c; }
    var nums = [1, 2, 3];
    window.TEST_OUTPUT = sum(...nums);
  `);
  expect(await evalCode(code)).toBe(6);
});

test("Variant #2: Spread into method call (Array.push)", async () => {
  const { code } = await obfuscate(`
    var arr = [1, 2];
    var more = [3, 4, 5];
    arr.push(...more);
    window.TEST_OUTPUT = arr;
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3, 4, 5]);
});

test("Variant #3: Mixed fixed args and spread", async () => {
  const { code } = await obfuscate(`
    function collect(a, b, c, d) { return [a, b, c, d]; }
    var middle = [2, 3];
    window.TEST_OUTPUT = collect(1, ...middle, 4);
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3, 4]);
});

test("Variant #4: Spread into rest-parameter function", async () => {
  const { code } = await obfuscate(`
    function first(a, ...rest) { return [a, rest]; }
    var args = [10, 20, 30];
    window.TEST_OUTPUT = first(...args);
  `);
  expect(await evalCode(code)).toEqual([10, [20, 30]]);
});

test("Variant #5: Spread in new expression", async () => {
  const { code } = await obfuscate(`
    function Point(x, y) { this.x = x; this.y = y; }
    var coords = [10, 20];
    var p = new Point(...coords);
    window.TEST_OUTPUT = [p.x, p.y];
  `);
  expect(await evalCode(code)).toEqual([10, 20]);
});

test("Variant #6: Array literal spread", async () => {
  const { code } = await obfuscate(`
    var a = [1, 2];
    var b = [3, 4];
    window.TEST_OUTPUT = [...a, ...b];
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3, 4]);
});

test("Variant #7: Array literal mixed spread", async () => {
  const { code } = await obfuscate(`
    var mid = [2, 3];
    window.TEST_OUTPUT = [1, ...mid, 4, 5];
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3, 4, 5]);
});

test("Variant #8: Spread with Math.max", async () => {
  const { code } = await obfuscate(`
    var nums = [3, 1, 4, 1, 5, 9, 2, 6];
    window.TEST_OUTPUT = Math.max(...nums);
  `);
  expect(await evalCode(code)).toBe(9);
});

test("Variant #9: Spread empty array", async () => {
  const { code } = await obfuscate(`
    function count() { return arguments.length; }
    window.TEST_OUTPUT = [
      count(...[]),
      count(...[1, 2, 3]),
      count(...[...[1,2],...[3,4]])
    ];
  `);
  expect(await evalCode(code)).toEqual([0, 3, 4]);
});

test("Variant #10: Spread preserves non-array value identity", async () => {
  const { code } = await obfuscate(`
    function identity(x) { return x; }
    var arr = [[1, 2], [3, 4]];
    window.TEST_OUTPUT = identity(...arr);
  `);
  // Only first arg received; the inner arrays must not be flattened
  expect(await evalCode(code)).toEqual([1, 2]);
});

// Object spread
test("Variant #11: Object spread copies own enumerable properties", async () => {
  const { code } = await obfuscate(`
    var base = { a: 1, b: 2 };
    var obj = { ...base };
    window.TEST_OUTPUT = [obj.a, obj.b];
  `);
  expect(await evalCode(code)).toEqual([1, 2]);
});

test("Variant #12: Object spread with additional properties", async () => {
  const { code } = await obfuscate(`
    var base = { a: 1, b: 2 };
    var obj = { ...base, c: 3 };
    window.TEST_OUTPUT = [obj.a, obj.b, obj.c];
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3]);
});

test("Variant #13: Object spread between properties", async () => {
  const { code } = await obfuscate(`
    var extra = { b: 2, c: 3 };
    var obj = { a: 1, ...extra, d: 4 };
    window.TEST_OUTPUT = [obj.a, obj.b, obj.c, obj.d];
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3, 4]);
});

test("Variant #14: Spread overrides earlier property", async () => {
  const { code } = await obfuscate(`
    var patch = { x: 99 };
    var obj = { x: 1, ...patch };
    window.TEST_OUTPUT = obj.x;
  `);
  expect(await evalCode(code)).toBe(99);
});

test("Variant #15: Later property overrides spread", async () => {
  const { code } = await obfuscate(`
    var base = { x: 1 };
    var obj = { ...base, x: 42 };
    window.TEST_OUTPUT = obj.x;
  `);
  expect(await evalCode(code)).toBe(42);
});

test("Variant #16: Multiple object spreads", async () => {
  const { code } = await obfuscate(`
    var a = { x: 1 };
    var b = { y: 2 };
    var c = { z: 3 };
    var obj = { ...a, ...b, ...c };
    window.TEST_OUTPUT = [obj.x, obj.y, obj.z];
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3]);
});

test("Variant #17: Spread inline object literal", async () => {
  const { code } = await obfuscate(`
    var obj = { a: 0, ...{ a: 1, b: 2 }, c: 3 };
    window.TEST_OUTPUT = [obj.a, obj.b, obj.c];
  `);
  expect(await evalCode(code)).toEqual([1, 2, 3]);
});
