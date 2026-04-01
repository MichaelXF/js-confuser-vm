import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";
import type * as b from "../../types.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Extract the real statement list from a SwitchCase consequent (identical to the
// helper used by applyMacroOpcodes so the two files stay in sync).
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

// Inline a fixed numeric operand in place of every `this._operand()` call.
// Because specialized opcodes are only created for instructions that have
// *exactly one* numeric operand, every `_operand()` call inside the original
// handler is replaced by the constant value that was baked into the opcode.
function inlineFixedOperand(
  bodyStmts: t.Statement[],
  resolvedValue: number,
): void {
  // Wrap the statements in a temporary BlockStatement so traverse has a root.
  // The replacement mutates the original statement objects in place.
  traverse(t.blockStatement(bodyStmts), {
    noScope: true,
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        t.isMemberExpression(callee) &&
        t.isThisExpression(callee.object) &&
        t.isIdentifier(callee.property, { name: "_operand" }) &&
        path.node.arguments.length === 0
      ) {
        path.replaceWith(t.numericLiteral(resolvedValue));
      }
    },
  });
}

// Append a generated switch case for every entry in compiler.SPECIALIZED_OPS.
// Each case is a clone of the original opcode’s handler with `this._operand()`
// replaced by the constant integer that was captured at compile time.
// Must be called AFTER applyMacroOpcodes (so the original cases exist) but
// BEFORE applyShuffleOpcodes so the new specialized cases also get shuffled.
export function applySpecializedOpcodes(
  ast: t.File,
  bytecode: b.Bytecode,
  compiler: Compiler,
): void {
  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(
    switchStatement,
    "Could not find @SWITCH statement for specialized opcodes",
  );

  // Build a map  opName → SwitchCase  from the existing OP.xxx case tests.
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

  if (!compiler.SPECIALIZED_OPS) return;

  for (const [specialOpStr, info] of Object.entries(compiler.SPECIALIZED_OPS)) {
    const specialOpCode = Number(specialOpStr);
    const { originalOp, operand } = info as {
      originalOp: number;
      operand: number;
    };

    const newName = compiler.OP_NAME[specialOpCode];
    const originalName = compiler.OP_NAME[originalOp];
    if (!originalName) continue;

    const originalCase = nameToCaseMap.get(originalName);
    if (!originalCase) continue;

    // Clone the original handler body
    const bodyStmts: t.Statement[] = extractCaseBody(originalCase).map(
      (s) => t.cloneNode(s, true) as t.Statement,
    );

    const placedOperand = info.resolvedOperand || { resolvedValue: 1337 };
    ok(
      placedOperand !== undefined,
      `Could not find operand for original opcode ${newName}`,
    );

    const resolvedValue =
      (placedOperand as any)?.resolvedValue ?? placedOperand;
    if (typeof resolvedValue !== "number") {
      console.error(resolvedValue);
    }
    ok(typeof resolvedValue === "number", "Expected a numeric operand value");

    // Replace this._operand() with the baked-in constant
    inlineFixedOperand(bodyStmts, resolvedValue);

    // Add a leading comment so the generated source stays readable
    if (bodyStmts.length > 0) {
      t.addComment(
        bodyStmts[0],
        "leading",
        ` ${compiler.OP_NAME[specialOpCode]} (specialized)`,
        true,
      );
    }

    bodyStmts.push(t.breakStatement());

    // Insert the new specialized case into the big switch
    (switchStatement as t.SwitchStatement).cases.push(
      t.switchCase(t.numericLiteral(specialOpCode), [
        t.blockStatement(bodyStmts),
      ]),
    );
  }
}
