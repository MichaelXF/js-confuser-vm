// Bytecode supports both real instructions and IR pseudo-instructions
// Real instruction: [OP.ADD, 5]
// IR instruction: [null, { type: "defineLabel", label: "FN_ENTRY_1" }]

// IR instructions are used to hold symbolic information during compilation
// All "null" instructions are dropped before assembly time
export type Instruction = [
  number | null,
  (
    | number
    | { type: "label"; label: string; offset?: number }
    | { type: "defineLabel"; label: string }
    | { type: "constant"; value: any }
  )?,
];

export type Bytecode = Instruction[];

export function constantOperand(value: any): Instruction[1] {
  return {
    type: "constant",
    value: value,
  };
}
