import type { Bytecode, InstrOperand, Instruction } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { nextFreeSlot, U16_MAX } from "../utils/op-utils.ts";

// Creates specialized opcodes for the most frequent (OPCODE + single_integer_operand) pairs.
// Example: [OP.LOAD_CONST, 1] becomes [SPECIALIZED_LOAD_CONST_1].
// Only instructions with *exactly one numeric operand* are considered.
// MAKE_CLOSURE and any instruction with zero / multiple operands are skipped.
// Runs after selfModifying but before resolveLabels (operands stay plain numbers).
export function specializedOpcodes(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
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
    { op: number; operand: InstrOperand; count: number }
  >();

  for (const instr of bc) {
    const op = instr[0];
    if (op === null || op === compiler.OP.MAKE_CLOSURE) continue;

    // Must have exactly one operand and it must be a plain number
    if (instr.length !== 2) continue;
    const operand = instr[1];

    const key = `${op},${operand}`;
    const entry = freqMap.get(key);
    if (entry) {
      entry.count++;
    } else {
      freqMap.set(key, { op, operand, count: 1 });
    }
  }

  // ── Step 2: keep combinations that appear >= 2 times, sort by frequency ───
  const candidates = Array.from(freqMap.values())
    .filter((e) => e.count >= 1)
    .sort((a, b) => b.count - a.count);

  if (candidates.length === 0) return { bytecode: bc };

  // ── Step 3: assign free opcode slots to the best candidates ───────────────
  const sigToSpecial = new Map<string, number>();
  const specializedOps: Compiler["SPECIALIZED_OPS"] = {};

  for (let i = 0; i < candidates.length; i++) {
    const specialOp = nextFreeSlot(usedOpcodes);
    if (specialOp === -1) break;
    const { op: originalOp, operand } = candidates[i];

    const key = `${originalOp},${JSON.stringify(operand)}`;
    sigToSpecial.set(key, specialOp);

    specializedOps[specialOp] = { originalOp, operand };

    // Register a human-readable name for disassembly / debugging
    const originalName = compiler.OP_NAME[originalOp] ?? `OP_${originalOp}`;
    compiler.OP_NAME[specialOp] = `${originalName}_${JSON.stringify(operand)}`;
  }

  // Store mapping so the interpreter knows how to dispatch the specialized op
  compiler.SPECIALIZED_OPS = specializedOps;

  // ── Step 4: replace matching instructions with the new single-byte opcode ─
  const result: Bytecode = [];

  for (const instr of bc) {
    const op = instr[0];
    // Only consider instructions with exactly one numeric operand
    if (op === null || instr.length !== 2 || op === compiler.OP.MAKE_CLOSURE) {
      result.push(instr);
      continue;
    }

    const operand = instr[1];
    const key = `${op},${JSON.stringify(operand)}`;

    if (sigToSpecial.has(key)) {
      const specialOpCode = sigToSpecial.get(key)!;

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

      const newInstr: Instruction = [specialOpCode, newOperand];

      // Preserve source-node information for error reporting
      (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];

      result.push(newInstr);
    } else {
      result.push(instr);
    }
  }

  return { bytecode: result };
}
