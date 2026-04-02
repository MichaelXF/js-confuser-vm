import { evalCode, obfuscate } from "../test-utils";

test("Variant #1: Macro Opcodes", async () => {
  var { code: output } = await obfuscate(
    `
    var counter = 0;
    function increment(){
      counter++;
    }
    function myFunction(){
      increment();
      increment();
      increment();

      window.TEST_OUTPUT = counter;
    }

    myFunction();
    `,
    {
      macroOpcodes: true,
    },
  );

  var bytecodeCommentSection = output.split("var CONSTANTS")[0];
  expect(bytecodeCommentSection).toContain(" LOAD_UPVALUE,CALL ");

  var result = await evalCode(output);
  expect(result).toEqual(3);
});
