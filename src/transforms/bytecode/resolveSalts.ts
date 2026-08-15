// resolveSalts
// ───────────────────────────────────────────────────────────────────────────
// Fills in the MAKE_CLOSURE salt SEED — the operand that, once the handler has
// mixed it with the rest of the closure's metadata and the creating frame's own
// salt, yields what the new frame's SALT slot will hold.
//
// ── Why the salt is not simply emitted ───────────────────────────────────────
// A function's salt is the key material the whole MBA frame binding rests on: a
// generated handler is bound to one function by deriving a multiplier from the
// executing frame's SALT slot, or — see mba-utils' "Salt-selected semantics" —
// by folding it into a merged handler's operator selector.  Either way the
// attack is the same shape: collect the candidate salts, try each one, keep the
// one that makes the handler behave.
//
// Emitting the salt as a plain MAKE_CLOSURE immediate made collecting them
// free.  A linear disassembly of a five-function program hands over all five,
// and the rest is a search over a five-element set.  Two changes close that:
//
//   1. The frame slot holds E(salt) rather than the salt (Compiler.saltWord),
//      with E^-1 living only inside handler bodies fused into their MBA.
//   2. The operand is a seed, not the value.  The handler computes
//
//        saltWord = (imul(seed, mul) ^ mix) | 0
//        mix      = imul(startPc ^ regCount, mixB)
//                 ^ imul(paramCount + uvCount + hasRest, mixC)
//                 ^ regs[fp + SLOTS.SALT]        // the CREATING frame's salt
//
//      so recovering one salt requires having resolved labels and registers,
//      and having recovered the ENCLOSING function's salt first.  The closure
//      tree has to be walked from the root in order rather than scraped.
//
// This pass is what inverts that: `mul` is odd, so given the salt word it wants
// and the mix it can compute, `seed = imul(saltWord ^ mix, modInverse32(mul))`.
//
// ── Driven by the instruction stream, not by the descriptors ─────────────────
// Every MAKE_CLOSURE in the final bytecode is resolved on its own terms rather
// than one per function descriptor, because none of the obvious shortcuts hold:
// not every closure is created by the compiler (stringConcealing and dispatcher
// build MAKE_CLOSURE by hand, in a frame that has nothing to do with where their
// helper was compiled), a function can legitimately have NO MAKE_CLOSURE at all
// (a Template's own main body is discarded once its inner functions are lifted
// out), and one function can have several — each of which needs the seed its own
// creating frame calls for.
//
// The creating frame comes from the FN_PARENT_SYM stamp, not from where the
// instruction sits. Position is not reliable: selfModifying moves a patched
// region OUT of its function body, so a relocated MAKE_CLOSURE physically
// follows whatever label happens to precede its ciphertext. The stamp travels
// with the instruction object, which relocation preserves.
//
// ── Pipeline position ────────────────────────────────────────────────────────
// After resolveRegisters (regCount) and resolveLabels (startPc) — both feed the
// mix — and before encryptPatches, which replaces patched instructions with
// opaque cipher words and so must see their final operands.
// The root function has no MAKE_CLOSURE at all; its salt word is emitted
// directly as MAIN_SALT.

import type { Bytecode, Operand } from "../../types.ts";
import { Compiler, FN_PARENT_SYM } from "../../compiler.ts";

/** Operand index of the salt seed on MAKE_CLOSURE, matching the runtime's read order. */
const SALT_OPERAND_INDEX = 7;

/** The resolved u32 an operand slot carries, whatever form it is held in. */
function operandValue(operand: unknown): number | null {
  if (typeof operand === "number") return operand;
  if (operand && typeof operand === "object") {
    const resolved = (operand as { resolvedValue?: number }).resolvedValue;
    if (typeof resolved === "number") return resolved;
  }
  return null;
}

export function resolveSalts(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const { mul, inv, mixB, mixC } = compiler.SALT_DERIVE;
  const MAKE_CLOSURE = compiler.OP.MAKE_CLOSURE;

  let resolved = 0;

  for (const instr of bc) {
    if (instr[0] !== MAKE_CLOSURE) continue;

    // Which function this creates. The regCount operand names it exactly and
    // survives every rewrite (the entry label does not — resolveLabels turns it
    // into a number), and it doubles as the test for whether this is a real
    // MAKE_CLOSURE at all: selfModifying fills its junk arenas with random
    // opcodes, so a dead filler word can equal MAKE_CLOSURE by chance. Such an
    // instruction is unreachable by construction and carries no operands to
    // resolve, so it is skipped rather than diagnosed.
    const regCountOperand = instr[4] as
      | { type?: string; fnId?: number }
      | undefined;
    if (
      !regCountOperand ||
      typeof regCountOperand !== "object" ||
      regCountOperand.type !== "fnRegCount" ||
      regCountOperand.fnId === undefined
    )
      continue;
    const targetFnId = regCountOperand.fnId;

    const seed = instr[SALT_OPERAND_INDEX];
    // A hand-built site that still emits a plain number has not been updated to
    // the seed form, and would install a salt nothing agrees with — loudly, so
    // it cannot be missed the next time one is added.
    if (!seed || typeof seed !== "object") {
      throw new Error(
        `resolveSalts: MAKE_CLOSURE for fn ${targetFnId} has a literal salt ` +
          "operand — build it with Compiler.saltSeedOperand()",
      );
    }

    // Read the mix inputs off the instruction rather than off the descriptor:
    // what the handler mixes is what the bytecode stream hands it.
    const startPc = operandValue(instr[2]);
    const paramCount = operandValue(instr[3]);
    const regCount = operandValue(instr[4]);
    const uvCount = operandValue(instr[5]);
    const hasRest = operandValue(instr[6]);

    if (
      startPc === null ||
      paramCount === null ||
      regCount === null ||
      uvCount === null ||
      hasRest === null
    ) {
      throw new Error(
        `resolveSalts: unresolved MAKE_CLOSURE operand for fn ${targetFnId}`,
      );
    }

    // The frame this instruction executes in — whose SALT slot it reads.
    const parentFnId = (instr as unknown as Record<symbol, unknown>)[
      FN_PARENT_SYM
    ] as number | undefined;
    if (parentFnId === undefined) {
      throw new Error(
        `resolveSalts: MAKE_CLOSURE for fn ${targetFnId} was emitted without ` +
          "a creating-frame stamp — call Compiler.markClosureParent()",
      );
    }

    const mix =
      Math.imul(startPc ^ regCount, mixB) ^
      Math.imul(paramCount + uvCount + hasRest, mixC) ^
      compiler.saltWord(parentFnId);

    // imul(seed, mul) === saltWord ^ mix, and mul is odd — so invert it.
    const target = compiler.saltWord(targetFnId) ^ mix;
    (seed as Operand).resolvedValue = Math.imul(target, inv) >>> 0;
    resolved++;
  }

  compiler.log(`resolveSalts: ${resolved} closure salt seeds resolved`);

  return { bytecode: bc };
}
