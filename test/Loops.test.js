import { virtualize } from "../src";
import { evalCode } from "./test-utils";

// ── While ─────────────────────────────────────────────────────────

test("Variant #1: While — accumulates a sum", () => {
  const { code } = virtualize(`
    var i = 1;
    var sum = 0;
    while (i <= 10) {
      sum = sum + i;
      i++;
    }
    window.TEST_OUTPUT = sum;
  `);

  expect(evalCode(code)).toBe(55);
});

test("Variant #2: While — condition false from the start, body never runs", () => {
  const { code } = virtualize(`
    var result = "untouched";
    while (false) {
      result = "changed";
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toBe("untouched");
});

test("Variant #3: While — builds an array via index assignment", () => {
  const { code } = virtualize(`
    var squares = [];
    var i = 0;
    while (i < 5) {
      squares[i] = i * i;
      i++;
    }
    window.TEST_OUTPUT = squares;
  `);

  expect(evalCode(code)).toEqual([0, 1, 4, 9, 16]);
});

test("Variant #4: While — compound condition (&&)", () => {
  const { code } = virtualize(`
    var i = 0;
    var j = 10;
    var count = 0;
    while (i < 5 && j > 5) {
      i++;
      j--;
      count++;
    }
    window.TEST_OUTPUT = count;
  `);

  // Both conditions satisfied for 5 iterations, then i=5 makes i<5 false
  expect(evalCode(code)).toBe(5);
});

// ── Do-While ──────────────────────────────────────────────────────

test("Variant #5: Do-while — body executes at least once even when condition is false", () => {
  const { code } = virtualize(`
    var ran = false;
    do {
      ran = true;
    } while (false);
    window.TEST_OUTPUT = ran;
  `);

  expect(evalCode(code)).toBe(true);
});

test("Variant #6: Do-while — accumulates a sum", () => {
  const { code } = virtualize(`
    var i = 1;
    var sum = 0;
    do {
      sum = sum + i;
      i++;
    } while (i <= 10);
    window.TEST_OUTPUT = sum;
  `);

  expect(evalCode(code)).toBe(55);
});

test("Variant #7: Do-while — runs exactly N times, test at the bottom", () => {
  const { code } = virtualize(`
    var count = 0;
    var i = 0;
    do {
      count++;
      i++;
    } while (i < 3);
    window.TEST_OUTPUT = count;
  `);

  expect(evalCode(code)).toBe(3);
});

// ── For ───────────────────────────────────────────────────────────

test("Variant #8: For — basic sum with var init and ++ update", () => {
  const { code } = virtualize(`
    var sum = 0;
    for (var i = 1; i <= 5; i++) {
      sum = sum + i;
    }
    window.TEST_OUTPUT = sum;
  `);

  expect(evalCode(code)).toBe(15);
});

test("Variant #9: For — builds an array", () => {
  const { code } = virtualize(`
    var result = [];
    for (var i = 0; i < 5; i++) {
      result[i] = i * 2;
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toEqual([0, 2, 4, 6, 8]);
});

test("Variant #10: For — bare expression init (not a var declaration)", () => {
  const { code } = virtualize(`
    var i;
    var sum = 0;
    for (i = 0; i < 5; i++) {
      sum = sum + i;
    }
    window.TEST_OUTPUT = sum;
  `);

  // 0+1+2+3+4
  expect(evalCode(code)).toBe(10);
});

test("Variant #11: For — no update clause", () => {
  const { code } = virtualize(`
    var sum = 0;
    for (var i = 0; i < 5;) {
      sum = sum + i;
      i++;
    }
    window.TEST_OUTPUT = sum;
  `);

  expect(evalCode(code)).toBe(10);
});

test("Variant #12: Nested for loops", () => {
  const { code } = virtualize(`
    var result = [];
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        result[i * 3 + j] = i * 10 + j;
      }
    }
    window.TEST_OUTPUT = result;
  `);

  expect(evalCode(code)).toEqual([0, 1, 2, 10, 11, 12, 20, 21, 22]);
});
