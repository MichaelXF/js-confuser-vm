import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";

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

// Replace every `this._operand()` call in bodyStmts with `_operands[i]`
// where i is the call's sequential index (0-based).
// Returns the number of replacements performed.
function replaceOperandCalls(bodyStmts: t.Statement[]): number {
  let replaced = 0;

  traverse(t.blockStatement(bodyStmts), {
    noScope: true,
    CallExpression(path) {
      const callee = path.node.callee;

      const isMethodCall = (methodName) => {
        return (
          t.isMemberExpression(callee) &&
          t.isThisExpression(callee.object) &&
          t.isIdentifier(callee.property, { name: methodName }) &&
          path.node.arguments.length === 0
        );
      };

      // Replace with _operands[i]
      const createOperandAccess = () => {
        return t.memberExpression(
          t.identifier("_operands"),
          t.numericLiteral(replaced++),
          true, // computed
        );
      };

      if (isMethodCall("_operand")) {
        path.replaceWith(createOperandAccess());
      }

      if (isMethodCall("_constant")) {
        path.node.arguments = [createOperandAccess(), createOperandAccess()];
      }
    },
  });

  return replaced;
}

// Appends a generated switch case for every entry in compiler.ALIASED_OPS.
// Each alias case:
//   1. Reads all operands eagerly into `_unsortedOperands` (in the shuffled
//      bytecode order) via sequential this._operand() calls.
//   2. Restores the original operand order into `_operands` using the INVERSE
//      of the stored `order` permutation:
//        inverseOrder[order[i]] = i
//        _operands[j] = _unsortedOperands[inverseOrder[j]]
//      This is necessary because the bytecode stored originalOperands[order[i]]
//      at slot i, so recovering originalOperands[j] requires the inverse lookup.
//   3. Executes a clone of the original handler body where every
//      this._operand() has been replaced by the corresponding `_operands[i]`.
//
// Must run AFTER applyMacroOpcodes / applySpecializedOpcodes (so original
// cases already exist) but BEFORE applyShuffleOpcodes (so the new alias
// cases are also shuffled into the handler order).
export function applyAliasedOpcodes(ast: t.File, compiler: Compiler): void {
  if (!compiler.ALIASED_OPS || Object.keys(compiler.ALIASED_OPS).length === 0)
    return;

  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(switchStatement, "Could not find @SWITCH statement for aliased opcodes");

  // Build opName → SwitchCase map from existing OP.xxx case tests.
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

  for (const [aliasOpStr, info] of Object.entries(compiler.ALIASED_OPS)) {
    const aliasOpCode = Number(aliasOpStr);
    const { originalOp, order } = info;
    const arity = order.length;

    const originalName = compiler.OP_NAME[originalOp];
    if (!originalName) continue;

    const originalCase = nameToCaseMap.get(originalName);
    if (!originalCase) continue;

    // Clone the original handler body (deep clone so we don't mutate the source)
    const bodyStmts: t.Statement[] = extractCaseBody(originalCase).map(
      (s) => t.cloneNode(s, true) as t.Statement,
    );

    // Replace this._operand() calls with _operands[i]
    const replaced = replaceOperandCalls(bodyStmts);

    // If the handler has a different number of _operand() calls than our
    // recorded arity, skip this alias (variable-operand handler guard).
    if (replaced !== arity) continue;

    // Build: var _unsortedOperands = [this._operand(), this._operand(), ...]
    // Reads operands in the NEW (shuffled) bytecode order.
    const unsortedInit = t.variableDeclaration("let", [
      t.variableDeclarator(
        t.identifier("_unsortedOperands"),
        t.arrayExpression(
          Array.from({ length: arity }, () =>
            t.callExpression(
              t.memberExpression(t.thisExpression(), t.identifier("_operand")),
              [],
            ),
          ),
        ),
      ),
    ]);

    // The inverse permutation maps original position j → unsorted index i,
    // because the bytecode stored originalOperands[order[i]] at slot i.
    // inverseOrder[j] = i  means: original operand j lives at _unsortedOperands[i]
    const inverseOrder = new Array<number>(arity);
    for (let i = 0; i < arity; i++) {
      inverseOrder[order[i]] = i;
    }

    // Build: var _operands = [_unsortedOperands[inverseOrder[0]], ...]
    // Restores the original operand order expected by the handler body.
    const operandsInit = t.variableDeclaration("let", [
      t.variableDeclarator(
        t.identifier("_operands"),
        t.arrayExpression(
          inverseOrder.map((idx) =>
            t.memberExpression(
              t.identifier("_unsortedOperands"),
              t.numericLiteral(idx),
              true, // computed
            ),
          ),
        ),
      ),
    ]);

    const allStmts: t.Statement[] = [unsortedInit, operandsInit, ...bodyStmts];

    // Add a leading comment for readability in non-minified output
    t.addComment(
      allStmts[0],
      "leading",
      ` ${compiler.OP_NAME[aliasOpCode]} (order: [${order.join(",")}])`,
      true,
    );

    allStmts.push(t.breakStatement());

    (switchStatement as t.SwitchStatement).cases.push(
      t.switchCase(t.numericLiteral(aliasOpCode), [t.blockStatement(allStmts)]),
    );
  }
}
