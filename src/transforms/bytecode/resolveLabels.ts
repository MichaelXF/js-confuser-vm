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
//
// The output bytecode is still a nested array of instructions.
// Flattening (one u16 slot per op, one per operand) happens in the Serializer.
// PC values computed here reflect the FLAT slot index so that jump targets,
// startPc, and LOAD_INT label operands are all correct after flattening.

import type { Instruction } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";

// Resolve symbolic labels to absolute flat-PC indices within a bytecode array.
// defineLabel pseudo-instructions are stripped; label-ref operands become ints.
// Each instruction [op, ...operands] occupies (1 + operands.length) flat slots,
// so realPc advances by instr.length for every non-pseudo instruction.
export function resolveLabels(
  bc: Instruction[],
  compiler: Compiler,
): {
  bytecode: Instruction[];
} {
  // Pass 1 – walk the array and record each label's flat PC, counting
  // real instructions by their full flat width (1 op + N operands).
  const labelToPc = new Map<string, number>();
  let realPc = 0;
  for (const instr of bc) {
    const op = instr[0];
    const operand = instr[1];

    if (
      op === null &&
      operand !== null &&
      typeof operand === "object" &&
      (operand as any).type === "defineLabel"
    ) {
      labelToPc.set((operand as any).label, realPc);
      continue;
    }

    if (op === null) continue; // "null" opcodes are never emitted

    // Each instruction occupies 1 slot for the opcode + 1 per operand.
    // IMPORTANT: 'placeholder' operands are not counted
    realPc += instr.filter((x) => (x as any)?.placeholder !== true).length;
  }

  // Pass 2 – build the resolved instruction list.
  // Label refs may appear at any operand position, so scan all of them.
  const resolved: any[] = [];
  for (const instr of bc) {
    const [op, ...operands] = instr;

    // Replace label-ref and encodedLabel operands with resolved flat PCs.
    // encodedLabel applies an encoding to the PC before emission so that raw
    // jump targets are hidden; the dispatcher block reverses it at runtime.
    // To change the encoding scheme, update both here and in jumpDispatcher.ts.
    const newOperands = operands.map((operand) => {
      if (
        operand === undefined ||
        operand === null ||
        typeof operand !== "object"
      )
        return operand;

      const type = (operand as any).type;

      if (type === "label") {
        const pc = labelToPc.get((operand as any).label);
        if (pc === undefined)
          throw new Error(`Undefined label: ${(operand as any).label}`);

        let resolvedValue = pc + ((operand as any).offset ?? 0);
        if ((operand as any).transform) {
          resolvedValue = (operand as any).transform(resolvedValue);
        }

        const newOperand = {
          type: "number",
          resolvedValue: resolvedValue,
        };
        return Object.assign(operand, newOperand);
      }

      return operand;
    });

    const newInstr = [op, ...newOperands];
    (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];

    // Pseudo-op "defineLabel"s are kept within this bytecode as the Serializer is responsible for dropping it, and its useful information for comment generation
    resolved.push(newInstr);
  }

  // Patch each function descriptor's startPc now that labels are resolved.
  for (const desc of compiler.fnDescriptors) {
    desc.startPc =
      labelToPc.get(desc.startLabel) ?? labelToPc.get(desc.entryLabel);
  }

  return {
    bytecode: resolved,
  };
}
