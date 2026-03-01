// --- Label IR ---
// During compilation, jump targets are symbolic labels instead of hard-coded
// PC numbers.  Two IR "pseudo operands" carry the label information:
//
//   defineLabel operand  : [null, {type:"defineLabel", label:"FN_ENTRY_1"}]
//     Marks a position in the bytecode array.
//     resolveLabels() strips these out entirely.
//
//   label ref operand      : [OP.JUMP, {type:"label", label:"FN_ENTRY_1"}]
//     Used as the operand of any jump instruction. resolveLabels() replaces
//     it with the integer PC that the corresponding defineLabel resolves to.

import type { Instruction } from "../types.ts";
import { Compiler } from "../compiler.ts";

// Resolve symbolic labels to absolute PC indices within a bytecode array.
// defineLabel pseudo-instructions are stripped; label-ref operands become ints.
// Mutates `bc` in place so callers holding a reference see the resolved result.
export function resolveLabels(
  bc: Instruction[],
  compiler: Compiler,
): {
  bytecode: Instruction[];
} {
  // Pass 1 – walk the array and record each label's real PC, counting only
  // real instructions (defineLabel pseudo-ops don't occupy a PC slot).
  const labelToPc = new Map<string, number>();
  let realPc = 0;
  for (const instr of bc) {
    const op = instr[0];
    const operand = instr[1];
    if (
      op === null &&
      operand !== null &&
      typeof operand === "object" &&
      operand.type === "defineLabel"
    ) {
      labelToPc.set(operand.label, realPc);
    } else {
      realPc++;
    }
  }

  // Pass 2 – build the resolved instruction list.
  const resolved: any[] = [];
  for (const instr of bc) {
    const op = instr[0];
    const operand = instr[1];

    // Strip defineLabel pseudo-ops.
    if (
      op === null &&
      typeof operand === "object" &&
      operand?.type === "defineLabel"
    ) {
      continue;
    }

    // Replace label-ref operands with integer PCs.
    if (
      operand !== undefined &&
      operand !== null &&
      typeof operand === "object" &&
      operand.type === "label"
    ) {
      const pc = labelToPc.get(operand.label);
      if (pc === undefined)
        throw new Error(`Undefined label: ${operand.label}`);
      resolved.push([op, pc + (operand.offset ?? 0)]);
    } else {
      resolved.push(instr);
    }
  }

  // Patch each function descriptor's startPc now that labels are resolved.
  for (const desc of compiler.fnDescriptors) {
    desc.startPc = labelToPc.get(desc.startLabel);
  }

  return {
    bytecode: resolved,
  };
}
