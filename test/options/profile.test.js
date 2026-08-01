import { evalCode, obfuscate } from "../test-utils.js";

test("Variant #1: Profile option enabled", async () => {
  const sourceCode = `
  function testFunction(){
    var sum = 10 + 20 + 30;
    if (true) {
      window.TEST_OUTPUT = sum;
    }
  }

  testFunction();
  `;

  const { code, profileData } = await obfuscate(sourceCode, {
    target: "node",
    randomizeOpcodes: true, // randomize the opcode numbers?
    shuffleOpcodes: true, // shuffle order of opcode handlers in the runtime?
    encodeBytecode: true, // encode bytecode? when off, comments for instructions are added
    macroOpcodes: true, // create combined opcodes for repeated instruction sequences?
    profile: true,
  });

  expect(typeof profileData.compileTime).toStrictEqual("number");
  expect(typeof profileData.generateTime).toStrictEqual("number");
  expect(typeof profileData.handlerCount).toStrictEqual("number");
  expect(typeof profileData.inputFileSize).toStrictEqual("number");
  expect(typeof profileData.outputFileSize).toStrictEqual("number");
  expect(typeof profileData.parseTime).toStrictEqual("number");
  expect(typeof profileData.transforms).toStrictEqual("object");
  expect(
    typeof profileData.transforms["macroOpcodes"].bytecodeSize,
  ).toStrictEqual("number");
  expect(
    typeof profileData.transforms["macroOpcodes"].bytecodeCounts,
  ).toStrictEqual("object");
  expect(
    typeof profileData.transforms["macroOpcodes"].bytecodeCounts["number"],
  ).toStrictEqual("number");
  expect(
    typeof profileData.transforms["macroOpcodes"].transformTime,
  ).toStrictEqual("number");
  expect(
    typeof profileData.transforms["applyMacroOpcodes"].fileSize,
  ).toStrictEqual("number");
  expect(
    typeof profileData.transforms["applyMacroOpcodes"].handlerCount,
  ).toStrictEqual("number");
  expect(
    typeof profileData.transforms["macroOpcodes"].transformTime,
  ).toStrictEqual("number");

  const TEST_OUTPUT = await evalCode(sourceCode);

  expect(TEST_OUTPUT).toStrictEqual(60);
});
