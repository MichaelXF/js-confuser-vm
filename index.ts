import JsConfuserVM from "./src/index.ts";
import { readFileSync, writeFileSync } from "fs";

async function main() {
  // Compile and write the output to a file
  const sourceCode = readFileSync("input.js", "utf-8");

  const { code: orginalOutput } = await JsConfuserVM.obfuscate(sourceCode, {});

  const { code: output } = await JsConfuserVM.obfuscate(sourceCode, {
    target: "browser", // or "node"
    // randomizeOpcodes: true, // randomize the opcode numbers?
    // shuffleOpcodes: true, // shuffle order of opcode handlers in the runtime?
    // encodeBytecode: true, // encode bytecode? when off, comments for instructions are added
    // selfModifying: true, // do self-modifying bytecode for function bodies?
    // macroOpcodes: true, // create combined opcodes for repeated instruction sequences?
    // specializedOpcodes: true, // create specialized opcodes for commonly used opcode+operand pairs?
    // timingChecks: true, // add timing checks to detect debuggers?
    // minify: true, // pass final output through Google Closure Compiler? (
  });

  writeFileSync("output.original.js", orginalOutput, "utf-8");
  writeFileSync("output.js", output, "utf-8");

  // Eval the code like our test suite does
  var window = { TEST_OUTPUT: null };
  eval(output);
  console.log(window.TEST_OUTPUT);

  // Minify using Google Closure Compiler (optional)
  // import("./minify.js");
}

main();
