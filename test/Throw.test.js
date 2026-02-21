import { virtualize } from "../src";
import { evalCode } from "./test-utils";

test("Variant #1: Throw — string literal propagates to host", () => {
  const { code } = virtualize(`
    throw "boom";
  `);

  let caught;
  try { evalCode(code); } catch (e) { caught = e; }
  expect(caught).toBe("boom");
});

test("Variant #2: Throw — numeric value propagates", () => {
  const { code } = virtualize(`
    throw 42;
  `);

  let caught;
  try { evalCode(code); } catch (e) { caught = e; }
  expect(caught).toBe(42);
});

test("Variant #3: Throw — Error object propagates", () => {
  const { code } = virtualize(`
    throw new Error("something went wrong");
  `);

  let caught;
  try { evalCode(code); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).toBe("something went wrong");
});

test("Variant #4: Throw — from inside a function", () => {
  const { code } = virtualize(`
    function fail() {
      throw "inner error";
    }
    fail();
  `);

  let caught;
  try { evalCode(code); } catch (e) { caught = e; }
  expect(caught).toBe("inner error");
});

test("Variant #5: Throw — conditional throw, executed branch throws", () => {
  const { code } = virtualize(`
    var x = -1;
    if (x < 0) {
      throw "negative";
    }
    window.TEST_OUTPUT = "ok";
  `);

  let caught;
  try { evalCode(code); } catch (e) { caught = e; }
  expect(caught).toBe("negative");
});

test("Variant #6: Throw — conditional throw, non-executed branch does not throw", () => {
  const { code } = virtualize(`
    var x = 1;
    if (x < 0) {
      throw "negative";
    }
    window.TEST_OUTPUT = "ok";
  `);

  expect(evalCode(code)).toBe("ok");
});

test("Variant #7: Throw — expression is evaluated before throw", () => {
  const { code } = virtualize(`
    var msg = "eval'd";
    throw msg;
  `);

  let caught;
  try { evalCode(code); } catch (e) { caught = e; }
  expect(caught).toBe("eval'd");
});
