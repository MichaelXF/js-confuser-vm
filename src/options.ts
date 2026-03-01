export interface Options {
  target?: "node" | "browser";

  randomizeOpcodes?: boolean; // randomize opcode values in OP mapping?
  shuffleOpcodes?: boolean; // shuffle order of opcode handlers in the runtime?
  encodeBytecode?: boolean; // encode bytecode? when off, comments for instructions are added
  selfModifying?: boolean; // do self-modifying bytecode for function bodies?
  timingChecks?: boolean; // add timing checks to detect debuggers?
  minify?: boolean; // pass final output through Google Closure Compiler? (Renames VM class properties)
}

export const DEFAULT_OPTIONS = {};
