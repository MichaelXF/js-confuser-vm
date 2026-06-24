import type {
  Bytecode,
  Instruction,
  InstrOperand,
  RegisterOperand,
} from "../../types.ts";
import * as b from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { nextFreeSlot, U16_MAX } from "../../utils/op-utils.ts";
import {
  shuffle,
  getRandomInt,
  choice,
  chance,
} from "../../utils/random-utils.ts";
import { ref, allocReg, buildMaxIdMap } from "../../utils/pass-utils.ts";

// antiInstrumentation (bytecode side)
// ───────────────────────────────────────────────────────────────────────────
// Defeats "differential opcode analysis": an attacker who hooks the dispatch
// loop and records, per opcode, which registers were read/written and what
// transform fired. We hide a real opcode's footprint by fusing FAKE effects
// into it that operate on live-but-meaningless "fake" registers, and by
// shuffling the operand order (same scheme as aliasedOpcodes) so the real and
// fake operands can't be told apart positionally.
//
// The fake effects span a wide repertoire of opcodes so the fused footprint
// doesn't pattern-match any single real opcode: arithmetic, comparison, unary,
// MOVE, LOAD_INT / LOAD_CONST / LOAD_GLOBAL / TYPEOF_SAFE (real constant +
// global reads), never-taken conditional jumps, and empty/junk BUILD_ARRAY /
// BUILD_OBJECT.
//
// "Give fake values a home and a consumer":
//   • Each fused function gets a pool of fake registers, seeded at the
//     function's entry with a fake int / string / global value.
//   • Fake steps READ and WRITE those registers; within a basic block a freshly
//     written fake register is preferentially re-read by a later fake step, so
//     real-looking def-use chains form and an intra-handler liveness check sees
//     every fake write consumed.
//
// Correctness — every fake effect is TOTAL and side-effect free:
//   • Numeric / comparison / unary / typeof / move / load ops never throw on any
//     value the closed fake system can hold (number, string, boolean, array,
//     plain object, undefined). NaN / Infinity / string-concat are fine to leave
//     in a fake register.
//   • LOAD_GLOBAL only ever names a universally-present global (never throws).
//   • Fake conditional jumps use a dedicated always-truthy / always-falsy ANCHOR
//     register as the predicate (so they never branch) AND target a fall-through
//     label emitted right after the op (so they are a no-op even if taken).
//   • BUILD_ARRAY / BUILD_OBJECT use a tiny fixed element count (the runtime
//     handler reads the same element operand repeatedly — no overrun).
//
// Pipeline position — runs AFTER concealConstants (so the constant idx+key pairs
// it emits are final) and BEFORE specializedOpcodes / macroOpcodes /
// aliasedOpcodes. All three skip any opcode whose name is not an OP_ORIGINAL, so
// they leave the synthetic anti-ops untouched (specializedOpcodes was given that
// guard alongside this pass — otherwise it would specialize an anti-op and emit
// a case for a handler that the anti-instrumentation runtime pass generates
// later).

// Real opcodes we are willing to fuse, mapped to their fixed operand arity.
// All use only this._operand() (never this._constant()) so the runtime handler
// can be assembled by cloning the original case body verbatim.
const REAL_TARGET_ARITY: Record<string, number> = {
  ADD: 3,
  SUB: 3,
  MUL: 3,
  DIV: 3,
  MOD: 3,
  EXP: 3,
  BAND: 3,
  BOR: 3,
  BXOR: 3,
  SHL: 3,
  SHR: 3,
  USHR: 3,
  LT: 3,
  GT: 3,
  LTE: 3,
  GTE: 3,
  EQ: 3,
  NEQ: 3,
  LOOSE_EQ: 3,
  LOOSE_NEQ: 3,
  UNARY_NEG: 2,
  UNARY_POS: 2,
  UNARY_NOT: 2,
  UNARY_BITNOT: 2,
  MOVE: 2,
};

