import { readFileSync } from "fs";
import { obfuscate, evalCode } from "../test-utils.js";
import { join } from "path";

const sourceCode = readFileSync(
  join(import.meta.dirname, "./cash.js"),
  "utf-8",
);

test("Variant #1: Obfuscate cash.js", async () => {
  const { code } = await obfuscate(sourceCode);

  var document = {
    documentElement: {},
    createElement: () => {
      return { style: {} };
    },
  };

  var module = { exports: {} };
  var window = { document, module };
  var global = window;

  for (const globalName of Object.getOwnPropertyNames(globalThis)) {
    window[globalName] = globalThis[globalName];
  }

  eval(code);

  /**
   * @type {import('./cash.js')}
   */
  var cash = window.cash;

  expect(typeof cash).toEqual("function");
  expect(Object.keys(cash)).toEqual([
    "fn",
    "isWindow",
    "isFunction",
    "isArray",
    "isNumeric",
    "isPlainObject",
    "each",
    "extend",
    "parseHTML",
    "guid",
    "unique",
  ]);
});
