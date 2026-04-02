import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import * as t from "@babel/types";
import { ok } from "assert";
import { Compiler, VM_RUNTIME, SOURCE_NODE_SYM } from "../../compiler.ts";
import type { Bytecode, Instruction } from "../../types.ts";
import { nextFreeSlot } from "../../utils/op-utils.ts";
import { nSizedOps } from "./specializedOpcodes.ts";
import generate from "@babel/generator";

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

// Count how many IR-level operands a single statement consumes.
// Returns null if the statement is ineligible (contains a loop, or has
// _operand()/_constant() calls inside a conditional branch).
function countStatementOperands(stmt: t.Statement): number | null {
  let count = 0;
  let ineligible = false;

  const file = t.file(t.program([t.cloneNode(stmt, true) as t.Statement]));

  traverse(file, {
    enter(path) {
      if (ineligible) {
        path.stop();
        return;
      }

      const nodeType = path.node.type;

      // Don't traverse into nested functions
      if (
        nodeType === "FunctionDeclaration" ||
        nodeType === "FunctionExpression" ||
        nodeType === "ArrowFunctionExpression"
      ) {
        path.skip();
        return;
      }

      // Count _operand() and _constant() calls
      if (nodeType === "CallExpression") {
        const call = path.node as t.CallExpression;
        const callee = call.callee;
        if (
          t.isMemberExpression(callee) &&
          t.isThisExpression(callee.object) &&
          t.isIdentifier(callee.property)
        ) {
          const name = (callee.property as t.Identifier).name;
          const operandsConsumed =
            name === "_operand" ? 1 : name === "_constant" ? 2 : null;

          if (operandsConsumed) {
            // You are not allowed to use _operand() in loops or branches
            const ancestors = path.getAncestry();

            if (
              ancestors.find(
                (t) =>
                  t.isLoop() ||
                  t.isIfStatement() ||
                  t.isSwitchStatement() ||
                  t.isConditionalExpression() ||
                  t.isLogicalExpression(),
              )
            ) {
              ineligible = true;
              path.stop();
              return;
            }

            count += operandsConsumed;
          }
        }
      }
    },
  });

  return ineligible ? null : count;
}