// A fake step is described by an ordered list of operand "slots". Each slot
// generates one or more bytecode operands; the count MUST equal the number of
// this._operand()/this._constant() reads the cloned handler body performs
// (this._constant() counts as two reads — idx + key).
type Slot =
  | "wReg" // write target  — a flowing fake register
  | "rReg" // read source   — a flowing fake register (block-local def-use bias)
  | "int" // raw small integer immediate
  | "cAny" // constant pair — any int/string value
  | "cGlobal" // constant pair — a universally-present global name
  | "cName" // constant pair — an arbitrary identifier-ish name
  | "predT" // truthy anchor register (predicate that is always truthy)
  | "predF" // falsy anchor register (predicate that is always falsy)
  | "label" // fall-through label (target of a never-taken jump)
  | "count"; // tiny fixed element count for BUILD_* (0..2)

function slotWidth(slot: Slot): number {
  return slot === "cAny" || slot === "cGlobal" || slot === "cName" ? 2 : 1;
}

// Pure, total fake ops keyed by name → operand-slot layout (in handler read
// order). None can throw or have an observable side effect.
const FAKE_OP_SLOTS: Record<string, Slot[]> = {
  // binary arithmetic / bitwise / comparison (3 operands)
  ADD: ["wReg", "rReg", "rReg"],
  SUB: ["wReg", "rReg", "rReg"],
  MUL: ["wReg", "rReg", "rReg"],
  DIV: ["wReg", "rReg", "rReg"],
  MOD: ["wReg", "rReg", "rReg"],
  EXP: ["wReg", "rReg", "rReg"],
  BAND: ["wReg", "rReg", "rReg"],
  BOR: ["wReg", "rReg", "rReg"],
  BXOR: ["wReg", "rReg", "rReg"],
  SHL: ["wReg", "rReg", "rReg"],
  SHR: ["wReg", "rReg", "rReg"],
  USHR: ["wReg", "rReg", "rReg"],
  LT: ["wReg", "rReg", "rReg"],
  GT: ["wReg", "rReg", "rReg"],
  LTE: ["wReg", "rReg", "rReg"],
  GTE: ["wReg", "rReg", "rReg"],
  EQ: ["wReg", "rReg", "rReg"],
  NEQ: ["wReg", "rReg", "rReg"],
  LOOSE_EQ: ["wReg", "rReg", "rReg"],
  LOOSE_NEQ: ["wReg", "rReg", "rReg"],
  // unary (2 operands)
  UNARY_NEG: ["wReg", "rReg"],
  UNARY_POS: ["wReg", "rReg"],
  UNARY_NOT: ["wReg", "rReg"],
  UNARY_BITNOT: ["wReg", "rReg"],
  TYPEOF: ["wReg", "rReg"],
  MOVE: ["wReg", "rReg"],
  // loads
  LOAD_INT: ["wReg", "int"],
  LOAD_CONST: ["wReg", "cAny"],
  LOAD_GLOBAL: ["wReg", "cGlobal"],
  TYPEOF_SAFE: ["wReg", "cName"],
  // never-taken conditional jumps
  JUMP_IF_FALSE: ["predT", "label"],
  JUMP_IF_TRUE: ["predF", "label"],
  // empty / junk collections
  BUILD_ARRAY: ["wReg", "count", "rReg"],
  BUILD_OBJECT: ["wReg", "count", "rReg", "rReg"],
};

// Globals guaranteed to exist in both node and browser, so a fake LOAD_GLOBAL
// never triggers the runtime's "is not defined" ReferenceError.
const SAFE_GLOBALS = [
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Error",
  "Function",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "Infinity",
  "NaN",
  "undefined",
];

// Flowing fake registers per fused function (read/written by fake steps), plus
// two never-written anchor registers used only as jump predicates. The count
// varies per function (and anchors are only minted when actually needed) so
// every fused function's entry doesn't share one fixed register-seeding shape.
const FLOWING_REGS_MIN = 2;
const FLOWING_REGS_MAX = 3;

// Number of fake steps fused per real op (bounds the visual / runtime weight).
const MIN_FAKE_STEPS = 2;
const MAX_FAKE_STEPS = 4;

