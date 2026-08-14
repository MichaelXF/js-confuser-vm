// Taint operands
// ───────────────────────────────────────────────────────────────────────────
// Everything else in the MBA layer is aimed at the attack that IDENTIFIES a
// handler: sample it over its operands, match the results against a table of
// JavaScript operators, read off the semantics.  This is aimed at the other
// one, which is both simpler and more damaging.
//
// A devirtualizer undoes control-flow flattening by constant propagation.  It
// walks the state machine with a concrete register map, EXECUTES each handler
// against it, and reads the next state out of the result — at which point every
// computed jump is an ordinary edge again and the flattening is gone.  None of
// merging, frame-binding or domain restriction touches that: they all change
// what a handler looks like, and constant propagation never looks.  What it
// needs is the one thing the state machine currently gives it — a value for
// every input.
//
// So take one away.  A taint operand is a register the handler reads and whose
// value it provably does not depend on: it enters only through cancelling
// identity rules, so the handler computes the same result for every value it
// could hold.  The compiled program is unaffected.  The analysis is not:
//
//   • the register is one the analysis has no value for, so executing the
//     handler against concrete state reads an unknown;
//   • the result therefore widens to unknown, and so does the state register;
//   • the dispatch chain then decides nothing, and the computed jump is
//     unresolved.
//
// ── Correctness ──────────────────────────────────────────────────────────────
// The operand is coerced with `~~` like every other source (`normalize` is set
// on every generated handler), so it is an int32 whatever the register holds —
// including `undefined`, which coerces to 0.  Every rule that consumes it is an
// identity for all of Z/2^32.  Nothing about WHICH register is picked can make
// the result wrong; the picking below is entirely about how much the choice
// costs an attacker.  The build-time fit check re-verifies the invariance
// rather than trusting this comment (see utils/mba-fit-check.ts).
//
// ── Honest limit ─────────────────────────────────────────────────────────────
// An analysis can defeat this by testing for irrelevance: run the handler twice
// with different values in the unknown register, and if the output does not
// move, treat the register as no input at all.  That is maybe thirty lines.
// What survives it is a taint operand carrying a DOMAIN — where the output does
// move for the values a prober substitutes and does not for the values a real
// execution supplies.  The two compose, and neither is a substitute for the
// other: see mba-utils' "Domain-restricted identities".

import type { Bytecode, RegisterOperand } from "../types.ts";
import { Compiler } from "../compiler.ts";
import { allocReg } from "./pass-utils.ts";
import { choice } from "./random-utils.ts";

// Opcodes whose destination register holds a value no static analysis of the
// bytecode alone can produce: it came from the host, from a call, or from a
// property of an object the analysis does not have.
//
// A register defined by one of these is the best taint source available,
// because it is unknown to an attacker even after they close the "uninitialized
// registers read as undefined" hole that the fallback below leaves open.
const OPAQUE_DEFINING_OPS = [
  "CALL",
  "CALL_METHOD",
  "NEW",
  "GET_PROP",
  "LOAD_GLOBAL",
  "LOAD_UPVALUE",
  "LOAD_THIS",
  "TYPEOF_SAFE",
  "FOR_IN_NEXT",
] as const;

function isRegister(operand: unknown): operand is RegisterOperand {
  return (
    !!operand &&
    typeof operand === "object" &&
    (operand as RegisterOperand).type === "register"
  );
}

/**
 * A register for this function's handlers to read as taint.
 *
 * Prefers one an opaque instruction defines; falls back to a fresh pinned
 * register, which is never written and so holds `undefined` for the whole
 * frame.  The fallback is weaker (an attacker who models uninitialized slots
 * gets a value for it) but it is never wrong, and it keeps every function
 * taintable rather than only the ones that happen to call something.
 *
 * The returned operand is a template — copy it (`{ ...reg }`) at each use site,
 * since passes mutate operand objects in place.
 */
export function pickTaintRegister(
  instrs: Bytecode,
  compiler: Compiler,
  fnId: number,
  maxId: Map<number, number>,
): RegisterOperand {
  const OP = compiler.OP as Record<string, number | undefined>;
  const opaque = new Set<number>();
  for (const name of OPAQUE_DEFINING_OPS) {
    const value = OP[name];
    if (typeof value === "number") opaque.add(value);
  }

  const candidates: RegisterOperand[] = [];
  for (const instr of instrs) {
    const op = instr[0];
    if (op === null || !opaque.has(op)) continue;
    const dst = instr[1];
    // Only this function's own registers: an operand of another function's
    // frame would be read out of the wrong register window.
    if (isRegister(dst) && dst.fnId === fnId) candidates.push(dst);
  }

  // Copied with `kind` / `scopeId` / `pinned` intact, so the read joins the
  // register's existing pool instead of forking it. All the extra appearance
  // does is widen the live range resolveRegisters computes, which is
  // conservative — and reading a slot that has since been recycled would be
  // harmless anyway, since no value here can make the handler wrong.
  if (candidates.length > 0) return { ...choice(candidates) };

  // Nothing opaque in this function. A fresh register is never written, so it
  // holds `undefined` for the frame's whole life and coerces to 0 — still
  // unknown to an analysis that does not model uninitialized slots. allocReg
  // leaves `kind` unset, which puts it in the non-reusing "local::" pool.
  return allocReg(fnId, maxId);
}
