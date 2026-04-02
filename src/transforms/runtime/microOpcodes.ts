import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";
import { applyInternalVariablesToSwitchCase } from "./internalVariables.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Extract the real statement list from a SwitchCase consequent.
function extractCaseBody(switchCase: t.SwitchCase): t.Statement[] {
  let stmts: t.Statement[];
  if (
    switchCase.consequent.length === 1 &&
    t.isBlockStatement(switchCase.consequent[0])
  ) {
    stmts = (switchCase.consequent[0] as t.BlockStatement).body;
  } else {
    stmts = switchCase.consequent as t.Statement[];
  }
  return stmts.filter((s) => !t.isBreakStatement(s) && !t.isEmptyStatement(s));
}

// Append a generated switch case for every entry in compiler.MICRO_OPS.
// applyInteralVariablesToRuntime must run before this so that the source
// case bodies are already using this._internals[index] instead of local vars.
// Must be called BEFORE applyShuffleOpcodes so the new cases get shuffled.
export function applyMicroOpcodes(ast: t.File, compiler: Compiler): void {
  if (!compiler.MICRO_OPS || Object.keys(compiler.MICRO_OPS).length === 0) {
    return;
  }

  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(switchStatement, "Could not find @SWITCH statement for micro opcodes");

  // Build  opName → SwitchCase  from existing cases.
  const nameToCaseMap = new Map<string, t.SwitchCase>();
  for (const sc of (switchStatement as t.SwitchStatement).cases) {
    const test = sc.test;
    if (
      test &&
      t.isMemberExpression(test) &&
      t.isIdentifier(test.object, { name: "OP" }) &&
      t.isIdentifier(test.property)
    ) {
      nameToCaseMap.set((test.property as t.Identifier).name, sc);
    }
  }

  for (const [microOpStr, info] of Object.entries(compiler.MICRO_OPS)) {
    const microOpCode = Number(microOpStr);
    const { originalOp, stmtIndex } = info;

    const originalName = compiler.OP_NAME[originalOp];
    if (!originalName) continue;

    const originalCase = nameToCaseMap.get(originalName);
    if (!originalCase) continue;

    // Extract and clone all non-break statements from the original case body.
    const allStmts = extractCaseBody(originalCase);
    if (stmtIndex >= allStmts.length) continue;

    const rawStmt = t.cloneNode(allStmts[stmtIndex], true) as t.Statement;

    const newCase = t.switchCase(t.numericLiteral(microOpCode), [
      t.blockStatement([rawStmt, t.breakStatement()]),
    ]);

    // Apply internal-variable substitution — this may replace rawStmt in the
    // block body (var decl → assignment), so add the comment afterwards on
    // whatever the first statement of the block actually is.
    applyInternalVariablesToSwitchCase(newCase, compiler, microOpCode);

    const blockBody = (newCase.consequent[0] as t.BlockStatement).body;
    const firstStmt = blockBody[0];
    if (firstStmt) {
      const microName = compiler.OP_NAME[microOpCode] ?? `MICRO_${microOpCode}`;
      t.addComment(firstStmt, "leading", ` ${microName}`, true);
    }

    (switchStatement as t.SwitchStatement).cases.push(newCase);
  }
}
