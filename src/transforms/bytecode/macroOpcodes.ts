import type { Bytecode, Instruction } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { nextFreeSlot, U16_MAX } from "../utils/op-utils.ts";

// Opcodes that must not appear inside a macro window.
// Jump ops: modifying frame._pc mid-execution causes the macro handler to
//   run subsequent sub-bodies even after the jump already fired.
// Frame-changing ops (CALL, CALL_METHOD, NEW, RETURN, THROW): push/pop call
//   frames mid-macro, leaving the `frame` variable stale for later sub-bodies.
// Variable-operand ops (MAKE_CLOSURE): the number of _operand() calls depends
//   on uvCount at runtime, so a static handler cannot be generated.
// Infrastructure ops (DATA, PATCH, TRY_SETUP, TRY_END, DEBUGGER):
//   either illegal here or nonsensical to fold.

// Scan bytecode for repeating instruction sequences and fold them into
// macro opcodes.  Runs after selfModifying but before resolveLabels so
// IR-ref operands (label/constant) are carried through transparently.
//
// Algorithm:
//   1. Count every eligible window of length 2–5 by its op-code signature.
//   2. Keep sequences that appear >= 2 times; sort by frequency then length.
//   3. Assign unused opcode values (0–255, not already claimed by compiler.OP)
//      to the most-frequent candidates and store in compiler.MACRO_OPS.
//   4. Re-scan bytecode, replacing each matched sequence with a single
//      multi-operand instruction:
//        [macroOpCode, operands_of_instr_0..., operands_of_instr_1..., ...]
//      The runtime macro handler inlines each sub-instruction body; those
//      bodies call this._operand() themselves to consume the inline operands.
export function macroOpcodes(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const originalOpToName = new Map<number, string>();
  for (const name in compiler.OP) {
    const opVal = compiler.OP[name];
    originalOpToName.set(opVal, name);
  }

  function isEligible(op: number | null, compiler: Compiler): boolean {
    if (op === null) return false;
    const { OP, JUMP_OPS } = compiler;
    if (JUMP_OPS.has(op)) return false;
    const excluded = new Set<number | undefined>([
      OP.RETURN,
      OP.PATCH,
      OP.TRY_SETUP,
      OP.TRY_END,
      OP.DEBUGGER,
      OP.CALL,
      OP.CALL_METHOD,
      OP.NEW,
      OP.THROW,
      OP.MAKE_CLOSURE, // variable-length operands — cannot generate a static handler
    ]);
    return !excluded.has(op) && originalOpToName.has(op); // Only original Ops are eligible (specialized disallowed)
  }

  // Collect every opcode value already in use so we can find free slots.
  const usedOpcodes = new Set<number>(
    Object.values(compiler.OP).filter((v) => v !== undefined) as number[],
  );
  if (usedOpcodes.size > U16_MAX) return { bytecode: bc };

  // ── Step 1: count window frequencies ──────────────────────────────────────
  const freqMap = new Map<string, { ops: number[]; count: number }>();

  for (let i = 0; i < bc.length; i++) {
    for (let len = 2; len <= 5; len++) {
      if (i + len > bc.length) break;

      const ops: number[] = [];
      let valid = true;
      for (let j = 0; j < len; j++) {
        const op = bc[i + j][0];
        if (!isEligible(op, compiler)) {
          valid = false;
          break;
        }
        ops.push(op as number);
      }
      // If position (i+j) is ineligible, longer windows from i are also invalid.
      if (!valid) break;

      const key = ops.join(",");
      const entry = freqMap.get(key);
      if (entry) {
        entry.count++;
      } else {
        freqMap.set(key, { ops, count: 1 });
      }
    }
  }

  // ── Step 2: keep repeated candidates, prioritise by frequency then length ─
  const candidates = Array.from(freqMap.values())
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count || b.ops.length - a.ops.length);

  if (candidates.length === 0) return { bytecode: bc };

  // ── Step 3: assign free opcode slots to the best candidates ───────────────
  for (let i = 0; i < candidates.length; i++) {
    const macroOp = nextFreeSlot(usedOpcodes);
    if (macroOp === -1) break;
    const ops = candidates[i].ops;
    compiler.MACRO_OPS[macroOp] = ops;
    // Register a combined name so OP_NAME and comment generation both work.
    let combinedName = ops
      .map((v) => compiler.OP_NAME[v] ?? `OP_${v}`)
      .join(",");
    compiler.OP_NAME[macroOp] = combinedName;
  }

  // ── Step 4: build signature → macro opcode lookup ─────────────────────────
  const sigToMacro = new Map<string, number>();
  for (const [macroOpStr, ops] of Object.entries(compiler.MACRO_OPS)) {
    sigToMacro.set((ops as number[]).join(","), Number(macroOpStr));
  }

  // ── Step 5: replace sequences with a single multi-operand macro instruction ─
  // Emit [macroOpCode, ...all operands from all constituent instructions].
  // The runtime handler inlines each sub-instruction body; those bodies call
  // this._operand() themselves to consume the operands in order.
  const result: Bytecode = [];
  let i = 0;

  while (i < bc.length) {
    let matched = false;

    for (let len = 5; len >= 2; len--) {
      if (i + len > bc.length) continue;

      const instructions: Instruction[] = [];
      let valid = true;
      for (let j = 0; j < len; j++) {
        const instr = bc[i + j];
        const op = instr[0];
        if (!isEligible(op, compiler)) {
          valid = false;
          break;
        }
        instructions.push(instr);
      }
      if (!valid) continue;

      const key = instructions.map((instr) => instr[0]).join(",");
      if (!sigToMacro.has(key)) continue;

      const macroOpCode = sigToMacro.get(key)!;

      // Collect all operands from every constituent instruction, in order.
      // Each instruction contributes instr.slice(1) — zero or more operands.
      const allOperands: any[] = [];
      for (let j = 0; j < len; j++) {
        allOperands.push(...bc[i + j].slice(1));
      }

      const newInstr: Instruction = [macroOpCode, ...allOperands];
      (newInstr as any)[SOURCE_NODE_SYM] = (instructions[0] as any)[
        SOURCE_NODE_SYM
      ];

      result.push(newInstr);

      i += len;
      matched = true;
      break;
    }

    if (!matched) {
      result.push(bc[i]);
      i++;
    }
  }

  return { bytecode: result };
}