const FAKE_OP_NAMES = Object.keys(FAKE_OP_SLOTS);

function randomString(min: number, max: number): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const len = getRandomInt(min, max);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[getRandomInt(0, chars.length - 1)];
  return s;
}

function randomFakeValue(): number | string {
  return getRandomInt(0, 1) === 0 ? getRandomInt(0, U16_MAX) : randomString(3, 8);
}

// Emit the (idx, key) constant operand pair that resolveConstants expects.
// We run AFTER concealConstants, so we produce the pair ourselves rather than
// relying on its single-operand expansion.
function constPair(value: number | string): InstrOperand[] {
  return [
    b.constantOperand(value),
    { type: "constant", value, key: true } as unknown as InstrOperand,
  ];
}

// Fresh, non-identity permutation of [0..n-1] (identity allowed only for n < 2).
function nonIdentityPermutation(n: number): number[] {
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return identity;
  let order: number[];
  let attempts = 0;
  do {
    order = shuffle([...identity]);
    attempts++;
  } while (attempts < 20 && order.every((v, i) => v === i));
  return order;
}

function findFnId(instr: Instruction): number | null {
  for (let i = 1; i < instr.length; i++) {
    const o = instr[i] as any;
    if (o && typeof o === "object" && o.type === "register") {
      return o.fnId as number;
    }
  }
  return null;
}

interface FakePool {
  flowing: RegisterOperand[];
  // Only minted for functions that actually fuse a fake JUMP_IF_FALSE/TRUE step.
  truthy?: RegisterOperand;
  falsy?: RegisterOperand;
}

