import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Extract the real statement list from a SwitchCase consequent.
// (Duplicated from the aliasedOpcodes runtime pass — MVP keeps this standalone.)
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

// Replace each `this._operand()` call with `_operands[i]` (sequential index),
// and rewrite `this._constant()` to take two operand accesses as arguments.
// Returns the number of `_operand()` replacements performed.
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

      const createOperandAccess = () => {
        return t.memberExpression(
          t.identifier("_operands"),
          t.numericLiteral(replaced++),
          true,
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

// Appends a generated switch case for every entry in compiler.ANTI_OPS.
//
// Each anti-op handler:
//   1. Reads all operands eagerly into `_unsortedOperands` (shuffled bytecode
//      order) via sequential this._operand() calls.
//   2. Restores canonical order into `_operands` using the inverse of `order`
//      (identical scheme to applyAliasedOpcodes).
//   3. Executes the cloned body of EACH step (the real op first, then the fake
//      ops) with this._operand() rewired to the corresponding `_operands[i]`.
//      The real step writes a real register; fake steps write fake registers.
//
// Must run AFTER the macro/specialized/aliased runtime passes (so it doesn't
// disturb them) but BEFORE applyShuffleOpcodes (so anti cases are shuffled in).
export function applyAntiInstrumentation(
  ast: t.File,
  compiler: Compiler,
): void {
  if (!compiler.ANTI_OPS || Object.keys(compiler.ANTI_OPS).length === 0) return;

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
    "Could not find @SWITCH statement for anti-instrumentation",
  );

  // opName -> SwitchCase, built from existing `case OP.xxx:` tests.
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

  for (const [antiOpStr, info] of Object.entries(compiler.ANTI_OPS)) {
    const antiOp = Number(antiOpStr);
    const { steps, order } = info;
    const totalArity = order.length;

    // Clone each step's original handler body, wrapped in its own block so the
    // `var dst`/`var a` locals from different steps don't collide lexically.
    const stepBlocks: t.Statement[] = [];
    let missing = false;
    for (const step of steps) {
      const stepName = compiler.OP_NAME[step.op];
      const sc = stepName ? nameToCaseMap.get(stepName) : undefined;
      if (!sc) {
        missing = true;
        break;
      }
      const subStmts = extractCaseBody(sc).map(
        (s) => t.cloneNode(s, true) as t.Statement,
      );

      t.addComment(subStmts[0], "leading", ` ${stepName}`, true);

      stepBlocks.push(...subStmts);
    }
    if (missing) continue;

    // Rewire this._operand() across all step bodies, in canonical order.
    const replaced = replaceOperandCalls(stepBlocks);
    if (replaced !== totalArity) continue; // operand-count mismatch guard

    // _unsortedOperands: read totalArity operands in shuffled bytecode order.
    const unsortedInit = t.variableDeclaration("let", [
      t.variableDeclarator(
        t.identifier("_unsortedOperands"),
        t.arrayExpression(
          Array.from({ length: totalArity }, () =>
            t.callExpression(
              t.memberExpression(t.thisExpression(), t.identifier("_operand")),
              [],
            ),
          ),
        ),
      ),
    ]);

    // inverseOrder[j] = i  where order[i] = j  (operand j lives at unsorted i).
    const inverseOrder = new Array<number>(totalArity);
    for (let i = 0; i < totalArity; i++) {
      inverseOrder[order[i]] = i;
    }

    const operandsInit = t.variableDeclaration("let", [
      t.variableDeclarator(
        t.identifier("_operands"),
        t.arrayExpression(
          inverseOrder.map((idx) =>
            t.memberExpression(
              t.identifier("_unsortedOperands"),
              t.numericLiteral(idx),
              true,
            ),
          ),
        ),
      ),
    ]);

    const allStmts: t.Statement[] = [unsortedInit, operandsInit, ...stepBlocks];

    t.addComment(
      allStmts[0],
      "leading",
      ` ${compiler.OP_NAME[antiOp]} (order: [${order.join(",")}])`,
      true,
    );

    allStmts.push(t.breakStatement());

    (switchStatement as t.SwitchStatement).cases.push(
      t.switchCase(t.numericLiteral(antiOp), [t.blockStatement(allStmts)]),
    );
  }
}
