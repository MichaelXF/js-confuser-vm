import type * as b from "../../types.ts";
import { SOURCE_NODE_SYM } from "../../compiler.ts";

// Resolve all {type:"constant", value} operands to integer indices into the
// constants pool.  Returns both the resolved bytecode and the constants array
// so the Serializer can use it for comment generation and output.
// Constant refs may appear at any operand position (index 1, 2, 3, …).
export function resolveConstants(bc: b.Bytecode): {
  bytecode: b.Bytecode;
  constants: any[];
} {
  const constants: any[] = [];
  const constantsMap = new Map<any, number>();

  function intern(operand: b.InstrOperand): b.Operand {
    const operandAsObject =
      typeof operand === "object" && operand ? operand : {};

    const value = (operand as any).value;

    let idx = constantsMap.get(value);
    if (typeof idx !== "number") {
      idx = constants.length;
      constantsMap.set(value, idx);
      constants.push(value);
    }

    const newOperand = {
      ...operandAsObject,
      type: "number",
      resolvedValue: idx,
    };

    return newOperand;
  }

  const resolved: b.Bytecode = [];
  for (const instr of bc) {
    const [op, ...operands] = instr;

    const hasConstant = operands.some(
      (o) =>
        o !== undefined &&
        o !== null &&
        typeof o === "object" &&
        (o as any).type === "constant",
    );

    if (hasConstant) {
      const newOperands = operands.map((operand) =>
        (operand as any)?.type === "constant" ? intern(operand) : operand,
      );
      const newInstr = [op, ...newOperands] as b.Instruction;
      (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
      resolved.push(newInstr);
    } else {
      resolved.push(instr);
    }
  }

  return { bytecode: resolved, constants };
}
