// Compile-time-constant registers
// ───────────────────────────────────────────────────────────────────────────
// Which virtual registers hold a value that is fixed at build time, in the
// sense an attacker's constant propagation cares about: reachable by folding
// the bytecode alone, with no knowledge of the host, the arguments or any call.
//
// ── What it is for ───────────────────────────────────────────────────────────
// The MBA layer's budget is finite and its cost is real — every node in a
// handler body is executed once per dynamic dispatch of that opcode.  So it
// matters a great deal WHERE the budget is spent, and the measurement from the
// field is unambiguous: the four largest handlers in an analysed sample, a
// quarter of the whole handler table, cost the attacker nothing at all.  Their
// inputs were compile-time constants, so the devirtualizer never had to look at
// them — it executed each one against concrete state, folded the result to a
// literal, and deleted the instruction. Depth is worthless against an attacker
// who evaluates rather than simplifies.
//
// This says where that applies.  An instruction whose sources are all constant
// here is one whose handler will be folded away no matter how large it is, so
// it gets the small budget; the saving pays for the sites where expansion is
// actually load-bearing.
//
// The rule reverses when the instruction carries a TAINT operand: the fold
// needs a value for every input, and a taint operand is precisely an input the
// analysis has no value for (see utils/mba-taint.ts).  Callers check both.
//
// ── Soundness direction ──────────────────────────────────────────────────────
// This may under-report — call it a constant when it is not is what would be
// harmful, and the analysis only calls a register constant when EVERY write to
// it anywhere in the function is constant, which is stricter than the
// path-sensitive propagation an attacker runs.  Over-reporting is impossible;
// under-reporting merely means the budget is spent somewhere it need not be.

import type { Bytecode, Instruction, RegisterOperand } from "../types.ts";
import { Compiler } from "../compiler.ts";

// Opcodes whose destination is a pure function of their register sources and
// their immediates.  Everything else — calls, property reads, globals, upvalues
// — either reaches outside the bytecode or is not worth modelling.
const PURE_OP_NAMES = [
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "MOD",
  "EXP",
  "BAND",
  "BOR",
  "BXOR",
  "SHL",
  "SHR",
  "USHR",
  "LT",
  "GT",
  "LTE",
  "GTE",
  "EQ",
  "NEQ",
  "LOOSE_EQ",
  "LOOSE_NEQ",
  "UNARY_NEG",
  "UNARY_POS",
  "UNARY_NOT",
  "UNARY_BITNOT",
  "TYPEOF",
  "MOVE",
] as const;

// Opcodes that produce a constant with no register input at all.
const SOURCE_OP_NAMES = ["LOAD_INT", "LOAD_CONST"] as const;

function isRegister(operand: unknown): operand is RegisterOperand {
  return (
    !!operand &&
    typeof operand === "object" &&
    (operand as RegisterOperand).type === "register"
  );
}

const regKey = (r: RegisterOperand) => `${r.fnId}:${r.id}`;

export interface ConstRegs {
  /** True when every write to this register writes a build-time constant. */
  isConst(reg: RegisterOperand): boolean;
  /**
   * True when every REGISTER source of `instr` is constant — i.e. an attacker's
   * constant propagation can evaluate this instruction and fold it away.
   */
  isConstFed(instr: Instruction): boolean;
}

export function analyzeConstRegs(bc: Bytecode, compiler: Compiler): ConstRegs {
  const OP = compiler.OP as Record<string, number | undefined>;
  const MBA_OPS = compiler.MBA_OPS;

  const pure = new Set<number>();
  for (const name of PURE_OP_NAMES) {
    const value = OP[name];
    if (typeof value === "number") pure.add(value);
  }
  const sources = new Set<number>();
  for (const name of SOURCE_OP_NAMES) {
    const value = OP[name];
    if (typeof value === "number") sources.add(value);
  }

  // Generated MBA handlers are pure functions of their operands too — that is
  // the whole point of them — so a superoperator over constants is just as
  // foldable as the chain it replaced.
  const isFoldable = (op: number) =>
    pure.has(op) || sources.has(op) || op in MBA_OPS;

  // Start optimistic and remove: a register is constant until some write proves
  // otherwise. Iterating to a fixpoint is what makes a value that flows through
  // several registers before reaching a use resolve correctly.
  const constant = new Set<string>();
  const written = new Set<string>();

  for (const instr of bc) {
    const dst = instr[1];
    if (instr[0] !== null && isRegister(dst)) {
      written.add(regKey(dst));
      if (isFoldable(instr[0])) constant.add(regKey(dst));
    }
  }

  // A register nothing writes holds `undefined` for the frame's whole life,
  // which is as constant as it gets — but it is also exactly what a taint
  // operand points at when a function has nothing opaque in it, and treating it
  // as constant would let the budget shrink on the one site that most needs it.
  // Left out on purpose.

  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const instr of bc) {
      const op = instr[0];
      const dst = instr[1];
      if (op === null || !isRegister(dst)) continue;
      const key = regKey(dst);
      if (!constant.has(key)) continue;
      if (!isFoldable(op)) continue;

      for (let j = 2; j < instr.length; j++) {
        const src = instr[j];
        if (!isRegister(src)) continue;
        if (!written.has(regKey(src)) || !constant.has(regKey(src))) {
          constant.delete(key);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  const isConst = (reg: RegisterOperand) =>
    written.has(regKey(reg)) && constant.has(regKey(reg));

  return {
    isConst,
    isConstFed(instr: Instruction) {
      for (let j = 2; j < instr.length; j++) {
        const src = instr[j];
        if (isRegister(src) && !isConst(src)) return false;
      }
      return true;
    },
  };
}
