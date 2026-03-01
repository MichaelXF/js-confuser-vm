import JsConfuserVM from "../../src";
import { obfuscate, evalCode } from "../test-utils";

test("Variant #1: Pre/Post increment and decrement", async () => {
  const { code } = await obfuscate(`
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

  expect(await evalCode(code)).toEqual([2, 3, 2, 1, 1, 0, 1]);
});
