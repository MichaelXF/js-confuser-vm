import { virtualize } from "../src";
import { evalCode } from "./test-utils";

test("Variant #1: Pre/Post increment and decrement", () => {
  const { code } = virtualize(`
    let a = 1;
    a++;
    window.TEST_OUTPUT = [
      a++,
      a--,
      a--,
      a--,
      ++a,
      --a,
      ++a
    ];
  `);

  expect(evalCode(code)).toEqual([2, 3, 2, 1, 1, 0, 1]);
});
