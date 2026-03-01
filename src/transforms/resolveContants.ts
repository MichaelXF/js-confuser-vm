import type { Bytecode, Instruction } from "../types.ts";
import { SOURCE_NODE_SYM } from "../compiler.ts";

// Resolve all {type:"constant", value} operands to integer indices into the
// constants pool.  Returns both the resolved bytecode and the constants array
// so the Serializer can use it for comment generation and output.
export function resolveConstants(bc: Bytecode): {
  bytecode: Bytecode;
  constants: any[];
} {
  const constants: any[] = [];
  const constantsMap = new Map<any, number>();

  function intern(value: any): number {
    let idx = constantsMap.get(value);
    if (typeof idx !== "number") {
      idx = constants.length;
      constantsMap.set(value, idx);
      constants.push(value);
    }
    return idx;
  }

  const resolved: Bytecode = [];
  for (const instr of bc) {
    const [op, operand] = instr;
    if (
      operand !== undefined &&
      operand !== null &&
      typeof operand === "object" &&
      (operand as any).type === "constant"
    ) {
      const newInstr: Instruction = [op, intern((operand as any).value)];
      (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
      resolved.push(newInstr);
    } else {
      resolved.push(instr);
    }
  }

  return { bytecode: resolved, constants };
}
