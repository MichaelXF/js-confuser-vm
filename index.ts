import JsConfuserVM from "./src/index.ts";
import { readFileSync, writeFileSync } from "fs";

async function main() {
  // Compile and write the output to a file
  const sourceCode = readFileSync("input.js", "utf-8");
  const { code: output } = await JsConfuserVM.obfuscate(sourceCode, {
    minify: true,
    encodeBytecode: true,
    randomizeOpcodes: true,
    selfModifying: true,
    shuffleOpcodes: true,
    timingChecks: true,
  });

  writeFileSync("output.js", output, "utf-8");
  console.log(output);

  // Eval the code like our test suite does
  var window = { TEST_OUTPUT: null };
  eval(output);
  console.log(window.TEST_OUTPUT);

  // Minify using Google Closure Compiler (optional)
  // import("./minify.js");
}

main();
