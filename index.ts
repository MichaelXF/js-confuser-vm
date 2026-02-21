import { virtualize } from "./src/index.js";
import { readFileSync, writeFileSync } from "fs";

// Compile and write the output to a file
const sourceCode = readFileSync("input.js", "utf-8");
const { code: output } = virtualize(sourceCode);

writeFileSync("output.js", output, "utf-8");
console.log(output);

// Eval the code like our test suite does
var window = { TEST_OUTPUT: null };
eval(output);
console.log(window.TEST_OUTPUT);

// Minify using Google Closure Compiler (optional)
import("./minify.js");
