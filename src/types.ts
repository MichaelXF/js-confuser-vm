// Bytecode supports both real instructions and IR pseudo-instructions
// Real instruction: [OP.ADD, 5]  or multi-operand: [OP.MAKE_CLOSURE, labelRef, 2, 3, 0]
// IR instruction: [null, { type: "defineLabel", label: "FN_ENTRY_1" }]

// IR instructions are used to hold symbolic information during compilation
// All "null" instructions are dropped before assembly time.
// Instructions may carry any number of operands; the flat output serializes
// each operand as a separate u16 slot in the bytecode array.
// A virtual register reference emitted by the compiler.
// fnId identifies which function's register file this belongs to.
// resolveRegisters() replaces these with concrete slot indices (type:"number").
export type RegisterOperand = Op<{
  type: "register";
  id: number;
  fnId: number;
  kind?: string;
  scopeId?: string | number;
}>;

// A placeholder for a function's concrete regCount, emitted in MAKE_CLOSURE.
// resolveRegisters() fills resolvedValue once it knows the concrete slot count.
export type FnRegCountOperand = Op<{ type: "fnRegCount"; fnId: number }>;

// IR pseudo-instruction that marks the end of a register's live range.
// Emitted as [null, FreeRegOperand] so it is dropped before final assembly.
//
// NOTE: resolveRegisters() already computes correct lastUse from the last real
// operand appearance, so freeReg is EXTRANEOUS for any programmatically generated
// IR — the scanner will find the tightest possible range without it.
// It is only useful when a register has a late syntactic appearance that does
// NOT reflect its true logical end-of-life (e.g. a read emitted purely for
// side-effects long after the value is logically dead). No current pass in this
// codebase emits freeReg; it is kept as an extension point only.
export type FreeRegOperand = Op<{
  type: "freeReg";
  fnId: number;
  id: number;
  kind?: string;
  scopeId?: string | number;
}>;

export type InstrOperand =
  | number
  | Op<{ type: "number"; value?: number }>
  | Op<{
      type: "label";
      label: string;
      offset?: number;
      transform?: (resolvedPC: number) => number;
    }>
  | Op<{ type: "defineLabel"; label: string }>
  | Op<{ type: "constant"; value: any }>
  | RegisterOperand
  | FnRegCountOperand
  | FreeRegOperand;

export interface Operand {
  type: string;
  placeholder?: boolean; // This operand will not be emitted in the final bytecode, but used as a reference
  resolvedValue?: number; // This operand knows its resolved value, but kept as a object to keep metadata info available
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

export function registerOperand(
  id: number,
  fnId: number,
  metadata: Partial<Pick<RegisterOperand, "kind" | "scopeId">> = {},
): RegisterOperand {
  return { type: "register", id, fnId, ...metadata };
}

export function fnRegCountOperand(fnId: number): FnRegCountOperand {
  return { type: "fnRegCount", fnId };
}

export function freeRegOperand(reg: RegisterOperand): FreeRegOperand {
  const op: FreeRegOperand = { type: "freeReg", fnId: reg.fnId, id: reg.id };
  if (reg.kind !== undefined) op.kind = reg.kind;
  if (reg.scopeId !== undefined) op.scopeId = reg.scopeId;
  return op;
}
