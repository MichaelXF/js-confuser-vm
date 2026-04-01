import type { Bytecode, Instruction } from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import { choice } from "../utils/random-utils.ts";

export function selfModifying(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // Walk the bytecode looking for "defineLabel" pseudo-ops, which start basic
  // blocks. For each block we collect the body (instructions between the label
  // and the next label/jump terminator), move it to the end of the bytecode
  // under a fresh "patch_LXX" label, and replace it in-place with:
  //
  //   defineLabel ("originalLabel")               ← kept as-is (pseudo-op)
  //   PATCH  destPc  sliceStart  sliceEnd          ← 4 flat slots total
  //   Garbage Opcodes  × bodyFlatSize                         ← placeholder slots
  //
  // PATCH reads three inline operands via _operand():
  //   destPc     = originalLabel + 4  (first slot after PATCH's own 4 slots)
  //   sliceStart = patchLabel          (flat PC of appended body)
  //   sliceEnd   = patchLabel + bodyFlatSize
  //
  // On first execution PATCH copies bytecode[sliceStart..sliceEnd) over the
  // placeholder region starting at destPc.  Execution then falls through into
  // the freshly-patched body.  Subsequent calls are idempotent.

  const { OP, JUMP_OPS } = compiler;

  const result: Bytecode = [];
  const appended: Bytecode = [];
  let patchCount = 0;

  let i = 0;
  while (i < bc.length) {
    const instr = bc[i];
    const [op, operand] = instr;

    // Detect a defineLabel pseudo-op — start of a new basic block.
    if (
      op === null &&
      operand !== null &&
      typeof operand === "object" &&
      (operand as any).type === "defineLabel"
    ) {
      const originalLabel = (operand as any).label as string;
      result.push(instr); // keep the defineLabel marker
      i++;

      // Collect body: everything after the label until the next terminator.
      let j = i;
      while (j < bc.length) {
        const [nextOp, nextOperand] = bc[j];

        // Another defineLabel = boundary of the next block.
        if (
          nextOp === null &&
          typeof nextOperand === "object" &&
          (nextOperand as any)?.type === "defineLabel"
        ) {
          break;
        }

        // Jump instructions, RETURN all terminate the body.
        if (nextOp !== null && (JUMP_OPS.has(nextOp) || nextOp === OP.RETURN)) {
          break;
        }

        j++;
      }

      const body = bc.slice(i, j);
      const N = body.length;

      if (N === 0) {
        // Nothing to transform — label is immediately followed by a terminator.
        continue;
      }

      const patchLabel = `patch_${originalLabel}_${patchCount++}`;

      // Flat size of the body (each instruction occupies instr.length slots).
      const bodyFlatSize = body.reduce(
        (acc, instr) =>
          acc + instr.filter((x) => (x as any)?.placeholder !== true).length,
        0,
      );

      // ── PATCH instruction (4 flat slots: opcode + 3 operands) ───────────
      //   destPc     = originalLabel + 4  (slot right after PATCH's 4 slots)
      //   sliceStart = patchLabel
      //   sliceEnd   = patchLabel + bodyFlatSize
      result.push([
        OP.PATCH as number,
        { type: "label", label: originalLabel, offset: 4 },
        { type: "label", label: patchLabel },
        { type: "label", label: patchLabel, offset: bodyFlatSize },
      ] as unknown as Instruction);

      // ── Placeholders (Garbage Opcodes * bodyFlatSize, each 1 flat slot) ────────────
      // These are overwritten by PATCH on first execution.
      for (let p = 0; p < bodyFlatSize; p++) {
        const randomOpcode = choice(Object.values(compiler.OP));
        result.push([+randomOpcode]);
      }

      // ── Append real body at end ─────────────────────────────────────────
      appended.push([null, { type: "defineLabel", label: patchLabel }]);
      for (const bodyInstr of body) {
        appended.push(bodyInstr);
      }

      i = j; // skip over the original body in the input array
      continue;
    }

    result.push(instr);
    i++;
  }

  return { bytecode: [...result, ...appended] };
}
