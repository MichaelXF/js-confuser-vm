import { getRandomInt } from "./random-utils.ts";
import * as b from "../types.ts";

export const U16_MAX = 0xffff; // bytecode operands are u16

/** Returns the next free opcode slot, or -1 when the space is exhausted. */
export function nextFreeSlot(usedOpcodes: Set<number>): number {
  if (usedOpcodes.size > U16_MAX) return -1;
  let attempts = 0;
  while (attempts++ < 512) {
    const candidate = getRandomInt(0, U16_MAX);
    if (!usedOpcodes.has(candidate)) {
      usedOpcodes.add(candidate);
      return candidate;
    }
  }
  // Fallback: linear scan from a random start
  const start = getRandomInt(0, U16_MAX);
  for (let i = 0; i <= U16_MAX; i++) {
    const v = (start + i) & U16_MAX;
    if (!usedOpcodes.has(v)) {
      usedOpcodes.add(v);
      return v;
    }
  }
  return -1;
}

export function getInstructionSize(instr: b.Instruction): number {
  const size = instr.filter((op) => (op as any)?.placeholder !== true).length;

  return size;
}
