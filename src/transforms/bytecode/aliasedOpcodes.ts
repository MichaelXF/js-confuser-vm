import type { Bytecode, InstrOperand, Instruction } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { nextFreeSlot, U16_MAX } from "../../utils/op-utils.ts";
import { shuffle } from "../../utils/random-utils.ts";

// Opcodes that must not be aliased.
// Variable-length operand opcodes cannot be statically aliased since the
// number of this._operand() calls varies at runtime.
// Infrastructure opcodes (PATCH, TRY_SETUP, TRY_END, DEBUGGER) are excluded
// because aliasing them would interfere with self-modifying bytecode and
// exception-handling machinery.
const DISALLOWED_OP_NAMES = new Set([
  "MAKE_CLOSURE",
  "BUILD_ARRAY",
  "BUILD_OBJECT",
  "CALL",
  "CALL_METHOD",
  "NEW",
  "PATCH",
  "TRY_SETUP",
  "TRY_END",
  "DEBUGGER",
]);

// Creates aliased opcodes: duplicate handlers for commonly-used opcodes,
// optionally with a permuted operand read order in the bytecode stream.
//
// For each aliased op, we record an `order` permutation of length `arity`.
// order[i] = j means: bytecode slot i holds what was originally operand j.
//
// Example: LOAD_GLOBAL [dst, nameIdx] with order=[1,0]:
//   Bytecode stores:  [ALIAS_OP, nameIdx, dst]
//   Handler reads:    _unsortedOperands = [nameIdx, dst]
//                     _operands = [_unsortedOperands[1], _unsortedOperands[0]]
//                               = [dst, nameIdx]   ← original order restored
//
// Runs LAST among bytecode transforms (after selfModifying), before resolveLabels.
export function aliasedOpcodes(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // Build a map of base opcode value → name, excluding disallowed ops
  const baseOpValueToName = new Map<number, string>();
  for (const [name, val] of Object.entries(compiler.OP)) {
    if (DISALLOWED_OP_NAMES.has(name)) continue;
    baseOpValueToName.set(val as number, name);
  }

  // Collect all currently used opcode slots (base + any dynamically assigned)
  const usedOpcodes = new Set<number>(
    Object.keys(compiler.OP_NAME)
      .map((k) => parseInt(k, 10))
      .filter((v) => !isNaN(v)),
  );

  if (usedOpcodes.size > U16_MAX) return { bytecode: bc };

  // ── Step 1: count frequency and determine arity for each eligible base opcode ─
  // We scan the actual post-transform bytecode so frequency reflects what's
  // really left (specialized/macro ops already consumed their share).
  const opStats = new Map<number, { freq: number; arity: number | null }>();

  for (const instr of bc) {
    const op = instr[0];
    if (op === null || !baseOpValueToName.has(op)) continue;

    const arity = instr.length - 1;
    if (arity < 1) continue; // 0-operand opcodes have nothing to permute

    const existing = opStats.get(op);
    if (!existing) {
      opStats.set(op, { freq: 1, arity });
    } else {
      if (existing.arity !== arity) {
        // Inconsistent arity → variable-length; skip
        existing.arity = null;
      }
      existing.freq++;
    }
  }

  // ── Step 2: sort by frequency descending, keep only consistent-arity ops ────
  const candidates = Array.from(opStats.entries())
    .filter(([, s]) => s.arity !== null)
    .sort(([, a], [, b]) => b.freq - a.freq);

  if (candidates.length === 0) return { bytecode: bc };

  // ── Step 3: assign free slots, build order permutations ─────────────────────
  // aliasMap: originalOp → aliasOp (only the winning alias per original op)
  const aliasMap = new Map<number, number>();
  const aliasedOps: Compiler["ALIASED_OPS"] = {};

  for (const [originalOp, stats] of candidates) {
    const aliasOp = nextFreeSlot(usedOpcodes);
    if (aliasOp === -1) break;

    const arity = stats.arity!;

    // Build a permutation of [0 .. arity-1].
    // For arity >= 2: shuffle until we get a non-identity permutation so the
    // operand order is actually different (makes the alias more confusing).
    // For arity == 1: only one permutation exists ([0]); still useful as a clone.
    let order: number[];
    if (arity >= 2) {
      const identity = Array.from({ length: arity }, (_, i) => i);
      let attempts = 0;
      do {
        order = shuffle([...identity]);
        attempts++;
      } while (attempts < 20 && order.every((v, i) => v === i));
    } else {
      order = [0];
    }

    aliasMap.set(originalOp, aliasOp);
    aliasedOps[aliasOp] = { originalOp, order };

    const originalName =
      compiler.OP_NAME[originalOp] ?? `OP_${originalOp}`;
    compiler.OP_NAME[aliasOp] = `ALIAS_${originalName}_${order.join("_")}`;
  }

  compiler.ALIASED_OPS = aliasedOps;

  if (aliasMap.size === 0) return { bytecode: bc };

  // ── Step 4: rewrite bytecode ─────────────────────────────────────────────────
  const result: Bytecode = [];

  for (const instr of bc) {
    const op = instr[0];
    if (op === null || !aliasMap.has(op)) {
      result.push(instr);
      continue;
    }

    const aliasOp = aliasMap.get(op)!;
    const { order } = aliasedOps[aliasOp];
    const originalOperands = instr.slice(1) as InstrOperand[];

    // Guard: if arity changed (shouldn't happen after the consistency check),
    // fall back to the original instruction.
    if (originalOperands.length !== order.length) {
      result.push(instr);
      continue;
    }

    // Rearrange operands: new slot i receives original operand order[i].
    const newOperands = order.map((i) => originalOperands[i]);

    const newInstr: Instruction = [aliasOp, ...newOperands];
    (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
    result.push(newInstr);
  }

  return { bytecode: result };
}
