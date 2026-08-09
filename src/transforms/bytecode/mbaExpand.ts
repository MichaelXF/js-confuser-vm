// mbaExpand (bytecode side)
// ───────────────────────────────────────────────────────────────────────────
// Rewrites integer operations in the USER's bytecode into Mixed Boolean-
// Arithmetic, so nothing in the instruction stream still looks like `a + b`.
//
// Eligibility comes from analysis/int-types.ts, which runs on the AST before
// compilation.  The join between the two is SOURCE_NODE_SYM: the Compiler
// stamps the originating AST node on every instruction it emits, so this pass
// can ask "was the node behind this ADD proven integral?" without the analysis
// or the MBA ever being visible to the Compiler itself.
//
// ── Two shapes per site, chosen at random ────────────────────────────────────
//
//   EXPANSION — replace the instruction with a run of ordinary opcodes
//     (BXOR / BAND / BOR / ADD / SUB / …) that computes an MBA identity.
//     There is no new handler to fingerprint, the identity is different at
//     EVERY site, and because this pass runs before controlFlowFlattening the
//     resulting run gets scattered across the dispatch state machine — so an
//     expression-level simplifier never sees a whole expression to simplify.
//
//   HANDLER — keep the instruction and its operands exactly as they are, but
//     point it at a generated MBA_* opcode whose handler computes the identity
//     (see transforms/runtime/mbaOpcodes.ts).  Costs no bytecode, and a
//     devirtualizer that matches handler bodies against a template table fails
//     to classify it at all.
//
// Mixing both means neither failure mode is the only one an attacker meets.
//
// ── Tier 0 vs Tier 1 ─────────────────────────────────────────────────────────
// Tier 0 (`& | ^`, `~`) is eligible unconditionally — JavaScript defines those
// to produce int32 from any input.  Because that means the operands themselves
// may be anything, they are normalised with `~~` before the identity runs;
// otherwise a rule that reaches for `x + y` would see string concatenation.
// Tier 1 (`+ - < > <= >= === !==`, unary `-`) relies on the analysis instead,
// which has already proven both operands integral, so no normalisation.
//
// ── Pipeline position ────────────────────────────────────────────────────────
// First bytecode pass: before controlFlowFlattening (so CFF scatters the
// expansions) and well before resolveRegisters (so its temporaries take part in
// normal liveness-aware slot assignment).

import type { Bytecode, Instruction, RegisterOperand } from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { nextFreeSlot } from "../../utils/op-utils.ts";
import { chance, choice } from "../../utils/random-utils.ts";
import { allocReg, buildMaxIdMap } from "../../utils/pass-utils.ts";
import type { IntFacts } from "../../analysis/int-types.ts";
import {
  asBoolean,
  createMBAEmitContext,
  emitMBA,
  mVar,
  mbaAddExpr,
  mbaBNotExpr,
  mbaBinExpr,
  mbaEqExpr,
  mbaGtExpr,
  mbaGteExpr,
  mbaLtExpr,
  mbaLteExpr,
  mbaNeExpr,
  mbaNegExpr,
  mbaNodeCount,
  mbaSubExpr,
  mbaVarNames,
  type MBAEmitContext,
  type MBAExpr,
  type MBAOptions,
} from "../../utils/mba-utils.ts";

// % of eligible sites that become a generated MBA_* opcode rather than an
// inline expansion.  Expansion is the stronger of the two (per-site identities,
// scattered by CFF), so it stays the majority.
const HANDLER_CHANCE = 35;

// Distinct handler variants generated per original opcode.  Each carries its
// own synthesized identity, so `MBA_ADD_0` and `MBA_ADD_2` do not share a body.
const VARIANTS_PER_OP = 3;

// Depth 2 already nests several identities per site. Every site draws its own,
// so diversity comes from the number of sites rather than from depth.
const MBA_DEPTH = 2;

// Handlers are budgeted far more generously than inline expansions, because
// they are nearly free: the instruction keeps its operands, so a richer body
// costs no bytecode at all — just one shared function per opcode variant.
// A short body is the real risk here. `~~(a + k * a + b)` is technically
// key-dependent but small enough to invite a guess-and-check ("what if that
// term is zero?"), so the settings below push the average body to ~900
// characters and MIN_HANDLER_NODES rejects any draw that still comes out thin.
const HANDLER_MBA: MBAOptions = {
  depth: 3,
  leafDepth: 2,
  identityChance: 80,
  zeroVarChance: 60,
};
const MIN_HANDLER_NODES = 40;
const HANDLER_DRAW_ATTEMPTS = 24;

