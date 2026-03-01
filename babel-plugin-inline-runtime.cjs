const { readFileSync } = require("fs");
const { join } = require("path");
const babel = require("@babel/core");
const { stripTypeScriptTypes } = require("node:module");

module.exports = function inlineRuntimePlugin({ types: t }) {
  const rawContent = readFileSync(join(__dirname, "./src/runtime.ts"), "utf-8");

  const runtimeContent = stripTypeScriptTypes(rawContent);

  return {
    name: "inline-runtime",
    visitor: {
      VariableDeclarator(path) {
        if (
          path.node.id?.name === "readVMRuntimeFile" &&
          (path.node.init?.type === "ArrowFunctionExpression" ||
            path.node.init?.type === "FunctionExpression")
        ) {
          path.node.init = t.arrowFunctionExpression(
            [],
            t.stringLiteral(runtimeContent),
          );
        }
      },
      ImportDeclaration(path) {
        const src = path.node.source.value;
        if (src === "fs" || src === "path") {
          path.remove();
        }
      },
    },
  };
};
