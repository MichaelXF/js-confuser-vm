import type { Bytecode, InstrOperand, Instruction } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import {
  getInstructionSize,
  nextFreeSlot,
  U16_MAX,
} from "../../utils/op-utils.ts";

// Creates specialized opcodes for the most frequent (OPCODE + single_integer_operand) pairs.
// Example: [OP.LOAD_CONST, 1] becomes [SPECIALIZED_LOAD_CONST_1].
// Only instructions with *exactly one numeric operand* are considered.
// MAKE_CLOSURE and other N-sized instructions cannot be specialized
// Runs after selfModifying but before resolveLabels (operands stay plain numbers).
export function specializedOpcodes(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const disallowedOps = new Set([
    compiler.OP.MAKE_CLOSURE,
    compiler.OP.BUILD_ARRAY,
    compiler.OP.BUILD_OBJECT,
    compiler.OP.CALL,
    compiler.OP.CALL_METHOD,
    compiler.OP.NEW,
  ]);

  // ── Collect used opcodes exactly as specified ─────────────────────────────
  const usedOpcodes = new Set<number>(
    Object.keys(compiler.OP_NAME)
      .map((k) => parseInt(k, 10))
      .filter((v) => !isNaN(v)) as number[],
  );

  if (usedOpcodes.size > U16_MAX) return { bytecode: bc };

  // ── Step 1: count frequency of eligible (op, operand) pairs ───────────────
  const freqMap = new Map<
    string,
    {
      op: number;
      operands: InstrOperand[];
      operandsKey: string;
      occurences: number;
    }
  >();

  for (const instr of bc) {
    const op = instr[0];
    if (op === null || disallowedOps.has(op)) continue;

    // Only supports between 1-6 operands
    const operandCount = getInstructionSize(instr) - 1;
    if (operandCount < 1 || operandCount > 6) continue;

    const operands = instr.slice(1);
    const operandsKey = JSON.stringify(operands);

    const key = `${op},${operandsKey}`;
    const entry = freqMap.get(key);
    if (entry) {
      entry.occurences++;
    } else {
      freqMap.set(key, { op, operands, operandsKey, occurences: 1 });
    }
  }

  // ── Step 2: keep combinations that appear >= 2 times, sort by frequency ───
  const candidates = Array.from(freqMap.values())
    .filter((e) => e.occurences >= 1)
    .sort((a, b) => b.occurences - a.occurences);

  if (candidates.length === 0) return { bytecode: bc };

  // ── Step 3: assign free opcode slots to the best candidates ───────────────
  const sigToSpecial = new Map<string, number>();
  const specializedOps: Compiler["SPECIALIZED_OPS"] = {};

  for (let i = 0; i < candidates.length; i++) {
    const specialOp = nextFreeSlot(usedOpcodes);
    if (specialOp === -1) break;
    const { op: originalOp, operands, operandsKey } = candidates[i];

    const key = `${originalOp},${operandsKey}`;
    sigToSpecial.set(key, specialOp);

    specializedOps[specialOp] = { originalOp, operands };

    // Register a human-readable name for disassembly / debugging
    const originalName = compiler.OP_NAME[originalOp] ?? `OP_${originalOp}`;
    compiler.OP_NAME[specialOp] =
      `${originalName}_${JSON.stringify(operandsKey)}`;
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
    const operandsKey = JSON.stringify(operands);

    const key = `${op},${operandsKey}`;

    const specialOpCode = sigToSpecial.get(key)!;

    if (!specialOpCode) {
      result.push(instr);
      continue;
    }

    const newOperands = operands.map((operand) => {
      const operandAsObject =
        typeof operand === "object" && operand
          ? operand
          : {
              type: "number",
              value: operand,
              resolvedValue: operand,
            };

      const newOperand = {
        ...operandAsObject,
        placeholder: true,
      } as any as InstrOperand;

      return newOperand;
    });

    const newInstr: Instruction = [specialOpCode, ...newOperands];

    // Preserve source-node information for error reporting
    (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];

    result.push(newInstr);
  }

  return { bytecode: result };
}