export function antiInstrumentation(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // Current opcode value -> eligible target name (values may be randomized).
  const valueToName = new Map<number, string>();
  for (const name of Object.keys(REAL_TARGET_ARITY)) {
    const v = compiler.OP[name];
    if (typeof v === "number") valueToName.set(v, name);
  }

  // ── Pass 1: find fusable instructions; record which functions/ops occur ────
  const fnHasFusable = new Set<number>();
  const presentRealOps = new Set<number>();
  // fnId -> set of real opcode values fused somewhere in that function. Used
  // below to decide, per function, whether its register pool needs anchors.
  const fnRealOps = new Map<number, Set<number>>();
  for (const instr of bc) {
    const op = instr[0];
    if (op === null || !valueToName.has(op)) continue;
    const name = valueToName.get(op)!;
    if (instr.length - 1 !== REAL_TARGET_ARITY[name]) continue;
    const fnId = findFnId(instr);
    if (fnId === null) continue;
    fnHasFusable.add(fnId);
    presentRealOps.add(op);
    if (!fnRealOps.has(fnId)) fnRealOps.set(fnId, new Set());
    fnRealOps.get(fnId)!.add(op);
  }

  if (fnHasFusable.size === 0) return { bytecode: bc };

  // ── Pass 2: assign one synthetic anti-op per distinct real op present ──────
  // Each anti-op fuses the real op + a random list of fake steps, with the
  // real step shuffled to a random position among them (NOT pinned first) and
  // a fixed operand-order permutation. (Operand VALUES vary per instance;
  // structure is shared — exactly like aliasedOpcodes.)
  const antiByRealOp = new Map<number, number>();
  // antiOp -> per-step kind, aligned 1:1 with ANTI_OPS[antiOp].steps. The real
  // step carries no slots (its operands come from the instruction being fused).
  type StepKind = { real: true } | { real: false; slots: Slot[] };
  const stepKindsByAnti = new Map<number, StepKind[]>();
  // antiOp -> whether any fused fake step is a never-taken jump (needs anchors).
  const antiNeedsAnchors = new Map<number, boolean>();

  for (const realOp of presentRealOps) {
    const antiOp = nextFreeSlot(compiler);
    if (antiOp === -1) break;

    const name = valueToName.get(realOp)!;
    const realArity = REAL_TARGET_ARITY[name];

    const fakeCount = getRandomInt(MIN_FAKE_STEPS, MAX_FAKE_STEPS);
    const fakeStepDefs: { op: number; arity: number; slots: Slot[] }[] = [];
    for (let f = 0; f < fakeCount; f++) {
      const fakeName = choice(FAKE_OP_NAMES);
      const slots = FAKE_OP_SLOTS[fakeName];
      const arity = slots.reduce((acc, s) => acc + slotWidth(s), 0);
      fakeStepDefs.push({ op: compiler.OP[fakeName] as number, arity, slots });
    }

    // Shuffle the real step in among the fake ones — its position in the
    // fused effect sequence must not be a fixed, fingerprintable slot.
    const allSteps = shuffle([
      { op: realOp, arity: realArity, real: true as const, slots: undefined },
      ...fakeStepDefs.map((d) => ({
        op: d.op,
        arity: d.arity,
        real: false as const,
        slots: d.slots,
      })),
    ]);

    const totalArity = allSteps.reduce((acc, s) => acc + s.arity, 0);
    const order = nonIdentityPermutation(totalArity);

    antiByRealOp.set(realOp, antiOp);
    stepKindsByAnti.set(
      antiOp,
      allSteps.map((s): StepKind =>
        s.real ? { real: true } : { real: false, slots: s.slots! },
      ),
    );
    antiNeedsAnchors.set(
      antiOp,
      allSteps.some(
        (s) => !s.real && (s.slots!.includes("predT") || s.slots!.includes("predF")),
      ),
    );
    compiler.ANTI_OPS[antiOp] = {
      steps: allSteps.map((s) => ({ op: s.op, arity: s.arity })),
      order,
    };
    compiler.OP_NAME[antiOp] = `ANTI_${name}_${order.join("_")}`;
  }

  if (antiByRealOp.size === 0) return { bytecode: bc };

  // ── Pass 3: mint a fake-register pool + entry seeds per fused function ─────
  // Allocate ids ABOVE every register already present (buildMaxIdMap), exactly
  // like dispatcher / controlFlowFlattening do. Using ctx._newReg() would be
  // unsafe: those passes don't bump ctx._nextId, so it is stale and its ids
  // collide with registers they added — corrupting real state.
  const maxId = buildMaxIdMap(bc);
  const poolByFn = new Map<number, FakePool>();
  const seedsByFn = new Map<number, Instruction[]>();
  const LOAD_CONST = compiler.OP.LOAD_CONST as number;

  for (const fnId of fnHasFusable) {
    const desc = compiler.fnDescriptors[fnId];
    if (!desc) continue;

    // Only mint anchors if some real op fused into this function actually
    // uses one — most functions won't, so they simply don't appear.
    const needsAnchors = Array.from(fnRealOps.get(fnId) ?? []).some((realOp) => {
      const antiOp = antiByRealOp.get(realOp);
      return antiOp !== undefined && antiNeedsAnchors.get(antiOp) === true;
    });

    const flowingCount = getRandomInt(FLOWING_REGS_MIN, FLOWING_REGS_MAX);
    const pendingSeeds: { reg: RegisterOperand; value: number | string }[] = [];

    const flowing: RegisterOperand[] = [];
    for (let k = 0; k < flowingCount; k++) {
      const reg = allocReg(fnId, maxId);
      flowing.push(reg);
      pendingSeeds.push({ reg, value: randomFakeValue() });
    }

    let truthy: RegisterOperand | undefined;
    let falsy: RegisterOperand | undefined;
    if (needsAnchors) {
      // Anchors: never written by fake steps, so they stay constant.
      truthy = allocReg(fnId, maxId);
      falsy = allocReg(fnId, maxId);
      pendingSeeds.push({ reg: truthy, value: getRandomInt(1, U16_MAX) }); // always truthy
      pendingSeeds.push({ reg: falsy, value: 0 }); // always falsy
    }

    // Randomize emission order — a fixed LOAD_CONST/LOAD_THIS shape at every
    // fused function's entry is itself a fingerprint.
    shuffle(pendingSeeds);
    const seeds: Instruction[] = pendingSeeds.map(({ reg, value }) => [
      LOAD_CONST,
      ref(reg),
      ...constPair(value),
    ]);

    poolByFn.set(fnId, { flowing, truthy, falsy });
    seedsByFn.set(fnId, seeds);
  }

  // entryLabel -> fnId, for the functions we are seeding.
  const seededEntry = new Map<string, number>();
  for (const fnId of seedsByFn.keys()) {
    const desc = compiler.fnDescriptors[fnId];
    if (desc?.entryLabel) seededEntry.set(desc.entryLabel, fnId);
  }

  // ── Pass 4: rewrite eligible instructions + inject entry seeds ─────────────
  const result: Bytecode = [];
  let afterLabelCounter = 0;
  // Block-local def-use: fake registers written earlier in the current basic
  // block, preferentially re-read so the fake data flow looks real.
  let recentWrites: RegisterOperand[] = [];

  for (const instr of bc) {
    const op = instr[0];

    if (op === null) {
      result.push(instr);
      const operand = instr[1] as any;
      if (operand?.type === "defineLabel") {
        recentWrites = []; // basic-block boundary
        if (seededEntry.has(operand.label)) {
          for (const seed of seedsByFn.get(seededEntry.get(operand.label)!)!)
            result.push(seed);
        }
      }
      continue;
    }

    const antiOp = antiByRealOp.get(op);
    if (antiOp === undefined) {
      result.push(instr);
      continue;
    }

    const name = valueToName.get(op)!;
    if (instr.length - 1 !== REAL_TARGET_ARITY[name]) {
      result.push(instr);
      continue;
    }

    const fnId = findFnId(instr);
    if (fnId === null || !poolByFn.has(fnId)) {
      result.push(instr);
      continue;
    }

    const { order } = compiler.ANTI_OPS[antiOp];
    const pool = poolByFn.get(fnId)!;
    const stepKinds = stepKindsByAnti.get(antiOp)!;

    let afterLabel: string | null = null;

    const genSlot = (slot: Slot): InstrOperand[] => {
      switch (slot) {
        case "wReg": {
          const reg = choice(pool.flowing);
          recentWrites.push(reg);
          if (recentWrites.length > 8) recentWrites.shift();
          return [ref(reg)];
        }
        case "rReg": {
          const reg =
            recentWrites.length > 0 && chance(70)
              ? choice(recentWrites)
              : choice(pool.flowing);
          return [ref(reg)];
        }
        case "int":
          return [getRandomInt(0, U16_MAX)];
        case "cAny":
          return constPair(randomFakeValue());
        case "cGlobal":
          return constPair(choice(SAFE_GLOBALS));
        case "cName":
          return constPair(randomString(3, 10));
        case "predT":
          return [ref(pool.truthy!)];
        case "predF":
          return [ref(pool.falsy!)];
        case "count":
          return [getRandomInt(0, 2)];
        case "label": {
          if (afterLabel === null)
            afterLabel = `anti_after_${afterLabelCounter++}`;
          return [{ type: "label", label: afterLabel } as InstrOperand];
        }
      }
    };

    // Canonical operand order follows the (shuffled) step order: wherever the
    // real step landed, its operands come from the instruction being fused;
    // every fake step contributes its own slots in turn.
    const canonical: InstrOperand[] = [];
    for (const sk of stepKinds) {
      if (sk.real) {
        canonical.push(...(instr.slice(1) as InstrOperand[]));
      } else {
        for (const slot of sk.slots) canonical.push(...genSlot(slot));
      }
    }

    if (canonical.length !== order.length) {
      result.push(instr);
      continue;
    }

    // Store shuffled: bytecode slot i holds canonical operand order[i].
    const shuffled = order.map((i) => canonical[i]);
    const newInstr: Instruction = [antiOp, ...shuffled];
    (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
    result.push(newInstr);

    // A never-taken fake jump targets the instruction right after this op, so
    // even an (impossible) taken branch is a harmless fall-through.
    if (afterLabel !== null) {
      result.push([null, { type: "defineLabel", label: afterLabel }]);
    }
  }

  return { bytecode: result };
}
