import { virtualize } from "../src";
import { evalCode } from "./test-utils";

test("Variant #1: Boolean Literals", () => {
  const { code } = virtualize(`
    window.TEST_OUTPUT = [true, false];
  `);

  expect(evalCode(code)).toEqual([true, false]);
});

test("Variant #2: String Literals", () => {
  const { code } = virtualize(`
    window.TEST_OUTPUT = ["hello", "world"];
  `);

  expect(evalCode(code)).toEqual(["hello", "world"]);
});

test("Variant #3: Numeric Literals", () => {
  const { code } = virtualize(`
    window.TEST_OUTPUT = [42, 3.14, NaN, Infinity, -Infinity];
  `);

  expect(evalCode(code)).toEqual([42, 3.14, NaN, Infinity, -Infinity]);
});

test("Variant #4: Other Literals", () => {
  const { code } = virtualize(`
    window.TEST_OUTPUT = [null, undefined];
  `);

  expect(evalCode(code)).toEqual([null, undefined]);
});

test("Variant #5: Array expressions", () => {
  const { code } = virtualize(`
    window.TEST_OUTPUT = [1, "two", true, null, [3, 4], [[5]]];
  `);

  expect(evalCode(code)).toEqual([1, "two", true, null, [3, 4], [[5]]]);
});

test("Variant #6: Object expressions", () => {
  const { code } = virtualize(`
    window.TEST_OUTPUT = {
      a: 1,
      b: "two",
      c: true,
      d: null,
      e: [3, 4],
      f: { nested: "object", moreNested: { deeplyNested: {  } } }
    };
  `);

  expect(evalCode(code)).toEqual({
    a: 1,
    b: "two",
    c: true,
    d: null,
    e: [3, 4],
    f: { nested: "object", moreNested: { deeplyNested: {} } },
  });
});

test("Variant #7: Array and object runtime order", () => {
  const { code } = virtualize(`
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

  var result = evalCode(code);

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