// Frame binding
// ───────────────────────────────────────────────────────────────────────────
// A generated handler can reach something the inline expansion cannot: the VM's
// own execution state. The useful way to spend that is NOT as another noise
// operand — an operand fed to an identity rule cancels for whatever value it
// holds, so a reader deletes it by inspection and the state dependency is
// decoration.
//
// Instead the handler is bound to the frame's REGISTER COUNT, which genuinely
// differs from function to function. `v` is a scrambled odd value derived from
// it at runtime; `c` is the modular inverse of the value the handler's own
// function is expected to have, baked in at build time. Multiplying by both
// returns the operand unchanged — but only in a frame whose register count
// matches. Anywhere else the handler computes garbage.
//
// The scrambling matters. Using the register count directly would make `v`
// small, and the inverse of a small number is a well-known constant —
// modInverse32(3) is 0xAAAAAAAB, which is recognisable on sight, and a count of
// 0 collapses to a no-op entirely. Mixing through a random multiply and XOR
// first puts `v` anywhere in the 32-bit range, so its inverse is just another
// opaque word.
//
// See FRAME_BOUND_RULES in mba-utils for the algebra and for the honest limits
// of what this buys.
const FRAME_VAR = "v";
const FRAME_INV_VAR = "c";

// % of handler sites that are frame-bound rather than generic. Mixed so an
// attacker cannot assume any given handler is one kind or the other.
const FRAME_BOUND_CHANCE = 60;

interface OpSpec {
  /** 0 = int32 by JS spec (needs operand normalisation); 1 = analysis-gated. */
  tier: 0 | 1;
  /** Operand slots on the instruction, including the destination. */
  arity: 2 | 3;
  build: (a: MBAExpr, b: MBAExpr | null, o: MBAOptions) => MBAExpr;
}

const OP_SPECS: Record<string, OpSpec> = {
  // ── Tier 0 ────────────────────────────────────────────────────────────────
  BAND: { tier: 0, arity: 3, build: (a, b, o) => mbaBinExpr("&", a, b!, o) },
  BOR: { tier: 0, arity: 3, build: (a, b, o) => mbaBinExpr("|", a, b!, o) },
  BXOR: { tier: 0, arity: 3, build: (a, b, o) => mbaBinExpr("^", a, b!, o) },
  UNARY_BITNOT: { tier: 0, arity: 2, build: (a, _b, o) => mbaBNotExpr(a, o) },

  // ── Tier 1 ────────────────────────────────────────────────────────────────
  ADD: { tier: 1, arity: 3, build: (a, b, o) => mbaAddExpr(a, b!, o) },
  SUB: { tier: 1, arity: 3, build: (a, b, o) => mbaSubExpr(a, b!, o) },
  UNARY_NEG: { tier: 1, arity: 2, build: (a, _b, o) => mbaNegExpr(a, o) },
  LT: { tier: 1, arity: 3, build: (a, b, o) => mbaLtExpr(a, b!, o) },
  GT: { tier: 1, arity: 3, build: (a, b, o) => mbaGtExpr(a, b!, o) },
  LTE: { tier: 1, arity: 3, build: (a, b, o) => mbaLteExpr(a, b!, o) },
  GTE: { tier: 1, arity: 3, build: (a, b, o) => mbaGteExpr(a, b!, o) },
  // The comparison results feed user variables, not just jump predicates, so
  // they are coerced to real booleans — `x === y` must not start yielding 1.
  EQ: { tier: 1, arity: 3, build: (a, b, o) => asBoolean(mbaEqExpr(a, b!, o)) },
  NEQ: { tier: 1, arity: 3, build: (a, b, o) => asBoolean(mbaNeExpr(a, b!, o)) },
};

function isRegister(operand: unknown): operand is RegisterOperand {
  return (
    !!operand &&
    typeof operand === "object" &&
    (operand as RegisterOperand).type === "register"
  );
}

// Copy an operand, preserving `kind` / `scopeId` / `pinned`.  Operand objects
// must be unique (passes mutate them in place), but resolveRegisters reads the
// pool key off each instance — so a copy that dropped the metadata would split
// one virtual register across two pools.
function cloneReg(r: RegisterOperand): RegisterOperand {
  return { ...r };
}

function findFnId(instr: Instruction): number | null {
  for (let i = 1; i < instr.length; i++) {
    const o = instr[i];
    if (isRegister(o)) return o.fnId;
  }
  return null;
}

