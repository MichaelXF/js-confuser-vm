import { Instruction } from "../types.ts";

interface BasicBlock {
  label: string;
  body: Instruction;
  jumpLabels?: Set<string>;
}

/**
 * Breaks functions into DAGs (Directed Acyclic Graphs)
 *
 * - 1. Break bytecode into chunks
 * - 2. Shuffle chunks but remember their original position
 * - 3. Create an effectively Switch statement inside a While loop, each case is a chunk, and the while loops exits on the last transition.
 *
 * The Switch statement:
 *
 * - 1. The state variable controls which case will run next
 * - 2. At the end of each case, the state variable is updated to the next block of code.
 * - 3. The while loop continues until the the state variable is the end state.
 */
export async function controlFlowFlattening(bytecode: Instruction) {
  // break bytecode into basic blocks
  // 1. read bytecode and track the current label from the IR-instruction "defineLabel"
  // 2. track any potential jumps inside this block using the IR-instruction operand "label"
  // at this stage in the passing process, may still use these IR-instruction labels for jumps, meaning no effort is required to maintain absolute PCs
  // create a bare CFF implementation of a simple switch dispatch loop effectively
  // This CFF implementation should only apply to "easy jumps" such as conditional jump (if-statement)
  // the complex and specific jumps for for..in shouldn't get flattened
}
