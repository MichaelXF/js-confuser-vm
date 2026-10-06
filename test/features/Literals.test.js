import JsConfuserVM from "../../src";
import { obfuscate, evalCode } from "../test-utils";

test("Variant #1: Boolean Literals", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = [true, false];
  `);

  expect(await evalCode(code)).toEqual([true, false]);
});

test("Variant #2: String Literals", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = ["hello", "world"];
  `);

  expect(await evalCode(code)).toEqual(["hello", "world"]);
});

test("Variant #3: Numeric Literals", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = [42, 3.14, NaN, Infinity, -Infinity];
  `);

  expect(await evalCode(code)).toEqual([42, 3.14, NaN, Infinity, -Infinity]);
});

test("Variant #4: Other Literals", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = [null, undefined];
  `);

  expect(await evalCode(code)).toEqual([null, undefined]);
});

test("Variant #5: Array expressions", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = [1, "two", true, null, [3, 4], [[5]]];
  `);

  expect(await evalCode(code)).toEqual([1, "two", true, null, [3, 4], [[5]]]);
});

test("Variant #6: Object expressions", async () => {
  const { code } = await obfuscate(`
    window.TEST_OUTPUT = {
      a: 1,
      b: "two",
      c: true,
      d: null,
      e: [3, 4],
      f: { nested: "object", moreNested: { deeplyNested: {  } } }
    };
  `);

  expect(await evalCode(code)).toEqual({
    a: 1,
    b: "two",
    c: true,
    d: null,
    e: [3, 4],
    f: { nested: "object", moreNested: { deeplyNested: {} } },
  });
});

test("Variant #8: RegExp literal basic", async () => {
  const { code } = await obfuscate(`
    var re = /hello/;
    window.TEST_OUTPUT = [re instanceof RegExp, re.source, re.flags];
  `);

  expect(await evalCode(code)).toEqual([true, "hello", ""]);
});

test("Variant #9: RegExp literal with flags", async () => {
  const { code } = await obfuscate(`
    var re = /foo/gi;
    window.TEST_OUTPUT = [re.source, re.flags];
  `);

  expect(await evalCode(code)).toEqual(["foo", "gi"]);
});

test("Variant #10: RegExp literal test()", async () => {
  const { code } = await obfuscate(`
    var re = /^\\d+$/;
    window.TEST_OUTPUT = [re.test("123"), re.test("abc"), re.test("12x")];
  `);

  expect(await evalCode(code)).toEqual([true, false, false]);
});

test("Variant #11: RegExp literal exec() and match()", async () => {
  const { code } = await obfuscate(`
    var m = /(\\w+)\\s(\\w+)/.exec("Hello World");
    window.TEST_OUTPUT = [m[0], m[1], m[2]];
  `);

  expect(await evalCode(code)).toEqual(["Hello World", "Hello", "World"]);
});

test("Variant #12: RegExp literal stateful lastIndex with /g", async () => {
  const { code } = await obfuscate(`
    var re = /a/g;
    var s = "aXaX";
    var r1 = re.test(s);
    var i1 = re.lastIndex;
    var r2 = re.test(s);
    var i2 = re.lastIndex;
    window.TEST_OUTPUT = [r1, i1, r2, i2];
  `);

  expect(await evalCode(code)).toEqual([true, 1, true, 3]);
});

test("Variant #13: RegExp literal fresh object per evaluation", async () => {
  const { code } = await obfuscate(`
    // Each pass through the loop re-evaluates the literal -> fresh lastIndex
    var results = [];
    for (var i = 0; i < 3; i++) {
      var re = /x/g;
      results.push(re.lastIndex);
      re.test("x");
      results.push(re.lastIndex);
    }
    window.TEST_OUTPUT = results;
  `);

  // lastIndex starts at 0 each iteration because a new object is created
  expect(await evalCode(code)).toEqual([0, 1, 0, 1, 0, 1]);
});

test("Variant #7: Array and object runtime order", async () => {
  const { code } = await obfuscate(`
    var counter = 0;
    var increment = function (){return counter++;};

    var arr = [increment(), [increment(), increment(), increment()], increment(), [increment(), [increment()]]];
    var obj = { x: increment(), y: increment(), z: {
      a: increment(),
      b: increment(),
      c: increment(),
      d: {
        e: increment(),
      }
    },

    nested: {
      f: increment(),
      g: increment()
    }
    };

    window.TEST_OUTPUT = { arr, obj };
  `);

  var result = await evalCode(code);

  expect(result.arr).toEqual([0, [1, 2, 3], 4, [5, [6]]]);

  expect(result.obj).toEqual({
    x: 7,
    y: 8,
    z: {
      a: 9,
      b: 10,
      c: 11,
      d: {
        e: 12,
      },
    },
    nested: {
      f: 13,
      g: 14,
    },
  });
});

// Variant #14 guards the int32 boundary
test("Variant #14: Numbers at and beyond the int32 boundary", async () => {
  const { code } = await obfuscate(`
    var GOLDEN = 2654435761;
    var obj = {};
    obj[GOLDEN] = "hash";
    obj[4294967295] = "max";

    var sum = 0;
    for (var i = 0; i < 3; i++) {
      sum += GOLDEN;
    }

    window.TEST_OUTPUT = {
      int32: [
        0x7ffffffe, 0x7fffffff, 0x80000000, 0x80000001,
        -0x7fffffff, -0x80000000, -0x80000001
      ],
      uint32: [
        0xffffffff, 0x100000000, 0x100000001,
        2654435761, 3735928559, 4294967295
      ],
      beyondUint32: [
        9007199254740991, -9007199254740991,
        1234567890123, -1234567890123,
        1e21, -1e21
      ],
      arithmetic: [
        2147483647 + 1,
        2147483647 * 2,
        -2147483648 - 1,
        4294967295 + 1,
        65536 * 65536,
        2654435761 - 1,
        9007199254740991 - 1
      ],
      bitwise: [
        2654435761 | 0,
        4294967295 | 0,
        2147483648 | 0,
        9007199254740991 | 0,
        2654435761 >>> 0,
        0x80000000 ^ 0,
        ~2654435761,
        2654435761 ^ 2654435761,
        (2654435761 ^ 123) ^ 123
      ],
      zeroAndFloats: [
        -0, 0,
        2147483647.5, 2147483648.25, 4294967295.5,
        -2147483648.5
      ],
      reused: [
        GOLDEN === 2654435761,
        GOLDEN > 2147483647,
        obj[2654435761],
        obj["2654435761"],
        obj[4294967295],
        sum,
        String(GOLDEN),
        Object.keys(obj).length
      ]
    };
  `);

  const result = await evalCode(code);

  expect(result).toEqual({
    int32: [
      2147483646, 2147483647, 2147483648, 2147483649, -2147483647, -2147483648,
      -2147483649,
    ],
    uint32: [
      4294967295, 4294967296, 4294967297, 2654435761, 3735928559, 4294967295,
    ],
    beyondUint32: [
      9007199254740991, -9007199254740991, 1234567890123, -1234567890123, 1e21,
      -1e21,
    ],
    arithmetic: [
      2147483648, 4294967294, -2147483649, 4294967296, 4294967296, 2654435760,
      9007199254740990,
    ],
    bitwise: [
      -1640531535, -1, -2147483648, -1, 2654435761, -2147483648, 1640531534, 0,
      -1640531535,
    ],
    zeroAndFloats: [
      -0, 0, 2147483647.5, 2147483648.25, 4294967295.5, -2147483648.5,
    ],
    reused: [true, true, "hash", "hash", "max", 7963307283, "2654435761", 2],
  });

  expect(Object.is(result.zeroAndFloats[0], -0)).toBe(true);
  expect(Object.is(result.zeroAndFloats[1], 0)).toBe(true);
});
