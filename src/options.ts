export interface Options {
  /**
   * Currently has no effect.
   */
  target?: "node" | "browser";

  /**
   * Randomizes the opcode numbers.
   */
  randomizeOpcodes?: boolean;

  /**
   * Shuffles the order of opcode handlers in the VM runtime.
   */
  shuffleOpcodes?: boolean;

  /**
   * Encodes the bytecode array.
   */
  encodeBytecode?: boolean;

  /**
   * Conceals strings and integers in the constant pool.
   */
  concealConstants?: boolean;

  /**
   * Flattens the control flow of your program into a convoluted state machine.
   */
  controlFlowFlattening?: boolean;

  /**
   * Creates a middleman block to process jumps.
   */
  dispatcher?: boolean;

  /**
   * Encodes strings to conceal plain-text values.
   */
  stringConcealing?: boolean;

  /**
   * Combines multiple opcodes commonly used from your bytecode.
   */
  macroOpcodes?: boolean;

  /**
   * Creates specialized opcodes for commonly used opcode+operand pairs.
   */
  specializedOpcodes?: boolean;

  /**
   * Creates duplicate opcodes, including variants with shuffled operand order.
   */
  aliasedOpcodes?: boolean;

  /**
   * Adds fake opcode effects to hinder opcode analysis and instrumentation.
   */
  antiInstrumentation?: boolean;

  /**
   * Function bodies are replaced upon runtime entry to the real bytecode.
   */
  selfModifying?: boolean;

  /**
   * Detects the use of debuggers by checking for >1second pauses.
   * - May break code with slow sync tasks.
   * - Provide a number of milliseconds to change the duration.
   */
  timingChecks?: boolean | number;

  /**
   * Obfuscates the VM runtime classes by shuffling the order of declarations and methods.
   */
  classObfuscation?: boolean;

  /**
   * Converts the switch-case dispatch into a handler table for performance reasons.
   */
  handlerTable?: boolean;

  /**
   * Minifies the final code with Google Closure Compiler. Renames the VM class properties.
   */
  minify?: boolean;

  /**
   * Prints obfuscator info useful for debugging purposes.
   */
  verbose?: boolean;

  /**
   * Captures a more detailed `profileData` object (slower)
   */
  profile?: boolean;
}

export const DEFAULT_OPTIONS = {};
