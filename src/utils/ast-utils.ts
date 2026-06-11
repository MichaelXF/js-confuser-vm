import * as t from "@babel/types";
import traverseImport from "@babel/traverse";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Recursively visits every statement reachable from `stmts` within the current
// function scope — traversing into blocks, if branches, loop bodies, switch
// cases, try/catch/finally, and labeled statements — but never crossing into
// nested FunctionDeclaration/FunctionExpression bodies (those are separate scopes).
//
// `visit` is called for each statement before its children are traversed.
// ForStatement init and ForInStatement left VariableDeclarations are also
// passed to `visit` so callers don't need to special-case them.
export function walkHoistScope(
  stmts: t.Statement[],
  visit: (stmt: t.Statement) => void,
): void {
  for (const stmt of stmts) {
    visit(stmt);
    switch (stmt.type) {
      case "BlockStatement":
        walkHoistScope(stmt.body, visit);
        break;

      case "IfStatement": {
        const cons =
          stmt.consequent.type === "BlockStatement"
            ? (stmt.consequent as t.BlockStatement).body
            : [stmt.consequent];
        walkHoistScope(cons, visit);
        if (stmt.alternate) {
          const alt =
            stmt.alternate.type === "BlockStatement"
              ? (stmt.alternate as t.BlockStatement).body
              : [stmt.alternate];
          walkHoistScope(alt, visit);
        }
        break;
      }

      case "WhileStatement":
      case "DoWhileStatement": {
        const body =
          stmt.body.type === "BlockStatement"
            ? (stmt.body as t.BlockStatement).body
            : [stmt.body];
        walkHoistScope(body, visit);
        break;
      }

      case "ForStatement": {
        if (stmt.init?.type === "VariableDeclaration")
          visit(stmt.init as t.Statement);
        const body =
          stmt.body.type === "BlockStatement"
            ? (stmt.body as t.BlockStatement).body
            : [stmt.body];
        walkHoistScope(body, visit);
        break;
      }

      case "ForInStatement": {
        if (stmt.left.type === "VariableDeclaration")
          visit(stmt.left as t.Statement);
        const body =
          stmt.body.type === "BlockStatement"
            ? (stmt.body as t.BlockStatement).body
            : [stmt.body];
        walkHoistScope(body, visit);
        break;
      }

      case "SwitchStatement":
        for (const c of stmt.cases) walkHoistScope(c.consequent, visit);
        break;

      case "TryStatement":
        walkHoistScope(stmt.block.body, visit);
        if (stmt.handler) walkHoistScope(stmt.handler.body.body, visit);
        if (stmt.finalizer) walkHoistScope(stmt.finalizer.body, visit);
        break;

      case "LabeledStatement":
        walkHoistScope([stmt.body], visit);
        break;
    }
  }
}

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
