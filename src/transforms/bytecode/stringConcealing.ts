// String Concealing
//
// Encodes every string constant in each function with base64, then inserts a
// decode closure (atob) that is called immediately after each LOAD_CONST to
// recover the original value at runtime.
//
// ── How it works ─────────────────────────────────────────────────────────────
//
// Each function that contains at least one string LOAD_CONST gets:
//
//   rClosure — a register holding the decode closure, created ONCE at function
//              entry (hoisted).  All decode calls within the function reuse it.
//
// The decode function is compiled ONCE (shared across all functions) from a
// Template:
//
//   function decode(encoded) { return atob(encoded); }
//
// String constant transformations:
//
//   Original:  LOAD_CONST  rDst, "hello"
//   Becomes:   LOAD_CONST  rDst, "aGVsbG8="        (base64-encoded)
//              CALL        rDst, rClosure, 1, rDst  (decode in-place)
//
// ── Pipeline position ─────────────────────────────────────────────────────────
// Runs BEFORE resolveRegisters and resolveLabels (same slot as Dispatcher/CFF).

import { Compiler } from "../../compiler.ts";
import { Template } from "../../template.ts";
import type { Bytecode, RegisterOperand } from "../../types.ts";
import * as b from "../../types.ts";

// ── Helpers (shared pattern with dispatcher.ts / controlFlowFlattening.ts) ──

function ref(r: RegisterOperand): RegisterOperand {
  return b.registerOperand(r.id, r.fnId);
}

function buildMaxIdMap(bc: Bytecode): Map<number, number> {
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

function allocReg(fnId: number, maxId: Map<number, number>): RegisterOperand {
  const next = (maxId.get(fnId) ?? -1) + 1;
  maxId.set(fnId, next);
  return b.registerOperand(next, fnId);
}

// ── Per-function transformation ──────────────────────────────────────────────

function processFunctionBlock(
  instrs: Bytecode,
  fnId: number,
  compiler: Compiler,
  maxId: Map<number, number>,
  decodeDesc: any,
): { instrs: Bytecode } {
  const OP = compiler.OP;

  // Only transform functions that contain string constants.
  const hasStringConst = instrs.some((instr) => {
    if (instr[0] !== OP.LOAD_CONST) return false;
    const operands = instr.slice(1);
    return (
      operands.length === 2 &&
      (operands[1] as any)?.type === "constant" &&
      typeof (operands[1] as any).value === "string"
    );
  });
  if (!hasStringConst) return { instrs };

  const rClosure = allocReg(fnId, maxId);
  const out: Bytecode = [];

  // Hoist: create the decode closure once at function entry.
  out.push([
    OP.MAKE_CLOSURE!,
    ref(rClosure),
    { type: "label", label: decodeDesc.entryLabel },
    decodeDesc.paramCount, // 1 (encoded)
    b.fnRegCountOperand(decodeDesc._fnIdx),
    0, // no upvalues
  ]);

  // Transform each instruction.
  for (const instr of instrs) {
    if (
      instr[0] === OP.LOAD_CONST &&
      instr.length === 3 &&
      (instr[2] as any)?.type === "constant" &&
      typeof (instr[2] as any).value === "string"
    ) {
      const dst = instr[1] as RegisterOperand;
      const constOp = instr[2] as any;

      // Encode the string in-place.
      constOp.value = Buffer.from(constOp.value as string, "utf-8").toString(
        "base64",
      );

      out.push(instr);

      // Decode: rDst = decode(rDst)
      out.push([
        OP.CALL!,
        ref(dst),       // dst — receives decoded string
        ref(rClosure),  // the hoisted decode closure
        1,              // argc
        ref(dst),       // arg[0] = encoded value
      ]);
    } else {
      out.push(instr);
    }
  }

  return { instrs: out };
}

// ── Pass entry point ──────────────────────────────────────────────────────────
export function stringConcealing(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const maxId = buildMaxIdMap(bc);

  // Compile the decode function ONCE — all functions share the same closure body.
  const decodeTemplate = new Template(`
    function decode(encoded) {
      return atob(encoded);
    }
  `).compile({}, compiler);
  const decodeDesc = decodeTemplate.functions[0];

  // Build function boundary detection (same pattern as dispatcher.ts).
  const entryLabels = new Set(compiler.fnDescriptors.map((d) => d.entryLabel));
  const entryLabelToFnId = new Map(
    compiler.fnDescriptors.map((d) => [d.entryLabel!, d._fnIdx!]),
  );

  const result: Bytecode = [];
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

    // Found a function entry label. Collect all instructions belonging to
    // this function (until the next entry label or end of bytecode).
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

    // Emit the entry defineLabel, then the (potentially transformed) body.
    result.push(instr);
    const { instrs: processed } = processFunctionBlock(
      fnInstrs,
      fnId,
      compiler,
      maxId,
      decodeDesc,
    );
    result.push(...processed);
  }

  // Append the decode function's bytecode at the end (defines its entryLabel).
  result.push(...decodeTemplate.bytecode);

  return { bytecode: result };
}
