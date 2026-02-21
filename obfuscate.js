import JsConfuser from "../js-confuser/dist/index.js";
import { readFileSync, writeFileSync } from "fs";

const minified = readFileSync("output.min.js", "utf-8");

JsConfuser.obfuscate(minified, {
  target: "browser",
  renameVariables: true,
  controlFlowFlattening: true,
}).then((result) => {
  writeFileSync("output.obf.js", result.code, "utf-8");
});
