import { Compiler } from "../../src/compiler.ts";
import { obfuscate } from "../test-utils.js";

test("Variant #1: Shuffled Opcodes", async () => {
  const { code } = await obfuscate(
    `
    console.log("Hello world!");
    `,
    {
      shuffleOpcodes: true,
    },
  );

  const { code: defaultCode } = await obfuscate(
    `
    console.log("Hello world!");
    `,
    {},
  );

  const { code: defaultCode2 } = await obfuscate(
    `
    console.log("Hello world!");
    `,
    {},
  );

  const getHandlerOrder = (code) => {
    const re = /case\s+(?:OP\.(\w+)|(\d+))\s*:/g;
    const opcodes = [...code.matchAll(re)].map((m) => m[1] ?? m[2]);
    return opcodes;
  };

  var defaultOrder = getHandlerOrder(defaultCode);
  var defaultOrder2 = getHandlerOrder(defaultCode2);
  var order = getHandlerOrder(code);

  // There should be a difference within first 20 opcodes
  expect(order.slice(0, 20)).not.toEqual(defaultOrder.slice(0, 20));

  // The order should be the same between defaultCode and defaultCode2 first 20 opcodes
  expect(defaultOrder.slice(0, 20)).toEqual(defaultOrder2.slice(0, 20));
});