// Analyse the VM runtime's @SWITCH statement to build a per-opcode map of
// { stmtIndex → irOperandCount } for every case that can be split.
// Returns a map: opValue → array of per-statement operand counts (null if ineligible).
function analyzeRuntimeCases(compiler: Compiler): Map<number, number[]> {
  // Parse the runtime source
  const ast = parse(VM_RUNTIME, { sourceType: "unambiguous" });

  // Build reverse name→opValue map from original OPs only
  const nameToOp = new Map<string, number>();
  for (const [name, val] of Object.entries(compiler.OP)) {
    if (val !== undefined) nameToOp.set(name, val as number);
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

  const result = new Map<number, number[]>();

  for (const sc of (switchStatement as t.SwitchStatement).cases) {
    const test = sc.test;
    if (
      !test ||
      !t.isMemberExpression(test) ||
      !t.isIdentifier(test.object, { name: "OP" }) ||
      !t.isIdentifier(test.property)
    ) {
      continue;
    }

    const opName = (test.property as t.Identifier).name;
    const opVal = nameToOp.get(opName);
    if (opVal === undefined) continue;

    const stmts = extractCaseBody(sc);
    if (stmts.length < 2) continue; // need at least 2 statements to split

    const counts: number[] = [];
    let allEligible = true;

    // Banned patterns:
    // Return statements (Control flow isn't remembered)
    traverse(t.file(t.program(stmts)), {
      ReturnStatement(path) {
        path.stop();
        allEligible = false;
      },
    });

    for (const stmt of stmts) {
      const c = countStatementOperands(stmt);
      if (c === null) {
        allEligible = false;
        break;
      }
      if (t.isDebuggerStatement(stmt) || t.isThrowStatement(stmt)) {
        allEligible = false;
        break;
      }
      counts.push(c);
    }

    if (!allEligible) continue;

    // Verify that the total operand count matches the instruction size expectation
    // (just store for now; bytecode pass validates operands match)
    result.set(opVal, counts);
  }

  return result;
}

// Main bytecode transform: split frequently-used opcodes into per-statement
// micro-opcodes so each sub-instruction is as small as possible.
export function microOpcodes(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // ── Step 1: analyse runtime to discover splittable opcodes ──────────────────
  const opAnalysis = analyzeRuntimeCases(compiler);
  if (opAnalysis.size === 0) return { bytecode: bc };

  // ── Step 2: count opcode frequency in bytecode ────────────────────────────
  const disallowedOps = new Set(nSizedOps.map((name) => compiler.OP[name]));

  disallowedOps.add(compiler.OP.RETURN);

  const freqMap = new Map<number, number>();
  for (const instr of bc) {
    const op = instr[0];
    if (op === null || !opAnalysis.has(op) || disallowedOps.has(op)) continue;
    freqMap.set(op, (freqMap.get(op) ?? 0) + 1);
  }

  // ── Step 3: sort by frequency, keep opcodes that actually appear ─────────
  const candidates = Array.from(freqMap.entries())
    .filter(([, count]) => count >= 1)
    .sort(([, a], [, b]) => b - a)
    .map(([op]) => op);

  if (candidates.length === 0) return { bytecode: bc };

  // ── Step 4: assign free opcode slots for each sub-statement ─────────────
  // Build: originalOp → [{ microOp, irOperandCount }, ...]
  const originalToSubOps = new Map<
    number,
    { microOp: number; irOperandCount: number }[]
  >();

  for (const origOp of candidates) {
    const stmtCounts = opAnalysis.get(origOp)!;

    // Pre-allocate all needed slots; if any slot is unavailable, skip this op.
    const slots: number[] = [];
    for (let si = 0; si < stmtCounts.length; si++) {
      const slot = nextFreeSlot(compiler);
      if (slot === -1) break;

      compiler.OP_NAME[slot] = `MICRO_${origOp}_${si}`;
      slots.push(slot);
    }
    if (slots.length !== stmtCounts.length) continue;

    const subOps: { microOp: number; irOperandCount: number }[] = [];
    const origName = compiler.OP_NAME[origOp] ?? `OP_${origOp}`;

    for (let si = 0; si < stmtCounts.length; si++) {
      const microOp = slots[si];
      const irOperandCount = stmtCounts[si];
      subOps.push({ microOp, irOperandCount });

      compiler.OP_NAME[microOp] = `MICRO_${origName}_${si}`;
      compiler.MICRO_OPS[microOp] = {
        originalOp: origOp,
        stmtIndex: si,
        irOperandCount,
      };
    }

    originalToSubOps.set(origOp, subOps);
  }

  if (originalToSubOps.size === 0) return { bytecode: bc };

  // ── Step 5: replace each matched instruction with sub-instructions ────────
  const result: Bytecode = [];

  for (const instr of bc) {
    const op = instr[0];
    if (op === null || !originalToSubOps.has(op)) {
      result.push(instr);
      continue;
    }

    const subOps = originalToSubOps.get(op)!;
    const operands = instr.slice(1); // all operands of the original instruction

    // Verify total operand count matches sum of sub-op IR operand counts
    const expectedTotal = subOps.reduce(
      (s, { irOperandCount }) => s + irOperandCount,
      0,
    );
    if (operands.length !== expectedTotal) {
      throw new Error(
        `Operand count mismatch for opcode ${compiler.OP_NAME[op]}`,
      );
    }

    // Split operands among sub-instructions
    let offset = 0;
    for (const { microOp, irOperandCount } of subOps) {
      const subOperands = operands.slice(offset, offset + irOperandCount);
      offset += irOperandCount;

      const newInstr: Instruction = [microOp, ...subOperands];
      // Carry source-node info on the first sub-instruction
      if (offset === irOperandCount) {
        (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
      }

      result.push(newInstr);
    }
  }

  return { bytecode: result };
}
