import type { Bytecode, InstrOperand, Instruction } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { getInstructionSize, nextFreeSlot } from "../../utils/op-utils.ts";

export const nSizedOps = [
  "MAKE_CLOSURE",
  "BUILD_ARRAY",
  "BUILD_OBJECT",
  "CALL",
  "CALL_METHOD",
  "NEW",
];

// Creates specialized opcodes for the most frequent (OPCODE + single_integer_operand) pairs.
// Example: [OP.LOAD_CONST, 1] becomes [SPECIALIZED_LOAD_CONST_1].
// Only instructions that are fixed-sized are considered.
// MAKE_CLOSURE and other N-sized instructions cannot be specialized
// Operands are converted into objects and marked as 'placeholder' - other passes can mutate and the reference stays intact
// We need a reference throughout the pipeline so that final AST generation can place the actual value
// The 'placeholder' flag drops the operand from the final bytecode - any size calculation must not count these
export function specializedOpcodes(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const disallowedOps = new Set(nSizedOps.map((name) => compiler.OP[name]));

  // ── Step 1: count frequency of eligible (op, operand) pairs ───────────────
  const freqMap = new Map<
    string,
    {
      op: number;
      operands: InstrOperand[];
      operandsKey: string;
      occurrences: number;
    }
  >();

  const instrToOperandKey = new WeakMap<Instruction, string>();

  for (const instr of bc) {
    const op = instr[0];
    if (op === null || disallowedOps.has(op)) continue;

    // Only supports between 1-6 operands
    const operandCount = getInstructionSize(instr) - 1;
    if (operandCount < 1 || operandCount > 6) continue;

    // Convert numbers into operand objects so they can be modified elsewhere and preserved
    const oldOperands = instr.slice(1);

    let operands = [];

    for (const operand of oldOperands) {
      if (typeof operand === "number") {
        operands.push({
          type: "number",
          value: operand,
          resolvedValue: operand,
        } as InstrOperand);
      } else {
        operands.push(operand as InstrOperand);
      }
    }

    instr.length = 1;
    instr.push(...operands);

    const operandsKey = JSON.stringify(operands);
    instrToOperandKey.set(instr, operandsKey);

    const key = `${op},${operandsKey}`;
    const entry = freqMap.get(key);
    if (entry) {
      entry.occurrences++;
    } else {
      freqMap.set(key, {
        op,
        operands,
        operandsKey,
        occurrences: 1,
      });
    }
  }

  // ── Step 2: keep combinations that appear >= 2 times, sort by frequency ───
  const candidates = Array.from(freqMap.values())
    .filter((e) => e.occurrences >= 1)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 1000);

  if (candidates.length === 0) return { bytecode: bc };

  // ── Step 3: assign free opcode slots to the best candidates ───────────────
  const sigToSpecial = new Map<string, number>();
  const specializedOps: Compiler["SPECIALIZED_OPS"] = {};
  let opCounts: { [originalOp: number]: number } = {};

  for (const candidate of candidates) {
    if (opCounts[candidate.op] > 3) continue;
    opCounts[candidate.op] = (opCounts[candidate.op] || 0) + 1;

    const specialOp = nextFreeSlot(compiler);
    if (specialOp === -1) break;
    const { op: originalOp, operands, operandsKey } = candidate;

    const key = `${originalOp},${operandsKey}`;
    sigToSpecial.set(key, specialOp);

    specializedOps[specialOp] = { originalOp, operands };

    // Register a human-readable name for disassembly / debugging
    const originalName = compiler.OP_NAME[originalOp] ?? `OP_${originalOp}`;
    compiler.OP_NAME[specialOp] = `${originalName}_${operandsKey}`;
  }

  // Store mapping so the interpreter knows how to dispatch the specialized op
  compiler.SPECIALIZED_OPS = specializedOps;

  // ── Step 4: replace matching instructions with the new single-byte opcode ─
  const result: Bytecode = [];

  for (const instr of bc) {
    const op = instr[0];
    // Only consider instructions with one or more operands
    if (op === null || instr.length <= 1 || op === compiler.OP.MAKE_CLOSURE) {
      result.push(instr);
      continue;
    }

    const operands = instr.slice(1);
    const operandsKey = instrToOperandKey.get(instr);
    if (!operandsKey) {
      result.push(instr);
      continue;
    }

    const key = `${op},${operandsKey}`;

    const specialOpCode = sigToSpecial.get(key)!;

    if (!specialOpCode) {
      result.push(instr);
      continue;
    }

    const newOperands = operands.map((operand) => {
      const operandAsObject: any =
        typeof operand === "object" && operand
          ? operand
          : {
              type: "number",
              resolvedValue: operand,
            };

      operandAsObject.placeholder = true;
      return operandAsObject;
    });

    const newInstr: Instruction = [specialOpCode, ...newOperands];

    // Preserve source-node information for error reporting
    (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];

    result.push(newInstr);
  }

  return { bytecode: result };
}
