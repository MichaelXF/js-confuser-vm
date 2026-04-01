// Bytecode supports both real instructions and IR pseudo-instructions
// Real instruction: [OP.ADD, 5]  or multi-operand: [OP.MAKE_CLOSURE, labelRef, 2, 3, 0]
// IR instruction: [null, { type: "defineLabel", label: "FN_ENTRY_1" }]

// IR instructions are used to hold symbolic information during compilation
// All "null" instructions are dropped before assembly time.
// Instructions may carry any number of operands; the flat output serializes
// each operand as a separate u16 slot in the bytecode array.
export type InstrOperand =
  | number
  | Op<{ type: "number"; value: number }>
  | Op<{ type: "label"; label: string; offset?: number }>
  | Op<{ type: "defineLabel"; label: string }>
  | Op<{ type: "constant"; value: any }>;

export interface Operand {
  type: string;
  placeholder?: boolean;
  resolvedValue?: number;
}

type Op<T extends object> = Operand & T;

export type Instruction = [number | null, ...InstrOperand[]];

export type Bytecode = Instruction[];

export function constantOperand(value: any): Instruction[1] {
  return {
    type: "constant",
    value: value,
  };
}
