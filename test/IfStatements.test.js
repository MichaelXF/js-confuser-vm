import { virtualize } from "../src";
import { evalCode } from "./test-utils";

test("Variant #1: Basic if — condition true, body executes", () => {
  const { code } = virtualize(`
    var result = "no";
    if (10 > 5) {
      result = "yes";
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe("yes");
});

test("Variant #2: Basic if — condition false, body is skipped", () => {
  const { code } = virtualize(`
    var result = "original";
    if (3 > 10) {
      result = "changed";
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe("original");
});

test("Variant #3: If-else — true branch taken", () => {
  const { code } = virtualize(`
    var x = 10;
    var result;
    if (x > 5) {
      result = "big";
    } else {
      result = "small";
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe("big");
});

test("Variant #4: If-else — false branch taken", () => {
  const { code } = virtualize(`
    var x = 3;
    var result;
    if (x > 5) {
      result = "big";
    } else {
      result = "small";
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe("small");
});

test("Variant #5: If-else-if chain hits each branch", () => {
  const { code } = virtualize(`
    function grade(score) {
      var g;
      if (score >= 90) {
        g = "A";
      } else if (score >= 80) {
        g = "B";
      } else if (score >= 70) {
        g = "C";
      } else {
        g = "F";
      }
      return g;
    }
    window.TEST_OUTPUT = [grade(95), grade(85), grade(75), grade(50)];
  `);

  expect(evalCode(code)).toEqual(["A", "B", "C", "F"]);
});

test("Variant #6: Nested if statements — all four paths", () => {
  const { code } = virtualize(`
    function classify(x, y) {
      var result;
      if (x > 0) {
        if (y > 0) {
          result = "Q1";
        } else {
          result = "Q4";
        }
      } else {
        if (y > 0) {
          result = "Q2";
        } else {
          result = "Q3";
        }
      }
      return result;
    }
    window.TEST_OUTPUT = [classify(1, 1), classify(-1, 1), classify(-1, -1), classify(1, -1)];
  `);

  expect(evalCode(code)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
});

test("Variant #7: Compact body (no braces) on if", () => {
  const { code } = virtualize(`
    var x = 10;
    var result = "no";
    if (x > 5) result = "yes";
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe("yes");
});

test("Variant #8: Compact body (no braces) on if-else-if", () => {
  const { code } = virtualize(`
    function sign(n) {
      var s;
      if (n > 0) s = "positive";
      else if (n < 0) s = "negative";
      else s = "zero";
      return s;
    }
    window.TEST_OUTPUT = [sign(5), sign(-3), sign(0)];
  `);

  expect(evalCode(code)).toEqual(["positive", "negative", "zero"]);
});
