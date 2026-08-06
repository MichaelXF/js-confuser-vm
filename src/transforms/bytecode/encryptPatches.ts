import { ok } from "assert";
import type { Bytecode, Instruction } from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import type { PatchRegion } from "./selfModifying.ts";

// Encrypts the regions tagged by selfModifying, so the plaintext of a patched
// instruction exists nowhere in the output. Mirrors the runtime PATCH handler
// exactly; see it for the cipher.
//
// Decoy patches are not in the registry and are left alone — they only ever
// copy junk over junk, so there is nothing to conceal.
//
// Must run LAST — after resolveLabels and resolveConstants — because it needs
// the final u32 word of every slot, which is why selfModifying can't do it.

// Flat u32 words of an instruction, in emission order.
function flatten(instr: Instruction): number[] {
  ok(instr[0] !== null, "encryptPatches: pseudo-op inside a patch region");

  const words: number[] = [];
  for (let i = 0; i < instr.length; i++) {
    const operand = instr[i] as any;
    if (i > 0 && operand?.placeholder === true) continue;

    const value = typeof operand === "number" ? operand : operand?.resolvedValue;
    ok(
      typeof value === "number",
      "encryptPatches: unresolved operand " + JSON.stringify(operand),
    );
    words.push(value);
  }
  return words;
}

export function encryptPatches(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  for (let at = 0; at < bc.length; at++) {
    if (bc[at][0] !== null) continue;

    const region = (bc[at][1] as any)?._patchRegion as PatchRegion | undefined;
    if (!region) continue;

    const destPc = region.destPcOperand?.resolvedValue;
    ok(typeof destPc === "number", "encryptPatches: unresolved destPc");

    let k = (region.key ^ destPc) | 0;
    let encrypted = 0;

    for (let n = 0; n < region.instrCount; n++) {
      const target = bc[at + 1 + n];
      ok(target, "encryptPatches: region runs past end of bytecode");

      const cipher = flatten(target).map((word) => {
        k = (k + 0x9e3779b9) | 0;
        return (word ^ (k ^ (k >>> 13))) >>> 0;
      });
      encrypted += cipher.length;

      // Instruction boundaries are kept so the flat width — and every PC
      // downstream of it — is unchanged. `opaque` tells the serializer not to
      // read anything into these words (a cipher word can collide with a
      // specialized opcode by chance).
      const instr = [
        cipher[0],
        ...cipher.slice(1).map((word) => ({
          type: "number",
          resolvedValue: word,
        })),
      ] as unknown as Instruction;
      (instr as any).opaque = true;

      bc[at + 1 + n] = instr;
    }

    ok(
      encrypted === region.flatSize,
      `encryptPatches: region size mismatch (${encrypted} != ${region.flatSize})`,
    );
  }

  return { bytecode: bc };
}
