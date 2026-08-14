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
   * Rewrites integer operations into Mixed Boolean-Arithmetic (MBA) expressions,
   * so `a + b` becomes a nested mixture of arithmetic and bitwise steps that
   * static devirtualizers cannot pattern-match back to an operator.
   *
   * Applies to two groups:
   * - Bitwise operations (`& | ^ << >>`, `~`), which JavaScript already defines
   *   as int32 — always safe, no assumptions about your code.
   * - Integer `+`, `-`, unary `-` and comparisons, but only where a type
   *   analysis can prove both operands are integers.
   *
   * ⚠️ Assumes int32 wrap-around. The one behavioural difference is that an
   * integer result beyond ±2^31 wraps instead of staying exact:
   * `2000000000 + 2000000000` yields `-294967296` rather than `4000000000`.
   * Everything the analysis cannot prove integral is left untouched.
   *
   * Escape hatches, as comments on any function or statement:
   * ```js
   * \/* @js-confuser-vm-no-mba *\/  // exclude this subtree entirely
   * \/* @js-confuser-vm-int *\/     // assert this function's params are integers
   * ```
   */
  mba?: boolean;

  /**
   * Verify every generated MBA handler at build time (default: on with `mba`).
   *
   * Two things are checked, and both are otherwise invisible:
   * - that the handler computes what it replaced on the inputs it was built to
   *   assume, and does not depend on the operands it promised not to. A failure
   *   here is a wrong program, so it throws.
   * - how much of the handler table a black-box operator classifier could still
   *   identify — the same probe-and-match attack a devirtualizer runs. Reported
   *   as a count (with `verbose`, as a list).
   *
   * Set to `false` to skip it; it costs a fraction of a second on a typical
   * build and rather more on a very large one.
   */
  mbaFitCheck?: boolean;

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
