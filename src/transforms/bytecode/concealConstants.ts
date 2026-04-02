import { Compiler } from "../../compiler.ts";
import type * as b from "../../types.ts";

export function concealConstants(
  bytecode: b.Bytecode,
  compiler: Compiler,
): {
  bytecode: b.Bytecode;
} {
  const newBytecode: b.Bytecode = [];

  for (const instr of bytecode) {
    const [op, ...operands] = instr;

    const hasContant = operands.some(
      (o) =>
        o !== undefined &&
        o !== null &&
        typeof o === "object" &&
        (o as any).type === "constant",
    );

    if (!hasContant) {
      newBytecode.push(instr);
      continue;
    }

    const newOperands = [];
    for (const operand of operands) {
      if ((operand as any)?.type === "constant") {
        const tsOperand = operand as any;
        newOperands.push(operand);
        newOperands.push({
          type: "constant",
          value: tsOperand.value,
          key: true,
        });
      } else {
        newOperands.push(operand);
      }
    }

    instr.length = 0;
    instr.push(op, ...newOperands);

    newBytecode.push(instr);
  }

  return {
    bytecode: newBytecode,
  };
}
