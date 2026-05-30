// Shared utilities for bytecode transformation passes.
//
// All three patterns below are identical across dispatcher, controlFlowFlattening,
// and stringConcealing.  Centralising them here keeps each pass focused on its
// own logic and makes the shared contract explicit.

import type { Bytecode, RegisterOperand, InstrOperand } from "../types.ts";
import * as b from "../types.ts";
import { Compiler } from "../compiler.ts";

// Return a fresh RegisterOperand object with the same (id, fnId).
// IMPORTANT: operand objects must be unique throughout compilation —
// other passes (e.g. specializedOpcodes) mutate operands in-place and a
// shared reference would corrupt both sites.
export function ref(r: RegisterOperand): RegisterOperand {
  return b.registerOperand(r.id, r.fnId);
}

// Scan bc and return the highest virtual register id seen for each fnId.
// Used by passes that allocate new registers after the compiler has finished.
export function buildMaxIdMap(bc: Bytecode): Map<number, number> {
  const maxId = new Map<number, number>();
  for (const instr of bc) {
    for (let j = 1; j < instr.length; j++) {
      const op = instr[j] as any;
      if (op && op.type === "register") {
        const cur = maxId.get(op.fnId) ?? -1;
        if (op.id > cur) maxId.set(op.fnId, op.id);
      }
    }
  }
  return maxId;
}

// Allocate the next virtual register id for fnId, updating maxId in-place.
export function allocReg(
  fnId: number,
  maxId: Map<number, number>,
): RegisterOperand {
  const next = (maxId.get(fnId) ?? -1) + 1;
  maxId.set(fnId, next);
  return b.registerOperand(next, fnId);
}

// Return the label string if the operand is a { type:"label" } object,
// otherwise return null.  Used by passes that need to identify jump targets.
export function extractLabel(op: InstrOperand | undefined): string | null {
  if (op && typeof op === "object" && (op as any).type === "label")
    return (op as any).label as string;
  return null;
}

// Walk bc, call transform() for every function body, and reassemble the output.
//
// For each function entry label the scanner collects all instructions up to the
// next entry label (or end-of-bytecode) into fnInstrs and passes them to
// transform() along with the function's fnId.
//
// The transform callback returns:
//   instrs — the (possibly rewritten) function body to emit in place of fnInstrs
//   tail   — optional bytecode to append AFTER all function bodies
//             (e.g. template-compiled decode closures)
//
// Instructions that appear before any entry label (the top-level preamble) are
// passed through unchanged.
export function forEachFunction(
  bc: Bytecode,
  compiler: Compiler,
  transform: (
    fnInstrs: Bytecode,
    fnId: number,
  ) => { instrs: Bytecode; tail?: Bytecode },
): { bytecode: Bytecode } {
  const entryLabels = new Set(compiler.fnDescriptors.map((d) => d.entryLabel));
  const entryLabelToFnId = new Map(
    compiler.fnDescriptors.map((d) => [d.entryLabel!, d._fnIdx!]),
  );

  const result: Bytecode = [];
  const tails: Bytecode[] = [];
  let i = 0;

  while (i < bc.length) {
    const instr = bc[i];
    const [op, operand0] = instr;
    const isEntryLabel =
      op === null &&
      (operand0 as any)?.type === "defineLabel" &&
      entryLabels.has((operand0 as any).label);

    if (!isEntryLabel) {
      result.push(instr);
      i++;
      continue;
    }

    const entryLabel = (operand0 as any).label as string;
    const fnId = entryLabelToFnId.get(entryLabel)!;
    i++; // step past the defineLabel itself

    const fnInstrs: Bytecode = [];
    while (i < bc.length) {
      const next = bc[i];
      const [nextOp, nextOp0] = next;
      if (
        nextOp === null &&
        (nextOp0 as any)?.type === "defineLabel" &&
        entryLabels.has((nextOp0 as any).label)
      )
        break;
      fnInstrs.push(next);
      i++;
    }

    result.push(instr); // emit the entry defineLabel
    const { instrs, tail } = transform(fnInstrs, fnId);
    result.push(...instrs);
    if (tail && tail.length > 0) tails.push(tail);
  }

  for (const tail of tails) {
    result.push(...tail);
  }

  return { bytecode: result };
}
