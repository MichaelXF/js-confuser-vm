import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";
import generate from "@babel/generator";
const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Extract the real statement list from a SwitchCase consequent, normalising
// the two forms that appear in the runtime:
//   • A single wrapping BlockStatement  →  use its .body
//   • Statements listed directly        →  use as-is
// In both cases trailing BreakStatement / EmptyStatement are filtered out.
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

export function getOpcodeToCaseMap(
  switchStatement: t.SwitchStatement,
  compiler: Compiler,
): Map<number, t.SwitchCase> {
  // Build a map  opName → SwitchCase  from the existing OP.xxx case tests.
  const opcodeToCaseMap = new Map<number, t.SwitchCase>();
  for (const sc of (switchStatement as t.SwitchStatement).cases) {
    const test = sc.test;
    if (!test) continue;

    let opcode;
    let opName;
    if (
      t.isMemberExpression(test) &&
      t.isIdentifier(test.object, { name: "OP" }) &&
      t.isIdentifier(test.property)
    ) {
      opName = test.property.name;
      opcode = +Object.keys(compiler.OP_NAME).find(
        (key) => compiler.OP_NAME[key] == opName,
      );
    } else if (t.isNumericLiteral(test)) {
      opcode = test.value;
    }

    ok(
      typeof opcode === "number" && !Number.isNaN(opcode),
      `Failed to parse ${opcode} from ${opName}`,
    );
    if (opcode !== undefined) {
      opcodeToCaseMap.set(opcode, sc);
    }
  }

  return opcodeToCaseMap;
}

// Append a generated switch case for every entry in compiler.MACRO_OPS.
// Each case inlines the constituent case bodies directly — no operand stack,
// no substitution needed.  Because every opcode handler now reads its own
// operands via this._operand(), those calls naturally consume the inline
// operands that macroOpcodes.ts embedded on the macro instruction.
// Must be called BEFORE applyShuffleOpcodes so the new cases get shuffled.
export function applyMacroOpcodes(ast: t.File, compiler: Compiler): void {
  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(switchStatement, "Could not find @SWITCH statement for macro opcodes");

  const opcodeToCaseMap = getOpcodeToCaseMap(switchStatement, compiler);

  for (const [macroOpStr, constituentOps] of Object.entries(
    compiler.MACRO_OPS,
  )) {
    const macroOpCode = Number(macroOpStr);
    const N = constituentOps.length;

    // Resolve each constituent op value → case node via OP_NAME lookup.
    const constituentCases: t.SwitchCase[] = [];
    let allFound = true;
    for (const opVal of constituentOps) {
      const found = opcodeToCaseMap.get(opVal);
      if (!found) {
        allFound = false;
        break;
      }
      constituentCases.push(found);
    }
    if (!allFound) {
      throw new Error(
        `Could not find all constituent ops for macro op ${macroOpCode}`,
      );
    }

    const opNames = constituentOps.map((v) => compiler.OP_NAME[v] ?? `OP_${v}`);
    let newName = opNames.join(",");
    compiler.OP_NAME[macroOpCode] = newName;

    // ── Build the macro case body ──────────────────────────────────────────
    // Clone and inline each sub-instruction's case body directly.
    // No operand substitution needed: each body already calls this._operand()
    // to read its own operands, which will consume the inline operands that
    // macroOpcodes.ts embedded on the macro instruction in order.
    const bodyStmts: t.Statement[] = [];

    for (let i = 0; i < N; i++) {
      const subStmts = extractCaseBody(constituentCases[i]).map(
        (s) => t.cloneNode(s, true) as t.Statement,
      );

      if (subStmts.length > 0) {
        t.addComment(subStmts[0], "leading", ` ${opNames[i]}`, true);
        bodyStmts.push(...subStmts);
      }
    }

    bodyStmts.push(t.breakStatement());

    (switchStatement as t.SwitchStatement).cases.push(
      t.switchCase(t.numericLiteral(macroOpCode), [
        t.blockStatement(bodyStmts),
      ]),
    );
  }
}
