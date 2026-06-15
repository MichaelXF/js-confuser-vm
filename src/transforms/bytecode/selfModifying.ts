import type { Bytecode, Instruction } from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import { choice, getRandomInt } from "../../utils/random-utils.ts";
import { getInstructionSize } from "../../utils/op-utils.ts";

export function selfModifying(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // Walk the bytecode looking for "defineLabel" pseudo-ops, which start basic
  // blocks. For each block we collect the body (instructions between the label
  // and the next label/jump terminator), pick a random-sized, random-offset
  // sub-region within that body, move only that region to the end of the
  // bytecode under a fresh "patch_LXX" label, and replace it in-place with:
  //
  //   defineLabel ("originalLabel")               ← kept as-is (pseudo-op)
  //   <prefix instructions>                        ← body before the region (kept)
  //   PATCH  destPc  sliceStart  sliceEnd          ← 4 flat slots total
  //   Garbage Opcodes  × regionFlatSize            ← placeholder slots
  //   <suffix instructions>                        ← body after the region (kept)
  //
  // PATCH reads three inline operands via _operand():
  //   destPc     = originalLabel + prefixFlatSize + 4  (first placeholder slot)
  //   sliceStart = patchLabel          (flat PC of appended region)
  //   sliceEnd   = patchLabel + regionFlatSize
  //
  // On first execution PATCH copies bytecode[sliceStart..sliceEnd) over the
  // placeholder region starting at destPc.  Execution then falls through into
  // the freshly-patched region (and onward into the suffix). Subsequent calls
  // are idempotent.
  //
  // A budget caps the extra bytecode this pass adds to ~100% of the input
  // bytecode size. Once exhausted, remaining blocks are emitted untouched.

  const { OP, JUMP_OPS } = compiler;

  const result: Bytecode = [];
  const appended: Bytecode = [];
  let patchCount = 0;

  // Budget: allow this pass to add at most one extra copy (100%) of the input
  // bytecode size. "Size" here is the number of instruction entries, matching
  // the reported `bytecodeSize` (= bytecode.length).
  //
  // Each patch adds, in entry terms:
  //   in-place:  +1 PATCH entry, +regionFlatSize placeholder entries,
  //              −region.length region entries (moved out)
  //   appended:  +1 defineLabel marker, +region.length region entries
  //   net delta = 2 + regionFlatSize
  const budget = bc.length;
  let added = 0;

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

      const flatSize = (chunk: Bytecode) =>
        chunk.reduce((acc, instr) => acc + getInstructionSize(instr), 0);

      // Each patch adds (2 + regionFlatSize) entries (see budget note above).
      // Stop patching once there isn't room for even the smallest patch —
      // remaining blocks (and empty blocks) are emitted untouched.
      const remaining = budget - added;
      if (N === 0 || remaining < 2 + 1) {
        for (const bodyInstr of body) {
          result.push(bodyInstr);
        }
        i = j;
        continue;
      }

      // ── Pick a random-sized, random-offset region within the body ────────
      // prefix = body[0, regionStart)   (kept in place, executes normally)
      // region = body[regionStart, regionEnd)   (self-modified)
      // suffix = body[regionEnd, N)     (kept in place)
      const regionStart = getRandomInt(0, N - 1);
      const regionLen = getRandomInt(1, N - regionStart);

      let region = body.slice(regionStart, regionStart + regionLen);
      let regionFlatSize = flatSize(region);

      // Trim the region from the end so the patch fits the remaining budget,
      // keeping the cap strict (never overshoot 100% growth).
      while (region.length > 1 && 2 + regionFlatSize > remaining) {
        region = region.slice(0, -1);
        regionFlatSize = flatSize(region);
      }
      if (2 + regionFlatSize > remaining) {
        // Even a single-instruction region doesn't fit — leave block untouched.
        for (const bodyInstr of body) {
          result.push(bodyInstr);
        }
        i = j;
        continue;
      }

      const regionEnd = regionStart + region.length;
      const prefix = body.slice(0, regionStart);
      const suffix = body.slice(regionEnd);

      const prefixFlatSize = flatSize(prefix);

      const patchLabel = `patch_${originalLabel}_${patchCount++}`;

      // Charge the budget (entry count): PATCH entry + defineLabel marker +
      // placeholder entries (region.length cancels between in-place and append).
      added += 2 + regionFlatSize;

      // ── Prefix instructions (kept as-is) ────────────────────────────────
      for (const prefixInstr of prefix) {
        result.push(prefixInstr);
      }

      // ── PATCH instruction (4 flat slots: opcode + 3 operands) ───────────
      //   destPc     = originalLabel + prefixFlatSize + 4  (first placeholder)
      //   sliceStart = patchLabel
      //   sliceEnd   = patchLabel + regionFlatSize
      result.push([
        OP.PATCH as number,
        { type: "label", label: originalLabel, offset: prefixFlatSize + 4 },
        { type: "label", label: patchLabel },
        { type: "label", label: patchLabel, offset: regionFlatSize },
      ] as unknown as Instruction);

      // ── Placeholders (Garbage Opcodes * regionFlatSize, each 1 flat slot) ──
      // These are overwritten by PATCH on first execution.
      for (let p = 0; p < regionFlatSize; p++) {
        const randomOpcode = choice(Object.values(compiler.OP));
        result.push([+randomOpcode]);
      }

      // ── Suffix instructions (kept as-is) ────────────────────────────────
      for (const suffixInstr of suffix) {
        result.push(suffixInstr);
      }

      // ── Append real region at end ───────────────────────────────────────
      appended.push([null, { type: "defineLabel", label: patchLabel }]);
      for (const regionInstr of region) {
        appended.push(regionInstr);
      }

      i = j; // skip over the original body in the input array
      continue;
    }

    result.push(instr);
    i++;
  }

  return { bytecode: [...result, ...appended] };
}
