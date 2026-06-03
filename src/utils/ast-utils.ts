import * as t from "@babel/types";
import traverseImport from "@babel/traverse";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

export function getSwitchStatement(ast: t.File) {
  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  return switchStatement;
}