export function mbaExpand(
  bc: Bytecode,
  compiler: Compiler,
  facts: IntFacts,
): { bytecode: Bytecode } {
  const OP = compiler.OP;

  // Current opcode value → spec.  Values may be randomized, so go through OP.
  const specByOp = new Map<number, { name: string; spec: OpSpec }>();
  for (const name of Object.keys(OP_SPECS)) {
    const value = OP[name];
    if (typeof value === "number")
      specByOp.set(value, { name, spec: OP_SPECS[name] });
  }

  const maxId = buildMaxIdMap(bc);
  const emitCtxByFn = new Map<number, MBAEmitContext>();
  // Two reusable `~~` normalisation temporaries per function.  Each is written
  // and consumed within a single site, so one pair serves every site.
  const normRegsByFn = new Map<number, [RegisterOperand, RegisterOperand]>();
  // opName → generic MBA_* opcodes, minted on first use.
  const variantsByName = new Map<string, number[]>();
  // "opName:fnId" → the single frame-bound MBA_* opcode for that pair.
  const frameBoundVariants = new Map<string, number | null>();

  const emitCtxFor = (fnId: number): MBAEmitContext => {
    let ctx = emitCtxByFn.get(fnId);
    if (!ctx) {
      ctx = createMBAEmitContext(compiler, fnId, maxId);
      emitCtxByFn.set(fnId, ctx);
    }
    return ctx;
  };

  const normRegsFor = (fnId: number): [RegisterOperand, RegisterOperand] => {
    let pair = normRegsByFn.get(fnId);
    if (!pair) {
      pair = [allocReg(fnId, maxId), allocReg(fnId, maxId)];
      normRegsByFn.set(fnId, pair);
    }
    return pair;
  };

  // Three shapes of expression, by where the result will live:
  //   • expansion — bytecode, so no VM state and no imul
  //   • generic handler — richer budget, still only the operands
  //   • frame-bound handler — adds `v` / `c`, which bind it to one function
  const buildExpr = (
    spec: OpSpec,
    kind: "expansion" | "handler" | "frameBound",
  ): MBAExpr => {
    const binary = spec.arity === 3;
    // The instruction's own operands double as the noise pool: they are
    // guaranteed live and (for tier 1) guaranteed integral, and entangling the
    // two real operands is exactly the dependency an analysis has to untangle.
    const noise = binary ? ["a", "b"] : ["a"];
    return spec.build(mVar("a"), binary ? mVar("b") : null, {
      depth: MBA_DEPTH,
      noise,
      ...(kind === "expansion" ? {} : HANDLER_MBA),
      // Deliberately NOT added to `noise`: the binding is only worth carrying
      // in positions where its value matters, so every appearance of it is
      // load-bearing rather than cancellable.
      ...(kind === "frameBound"
        ? { frameVar: FRAME_VAR, invVar: FRAME_INV_VAR }
        : {}),
    });
  };

  // Expansion is random, so a draw can come back thin, or (for a frame-bound
  // variant) without the binding at all. Handlers are generated once, so simply
  // redrawing until both hold turns a likelihood into a guarantee.
  const buildHandlerExpr = (
    spec: OpSpec,
    kind: "handler" | "frameBound",
  ): MBAExpr => {
    let best = buildExpr(spec, kind);
    for (let attempt = 0; attempt < HANDLER_DRAW_ATTEMPTS; attempt++) {
      const boundOk =
        kind !== "frameBound" || mbaVarNames(best).includes(FRAME_VAR);
      if (boundOk && mbaNodeCount(best) >= MIN_HANDLER_NODES) return best;
      best = buildExpr(spec, kind);
    }
    return best;
  };

  const newVariant = (
    name: string,
    spec: OpSpec,
    originalOp: number,
    fnId: number | null,
    label: string,
  ): number | null => {
    const slot = nextFreeSlot(compiler);
    if (slot === -1) return null;
    compiler.MBA_OPS[slot] = {
      originalOp,
      arity: spec.arity,
      expr: buildHandlerExpr(spec, fnId === null ? "handler" : "frameBound"),
      normalize: spec.tier === 0,
      // Non-null means the runtime pass bakes this function's register count
      // into the handler; the handler is then only correct inside it.
      fnId,
    };
    compiler.OP_NAME[slot] = `MBA_${name}_${label}`;
    return slot;
  };

  // Generic variants: a small shared pool per opcode.
  const genericVariantFor = (
    name: string,
    spec: OpSpec,
    originalOp: number,
  ) => {
    let list = variantsByName.get(name);
    if (!list) {
      list = [];
      for (let i = 0; i < VARIANTS_PER_OP; i++) {
        const slot = newVariant(name, spec, originalOp, null, String(i));
        if (slot === null) break;
        list.push(slot);
      }
      variantsByName.set(name, list);
    }
    return list.length > 0 ? choice(list) : null;
  };

  // Frame-bound variants: exactly ONE per (opcode, function). The function
  // already supplies the diversity, so minting three would only multiply the
  // handler count for no gain.
  const frameBoundVariantFor = (
    name: string,
    spec: OpSpec,
    originalOp: number,
    fnId: number,
  ) => {
    const key = `${name}:${fnId}`;
    if (!frameBoundVariants.has(key)) {
      frameBoundVariants.set(
        key,
        newVariant(name, spec, originalOp, fnId, `f${fnId}`),
      );
    }
    return frameBoundVariants.get(key) ?? null;
  };

  const result: Bytecode = [];
  let expanded = 0;
  let handlers = 0;

  for (const instr of bc) {
    const op = instr[0];
    const entry = op === null ? undefined : specByOp.get(op);

    if (!entry || instr.length - 1 !== entry.spec.arity) {
      result.push(instr);
      continue;
    }

    const sourceNode = (instr as unknown as Record<symbol, unknown>)[
      SOURCE_NODE_SYM
    ];
    // Compiler-internal instructions carry no source node (Template strips it),
    // so they are never eligible — exactly the right default.
    if (!sourceNode || !facts.isMBASafe(sourceNode as never)) {
      result.push(instr);
      continue;
    }

    const { name, spec } = entry;
    const binary = spec.arity === 3;
    const dst = instr[1];
    const srcA = instr[2];
    const srcB = binary ? instr[3] : null;

    if (
      !isRegister(dst) ||
      !isRegister(srcA) ||
      (binary && !isRegister(srcB)) ||
      findFnId(instr) === null
    ) {
      result.push(instr);
      continue;
    }

    // ── Handler form: same operands, different opcode ──────────────────────
    if (chance(HANDLER_CHANCE)) {
      const siteFnId = findFnId(instr)!;
      const variant = chance(FRAME_BOUND_CHANCE)
        ? frameBoundVariantFor(name, spec, op as number, siteFnId)
        : genericVariantFor(name, spec, op as number);
      if (variant !== null) {
        const replacement: Instruction = [
          variant,
          ...(instr.slice(1) as Instruction[number][]),
        ];
        (replacement as unknown as Record<symbol, unknown>)[SOURCE_NODE_SYM] =
          sourceNode;
        result.push(replacement);
        handlers++;
        continue;
      }
    }

    // ── Expansion form: a run of ordinary opcodes ──────────────────────────
    const fnId = findFnId(instr)!;
    const ctx = emitCtxFor(fnId);
    const out: Bytecode = [];

    let regA = srcA;
    let regB = srcB;

    if (spec.tier === 0) {
      // `~~x` is ToInt32(x) in two instructions and needs no zero register.
      // Done as real instructions rather than inside the MBA tree: a rule that
      // rewrote `~` into `-x - 1` would change what happens to a non-numeric
      // operand, whereas the identity itself is exact once the inputs are int32.
      const [n0, n1] = normRegsFor(fnId);
      out.push([OP.UNARY_BITNOT!, cloneReg(n0), cloneReg(srcA)]);
      out.push([OP.UNARY_BITNOT!, cloneReg(n0), cloneReg(n0)]);
      regA = n0;
      if (binary) {
        out.push([OP.UNARY_BITNOT!, cloneReg(n1), cloneReg(srcB!)]);
        out.push([OP.UNARY_BITNOT!, cloneReg(n1), cloneReg(n1)]);
        regB = n1;
      }
    }

    const env = new Map<string, RegisterOperand>([["a", regA]]);
    if (binary) env.set("b", regB!);

    const resultReg = emitMBA(out, buildExpr(spec, "expansion"), env, ctx);
    // The destination is written last, so a site like `x = x & y` (where dst
    // aliases a source) is safe.
    out.push([OP.MOVE!, cloneReg(dst), cloneReg(resultReg)]);

    for (const emitted of out) {
      (emitted as unknown as Record<symbol, unknown>)[SOURCE_NODE_SYM] =
        sourceNode;
      result.push(emitted);
    }
    expanded++;
  }

  compiler.log(
    `mbaExpand: ${expanded} expanded, ${handlers} handler sites, ` +
      `${Object.keys(compiler.MBA_OPS).length} generated opcodes`,
  );

  return { bytecode: result };
}
