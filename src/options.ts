export interface Options {
  target?: "node" | "browser";

  randomizeOpcodes?: boolean; // randomize the opcode numbers?
  shuffleOpcodes?: boolean; // shuffle order of opcode handlers in the runtime?
  encodeBytecode?: boolean; // encode bytecode? when off, comments for instructions are added
  selfModifying?: boolean; // do self-modifying bytecode for function bodies?
  macroOpcodes?: boolean; // create combined opcodes for repeated instruction sequences?
  specializedOpcodes?: boolean; // create specialized opcodes for commonly used opcode+operand pairs?
  aliasedOpcodes?: boolean; // create duplicate opcodes for commonly used opcodes?
  timingChecks?: boolean; // add timing checks to detect debuggers?
  concealConstants?: boolean; // conceal strings and integers in the constant pool?
  minify?: boolean; // pass final output through Google Closure Compiler? (Renames VM class properties)
}

export const DEFAULT_OPTIONS = {};
