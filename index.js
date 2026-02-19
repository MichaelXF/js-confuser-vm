// ─────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────

const { writeFileSync, readFileSync } = require("fs");
const { compileAndSerialize } = require("./src/compiler");

// ── Input ────────────────────────────────────────────────────────
const SOURCE = readFileSync("input.js", "utf-8");

const output = compileAndSerialize(SOURCE);

console.log("// ════════════════════════════════════════════");
console.log("// VM output — compiled from:");

writeFileSync("output.js", output, "utf-8");

console.log("// ════════════════════════════════════════════\n");
console.log(output);

eval(output);

// require("./minify");
