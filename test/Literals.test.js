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
