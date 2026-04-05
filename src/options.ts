export interface Options {
  target?: "node" | "browser";

  randomizeOpcodes?: boolean; // randomize the opcode numbers?
  shuffleOpcodes?: boolean; // shuffle order of opcode handlers in the runtime?
  encodeBytecode?: boolean; // encode bytecode? when off, comments for instructions are added
  selfModifying?: boolean; // do self-modifying bytecode for function bodies?
  dispatcher?: boolean; // create middleman blocks to process jumps?
  controlFlowFlattening?: boolean; // flatten control flow into a while-switch state machine?
  macroOpcodes?: boolean; // create combined opcodes for repeated instruction sequences?
  microOpcodes?: boolean; // break opcodes into sub-opcodes?
  specializedOpcodes?: boolean; // create specialized opcodes for commonly used opcode+operand pairs?
  aliasedOpcodes?: boolean; // create duplicate opcodes for commonly used opcodes?
  handlerTable?: boolean; // convert switch dispatch to a handler table on the VM prototype?
  timingChecks?: boolean; // add timing checks to detect debuggers?
  concealConstants?: boolean; // conceal strings and integers in the constant pool?
  minify?: boolean; // pass final output through Google Closure Compiler? (Renames VM class properties)

  stringConcealing?: boolean;
}

export const DEFAULT_OPTIONS = {};
