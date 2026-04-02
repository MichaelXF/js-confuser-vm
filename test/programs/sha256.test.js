import { readFileSync } from "fs";
import { obfuscate, evalCode } from "../test-utils.js";
import { join } from "path";

const sourceCode = readFileSync(
  join(import.meta.dirname, "./sha256.js"),
  "utf-8",
);

test("Variant #1: Obfuscate sha256.js", async () => {
  const { code } = await obfuscate(sourceCode);

  var module = { exports: {} };
  await evalCode(code, { module });

  /**
   * @type {import('./sha256.js')}
   */
  var sha256 = module.exports;

  expect(Object.keys(sha256)).toEqual([
    "hex",
    "b64",
    "any",
    "hex_hmac",
    "b64_hmac",
    "any_hmac",
  ]);

  expect(sha256.hex("Hello World!")).toEqual(
    "7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
  );
  expect(sha256.hex("Another SHA256")).toEqual(
    "846cf19f7bbbe6039a261bb17b693d27a77562843491bb9c053ba3b01921c10f",
  );
});
