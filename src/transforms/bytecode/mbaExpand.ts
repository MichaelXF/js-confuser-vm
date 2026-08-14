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
import {
  Compiler,
  MBA_DOMAINS_SYM,
  MBA_SAFE_SYM,
  SOURCE_NODE_SYM,
  type MBAOperandDomains,
  type MBASafeMark,
} from "../../compiler.ts";
import { nextFreeSlot } from "../../utils/op-utils.ts";
import { chance, choice } from "../../utils/random-utils.ts";
import { allocReg, buildMaxIdMap } from "../../utils/pass-utils.ts";
import type { IntFacts } from "../../analysis/int-types.ts";
import { analyzeConstRegs } from "../../analysis/const-regs.ts";
import { pickTaintRegister } from "../../utils/mba-taint.ts";
import {
  KEY_TAG_BITS,
  asBoolean,
  createMBAEmitContext,
  emitMBA,
  entangleMBA,
  findSelectorOperand,
  frameKeyConstants,
  mVar,
  makeSelectorKey,
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
  mbaSelectExpr,
  mbaSubExpr,
  mbaVarNames,
  poisonMBA,
  poisonedLeaf,
  type FrameKey,
  type MBADomain,
  type MBAEmitContext,
  type MBAExpr,
  type MBAOptions,
  type SelectorKey,
} from "../../utils/mba-utils.ts";

// % of eligible sites that become a generated MBA_* opcode rather than an
// inline expansion.
//
// Without flattening, expansion is the better of the two — a per-site identity
// with no handler to fingerprint — so it stays the majority.
//
// WITH flattening the two are effectively incompatible, and not by a small
// margin.  controlFlowFlattening splits a function every MAX_BLOCK_SIZE
// instructions, so a single expansion becomes ten or more blocks; the dispatch
// chain grows with the block count AND is walked once per state transition, so
// the cost goes with the square of it.  Measured on a 12-iteration bit mixer,
// six seeds: at 35% two of six runs blew past a 20s cap; at 90% the survivors
// ranged 0.4s to 8s; at 100% every seed lands between 0.33s and 0.61s, and the
// output shrinks with it.  The variance is the tell — it was entirely down to
// how many sites happened to draw the expansion.
//
// Nothing is lost by it.  A handler adds no blocks at all, and it is the
// stronger form anyway: handlers are key-selected and frame-bound, while an
// inline expansion sits in the open where an evaluation-based simplifier can
// reach it.
const handlerChanceFor = (compiler: Compiler) =>
  compiler.options.controlFlowFlattening ? 100 : 35;

// Distinct handler variants generated per original opcode.  Each carries its
// own synthesized identity, so `MBA_ADD_0` and `MBA_ADD_2` do not share a body.
const VARIANTS_PER_OP = 3;

// Depth 2 already nests several identities per site. Every site draws its own,
// so diversity comes from the number of sites rather than from depth.
const MBA_DEPTH = 2;

// Handlers are budgeted more generously than inline expansions, because they
// cost no bytecode: the instruction keeps its operands, so the whole body is
// one shared function per opcode variant.  `mulChance` is raised over the
// default for the same reason — a multiplicative identity leaves the linear-MBA
// class, which is the one class an evaluation-based solver decides outright,
// and inside a handler it is free.
//
// `leafDepth` stays at 1 deliberately.  It is the dominant term in expression
// SIZE (mba-utils measures ~3KB at 1 against ~55KB at 2), and a merged handler
// draws THREE expansions — so leafDepth 2 produced 100KB+ single cases, which
// is both an absurd amount of output and a real runtime cost every time the
// handler runs.  Depth and identityChance buy structure much more cheaply.
const HANDLER_MBA: MBAOptions = {
  depth: 3,
  leafDepth: 1,
  identityChance: 80,
  mulChance: 55,
};

// The dispatch chain (see MBASafeMark "hot").  Every arm of it is re-evaluated
// on each state transition, so a handler reached from there runs O(blocks)
// times more often than one in a block body.  Depth spent here is multiplied by
// the block count at runtime and buys nothing that merging and frame-binding do
// not already buy, so it is cut hard.
// Compiler-generated state-machine arithmetic (the "generated" phase).  These
// run at flattening frequency — once per state transition — rather than at
// user-code frequency, and what they need to achieve is narrower: no ADD / EQ
// left in the stream, and nothing a sampler can identify.  Being a handler
// delivers the first; merging and frame-binding deliver the second.  Neither
// scales with depth, so the budget here is a fraction of the user one.
const WARM_MBA: MBAOptions = {
  depth: 2,
  leafDepth: 1,
  identityChance: 55,
  mulChance: 35,
};

// The dispatch chain itself (MBASafeMark "hot"), which is walked arm by arm on
// EVERY transition — so a handler reached from here runs O(blocks) times more
// often again.  The band is tight on purpose.
const HOT_MBA: MBAOptions = {
  depth: 1,
  leafDepth: 1,
  identityChance: 35,
  mulChance: 25,
};

// A short body is a real risk — `~~(a + k * a + b)` is technically
// key-dependent but small enough to invite a guess-and-check ("what if that
// term is zero?") — and an enormous one is a real cost.  Draws outside the band
// are retried; the closest one seen is kept if none lands inside.
const MIN_HANDLER_NODES = 40;
const MAX_HANDLER_NODES = 2400;
const MIN_WARM_NODES = 32;
const MAX_WARM_NODES = 480;
const MIN_HOT_NODES = 20;
const MAX_HOT_NODES = 150;
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

// Taint operand
// ───────────────────────────────────────────────────────────────────────────
// A register the handler reads and provably does not depend on. It is aimed at
// the attack the rest of this file does not touch: a devirtualizer recovers a
// flattened CFG by EXECUTING handlers against concrete state, and everything
// here — merging, frame binding, domain restriction — changes what a handler
// looks like rather than what it needs. What it needs is a value for every
// input. See utils/mba-taint.ts.
const TAINT_VAR = "t";

// Domain-restricted null vectors
// ───────────────────────────────────────────────────────────────────────────
// The handler's identity only has to hold on the set of values that can ACTUALLY
// reach it, and a term vanishing on exactly that set makes the handler
// inequivalent to its operator everywhere else — which is what a sampling
// simplifier measures.  See mba-utils' "Domain-restricted identities".
//
// Which domains apply depends on who chose the values:
//
//   k  (selector key)   — drawn by findSelectorOperand inside one residue class.
//                         Compiler-chosen.
//   a, b (the operands) — whatever the GENERATING PASS declared through
//                         MBA_DOMAINS_SYM, plus int32 in the "generated" phase,
//                         where every value is a compiler-chosen word.
//
// The declared domains are the ones that matter.  int32 is nearly free but it
// is also nearly worthless against a black-box classifier: its vector is zero
// on every integer, and integers are the probes such a classifier decides a fit
// on — it discards the rest.  A declared domain (a mask that is 0 or -1, a
// state word in a known residue class) fires on ordinary small integers, which
// is the population that counts.  See mba-utils' "Where the probes actually
// land".
//
// None of this extends to user code.  Tier 1 rests on analysis/int-types.ts,
// which states outright that it performs no range analysis: `a + b` is eligible
// when a and b are integral, whether or not they fit in int32.  An operand of
// 2^40 is therefore legal there and would make an int32 null vector fire on a
// real execution and corrupt the result.  Tier 0 is worse still — its operands
// may be any JS value at all, which is why they are coerced.  So operand
// domains are restricted to the population whose values this compiler picked.
const POISON_CHANCE = 45;

// The frame binding used to claim `v` is odd, which is true — and useless.
// `v` is built with `| 1` in EVERY frame, real or fabricated, so the vector
// `~v & 1` cancelled for an attacker exactly as it cancelled for the program.
// It shipped in 160 places in an analysed build and protected nothing. There is
// no domain claim here now: the binding's value comes from the frame's SALT
// slot, and being unable to supply that is the whole of what it buys.

// % of handler sites that are frame-bound rather than generic. Mixed so an
// attacker cannot assume any given handler is one kind or the other, but
// weighted hard towards bound: an unbound handler is a pure function of its two
// operands, which is exactly the thing a black-box classifier samples and
// identifies. A bound one is not liftable out of its frame at all.
const FRAME_BOUND_CHANCE = 85;

// Merged handlers
// ───────────────────────────────────────────────────────────────────────────
// Everything above keeps the property that ruins it: a generated handler still
// computes exactly `a + b`. A deobfuscator does not need to simplify the body
// to see that — it runs the handler on a handful of sampled operand pairs and
// matches the results against a table of candidate operators. That attack is
// indifferent to depth, node count and non-linearity, because none of them
// change what the function computes.
//
// A merged handler hosts TWO semantics and reads one extra operand: a per-site
// key whose selector bit picks which one runs (see mba-utils' "Key-selected
// semantics"). Sampling it over (a, b) now returns whichever operator that call
// site asked for, and the next site using the same opcode returns a different
// one — so there is no operator to match the handler against.
//
// Only ops that can share a handler are merged: same tier (so one normalisation
// rule is correct for both), same arity, and the same result kind. The two
// unary ops have no same-tier partner, so they keep the single-semantic path.
interface MergeGroup {
  names: string[];
  /**
   * Results are real booleans and must stay that way — the select below is
   * arithmetic, so a boolean group is coerced back with `!!` afterwards.
   * `x === y` must not start yielding 1.
   */
  boolean: boolean;
}

const MERGE_GROUPS: MergeGroup[] = [
  // Tier 0, arity 3, int32 result.
  { names: ["BAND", "BOR", "BXOR"], boolean: false },
  // Tier 1, arity 3, int32 result.
  { names: ["ADD", "SUB"], boolean: false },
  // Tier 1, arity 3, boolean result.
  { names: ["LT", "GT", "LTE", "GTE", "EQ", "NEQ"], boolean: true },
];

const groupFor = (name: string): MergeGroup | null =>
  MERGE_GROUPS.find((g) => g.names.includes(name)) ?? null;

// % of handler sites that use a merged opcode rather than a single-semantic
// one. High, because a single-semantic handler is identifiable by sampling no
// matter what its body looks like; the remainder exists so the two kinds stay
// mixed and a merged handler is not simply "the one with four operands".
const MERGE_CHANCE = 75;

interface MergedVariant {
  op: number;
  zeroName: string;
  oneName: string;
  key: SelectorKey;
}

export interface OpSpec {
  /** 0 = int32 by JS spec (needs operand normalisation); 1 = analysis-gated. */
  tier: 0 | 1;
  /** Operand slots on the instruction, including the destination. */
  arity: 2 | 3;
  /**
   * The built expression is a real BOOLEAN, not an int32.  Nothing may be
   * folded around its root: a domain null vector added outside the `!!` would
   * turn `x === y` into 1, and the comparison results feed user variables.
   * Vectors still reach the int32 subterms INSIDE the comparison, which is
   * where they belong anyway.
   */
  boolean?: true;
  build: (a: MBAExpr, b: MBAExpr | null, o: MBAOptions) => MBAExpr;
}

export const OP_SPECS: Record<string, OpSpec> = {
  // ── Tier 0 ────────────────────────────────────────────────────────────────
  BAND: { tier: 0, arity: 3, build: (a, b, o) => mbaBinExpr("&", a, b!, o) },
  BOR: { tier: 0, arity: 3, build: (a, b, o) => mbaBinExpr("|", a, b!, o) },
  BXOR: { tier: 0, arity: 3, build: (a, b, o) => mbaBinExpr("^", a, b!, o) },
  UNARY_BITNOT: { tier: 0, arity: 2, build: (a, _b, o) => mbaBNotExpr(a, o) },

  // ── Tier 1 ────────────────────────────────────────────────────────────────
  ADD: { tier: 1, arity: 3, build: (a, b, o) => mbaAddExpr(a, b!, o) },
  SUB: { tier: 1, arity: 3, build: (a, b, o) => mbaSubExpr(a, b!, o) },
  UNARY_NEG: { tier: 1, arity: 2, build: (a, _b, o) => mbaNegExpr(a, o) },
  LT: { tier: 1, arity: 3, boolean: true, build: (a, b, o) => mbaLtExpr(a, b!, o) },
  GT: { tier: 1, arity: 3, boolean: true, build: (a, b, o) => mbaGtExpr(a, b!, o) },
  LTE: { tier: 1, arity: 3, boolean: true, build: (a, b, o) => mbaLteExpr(a, b!, o) },
  GTE: { tier: 1, arity: 3, boolean: true, build: (a, b, o) => mbaGteExpr(a, b!, o) },
  // The comparison results feed user variables, not just jump predicates, so
  // they are coerced to real booleans — `x === y` must not start yielding 1.
  EQ: {
    tier: 1,
    arity: 3,
    boolean: true,
    build: (a, b, o) => asBoolean(mbaEqExpr(a, b!, o)),
  },
  NEQ: {
    tier: 1,
    arity: 3,
    boolean: true,
    build: (a, b, o) => asBoolean(mbaNeExpr(a, b!, o)),
  },
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

/**
 * Which population of instructions a run of this pass is allowed to touch.
 *
 *   "user"      — instructions compiled from user source, gated on the AST
 *                 int-type analysis.  Both forms are available; expansion is
 *                 the majority, and running before controlFlowFlattening is
 *                 what gets those expansions scattered across its blocks.
 *
 *   "generated" — instructions a PASS emitted, gated on MBA_SAFE_SYM.  These
 *                 are HANDLER-ONLY: an inline expansion here would land in the
 *                 dispatch chain, which is walked once per state transition, so
 *                 its cost is multiplied by the edge count.  A handler is one
 *                 shared JS expression and costs no bytecode at all.
 */
export type MBAPhase = "user" | "generated";

export function mbaExpand(
  bc: Bytecode,
  compiler: Compiler,
  facts: IntFacts | null,
  phase: MBAPhase = "user",
): { bytecode: Bytecode } {
  const OP = compiler.OP;
  const handlerChance = handlerChanceFor(compiler);

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
  // "zeroName|oneName[:fnId]" → merged opcodes hosting that pair of semantics.
  const mergedVariants = new Map<string, MergedVariant[]>();
  // Sequence number for MBA_SEL_* names.  A merged handler is deliberately NOT
  // named after the operators it hosts: OP_NAME reaches the emitted comments
  // when encodeBytecode is off, and naming it MBA_ADD_SUB_0 would hand back
  // exactly the pair the key is there to hide.
  let mergedSeq = 0;

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

  // Everything about ONE instruction that changes the handler it should get.
  // Two sites may only share a handler when these agree — most sharply for
  // `srcDomains`, because a handler carries terms that vanish on exactly the
  // declared domain, and pointing it at an operand outside that domain would
  // fire the vector during a real execution.  See siteKey.
  interface Site {
    hot: boolean;
    /** What the generating pass declared about each source, positionally. */
    srcDomains: (MBADomain | undefined)[];
    /** The taint register to append, or null.  See utils/mba-taint.ts. */
    taint: RegisterOperand | null;
    /** Every register input is a build-time constant.  See budgetFor. */
    constFed: boolean;
  }

  // Handler-identity key.  A cache miss costs one more handler; a false HIT
  // costs correctness, so everything the body was built from goes in here.
  const siteKey = (site: Site): string =>
    [
      site.hot ? "hot" : "cold",
      JSON.stringify(site.srcDomains ?? []),
      site.taint ? "t" : "-",
      site.constFed ? "k" : "-",
    ].join("|");

  const constRegs = analyzeConstRegs(bc, compiler);

  // One taint register per function, picked once.  Sharing it across every site
  // in the function is deliberate: a per-site register would multiply the
  // handler table (each distinct site key mints its own variant) while adding
  // nothing — one unknown input is as unresolvable as five.
  const taintByFn = new Map<number, RegisterOperand>();
  const taintFor = (fnId: number): RegisterOperand => {
    let reg = taintByFn.get(fnId);
    if (!reg) {
      reg = pickTaintRegister(bc, compiler, fnId, maxId);
      taintByFn.set(fnId, reg);
    }
    return reg;
  };

  // How much expansion a handler gets, and how large the result may be.  Three
  // tiers, by how often the body will actually run:
  //
  //   user       — user-code frequency.  This is the arithmetic worth hiding,
  //                so it gets the full budget.
  //   generated  — once per state transition (CFF's transitions, seeds, opaque
  //                predicates).
  //   hot        — once per dispatch ARM per transition, so O(blocks) times
  //                more often again.
  //
  // Spending depth on the last two is paid back at runtime multiplied by the
  // block count, and buys nothing that merging, frame-binding and superoperator
  // composition do not already buy.
  //
  // And then there is the case where depth buys nothing at ALL.  A devirtualizer
  // does not simplify a handler, it EXECUTES it — so an instruction whose inputs
  // are all build-time constants is folded to a literal and deleted whatever its
  // body looks like.  Measured on an analysed build, the four largest handlers
  // were exactly this: a quarter of the handler table, never read, never fitted,
  // folded away.  A site like that gets the floor budget, unless it carries a
  // taint operand — which is precisely an input the fold does not have.
  const budgetFor = (site: Site) => {
    if (site.constFed && !site.taint)
      return { options: HOT_MBA, min: MIN_HOT_NODES, max: MAX_HOT_NODES };
    if (phase === "user")
      return {
        options: HANDLER_MBA,
        min: MIN_HANDLER_NODES,
        max: MAX_HANDLER_NODES,
      };
    if (site.hot)
      return { options: HOT_MBA, min: MIN_HOT_NODES, max: MAX_HOT_NODES };
    return { options: WARM_MBA, min: MIN_WARM_NODES, max: MAX_WARM_NODES };
  };

  // Which domains this site may honestly claim.  Empty for an inline expansion:
  // the null vectors are built from Math.imul, which has no opcode, so they are
  // handler-only exactly like the frame-bound rules.
  //
  // The declared domains come from the pass that emitted the instruction and
  // are the valuable ones — a 0/-1 mask or a residue-classed state word makes
  // the handler differ from every operator on ordinary integer probes, which
  // int32-ness alone never does.  The taint gets no domain: nothing is known
  // about what its register holds, and nothing needs to be.
  const domainsFor = (
    kind: "expansion" | "handler" | "frameBound",
    key: SelectorKey | null,
    site: Site,
    srcs: string[],
  ): Record<string, MBADomain> => {
    if (kind === "expansion") return {};
    const domains: Record<string, MBADomain> = {};
    if (key) domains.k = { modTag: { bits: KEY_TAG_BITS, tag: key.tag } };
    srcs.forEach((name, i) => {
      const declared = site.srcDomains[i];
      // See POISON_CHANCE: int32 only for the compiler-chosen population.
      const base: MBADomain | null =
        phase === "generated" ? { int32: true } : null;
      if (declared || base) domains[name] = { ...base, ...declared };
    });
    return domains;
  };

  // Three shapes of expression, by where the result will live:
  //   • expansion — bytecode, so no VM state, no imul, no null vectors
  //   • generic handler — richer budget, still only the operands
  //   • frame-bound handler — adds `v` / `c`, which bind it to one function
  const buildExpr = (
    spec: OpSpec,
    kind: "expansion" | "handler" | "frameBound",
    site: Site,
    override?: MBAOptions,
  ): MBAExpr => {
    const binary = spec.arity === 3;
    // The instruction's own operands double as the noise pool: they are
    // guaranteed live and (for tier 1) guaranteed integral, and entangling the
    // two real operands is exactly the dependency an analysis has to untangle.
    // The taint joins them — entangling is how it gets into the body at all,
    // and every noise rule is an identity, so the value stays independent of it.
    const srcs = binary ? ["a", "b"] : ["a"];
    const noise = site.taint ? [...srcs, TAINT_VAR] : srcs;
    const domains = domainsFor(kind, null, site, srcs);
    // The operands go in ALREADY POISONED where their domain supports it, so
    // the vector is inside whatever the builder wraps around them rather than
    // folded on afterwards.  For a comparison that is the only placement that
    // works at all — see poisonedLeaf.
    const core = spec.build(
      poisonedLeaf("a", domains.a),
      binary ? poisonedLeaf("b", domains.b) : null,
      {
        depth: MBA_DEPTH,
        noise,
        ...(kind === "expansion" ? {} : (override ?? budgetFor(site).options)),
        domains,
        poisonChance: kind === "expansion" ? 0 : POISON_CHANCE,
        // Deliberately NOT added to `noise`: the binding is only worth carrying
        // in positions where its value matters, so every appearance of it is
        // load-bearing rather than cancellable.
        ...(kind === "frameBound"
          ? { frameVar: FRAME_VAR, invVar: FRAME_INV_VAR }
          : {}),
      },
    );
    // The engine already folds vectors in at the leaves; this adds one at the
    // ROOT as well, where it sits outside every truncation and so cannot be
    // absorbed by simplifying a subterm.  Not for a boolean result — see
    // OpSpec.boolean.
    return kind === "expansion" || spec.boolean
      ? core
      : poisonMBA(core, { domains, poisonChance: POISON_CHANCE });
  };

  // The same shape as buildExpr, but the two operands are also joined by the
  // selector `s` and the raw key `k`. Both are added to the NOISE pool as well
  // as being load-bearing in the select: an evaluation-based solver then has to
  // cover four variables instead of two, which is the axis the MBA literature
  // says actually costs an attacker.
  const mergedOptions = (
    binary: boolean,
    kind: "handler" | "frameBound",
    site: Site,
    base: MBAOptions,
    key: SelectorKey,
  ): MBAOptions => {
    const srcs = binary ? ["a", "b"] : ["a"];
    const noise = [...srcs, "s", "k", ...(site.taint ? [TAINT_VAR] : [])];
    return {
      depth: MBA_DEPTH,
      noise,
      ...base,
      domains: domainsFor(kind, key, site, srcs),
      poisonChance: POISON_CHANCE,
      ...(kind === "frameBound"
        ? { frameVar: FRAME_VAR, invVar: FRAME_INV_VAR }
        : {}),
    };
  };

  const buildMergedExpr = (
    zero: OpSpec,
    one: OpSpec,
    isBoolean: boolean,
    kind: "handler" | "frameBound",
    site: Site,
    base: MBAOptions,
    key: SelectorKey,
  ): MBAExpr => {
    const binary = zero.arity === 3;
    const options = mergedOptions(binary, kind, site, base, key);
    const domains = options.domains ?? {};
    // Poisoned inside the thunk, so each call draws its own vector.
    const branch = (spec: OpSpec) => () =>
      spec.build(
        poisonedLeaf("a", domains.a),
        binary ? poisonedLeaf("b", domains.b) : null,
        options,
      );
    // Thunks, not expressions: mbaSelectExpr draws one of the branches twice
    // for its first form, and two independent expansions of the same semantic
    // read far less like a copy-paste than the same subtree written out twice.
    const selected = mbaSelectExpr(branch(zero), branch(one), mVar("s"));
    // The select is arithmetic (0/1 weights), so a comparison group comes back
    // as an int 0/1 and has to be coerced to a real boolean again.  Poisoning
    // happens BEFORE that coercion — `!!` collapses everything to a boolean, so
    // a vector folded outside it would be erased instead of observable.
    return isBoolean
      ? asBoolean(poisonMBA(selected, options))
      : poisonMBA(selected, options);
  };

  // Expansion is random, so a draw can come back thin, enormous, or (for a
  // frame-bound variant) without the binding at all. Handlers are generated
  // once, so redrawing until all three hold turns a likelihood into a
  // guarantee.
  //
  // Redrawing alone is not enough for the upper bound, though. Some builders
  // are inherently large: a merged COMPARISON draws three branches, each of
  // which is itself three independent expansions (see ltExpr), so at the top
  // budget every single draw overshoots and "keep the smallest" silently
  // returns a 100KB handler. So the budget STEPS DOWN when a whole round of
  // draws misses the ceiling. That makes the bound real, and it is the right
  // trade: an oversized handler costs output size and pays its cost again on
  // every execution, while a shallower one is still merged, still frame-bound,
  // and still matches no operator.
  const redraw = (
    draw: (o: MBAOptions) => MBAExpr,
    kind: "handler" | "frameBound",
    site: Site,
    isBoolean: boolean,
  ): MBAExpr => {
    const { options, min, max } = budgetFor(site);
    const depth = options.depth ?? 3;
    const ladder: MBAOptions[] = [
      options,
      { ...options, depth: Math.max(1, depth - 1), mulChance: 30 },
      // Leaf expansion is kept even on the last rung: it is where `noise` and
      // the frame binding enter, so dropping it would produce a handler that
      // claims to be frame-bound and is not.
      { ...options, depth: 0, identityChance: 30, mulChance: 20 },
    ];
    const bound = (e: MBAExpr) =>
      kind !== "frameBound" || mbaVarNames(e).includes(FRAME_VAR);

    // Two things the engine only does with a PROBABILITY, made certain here.
    // Both are folded in after the fact rather than redrawn for, because both
    // have to hold for every handler rather than for most of them.
    //
    // The firing null vector is NOT one of them any more: buildExpr poisons the
    // operands themselves, before the builder wraps anything around them, which
    // is both deeper and the only placement a comparison can use at all (see
    // poisonedLeaf). What is left here is the taint, and the re-coercion of a
    // boolean whose type the entangling may have destroyed — folding an
    // arithmetic identity around `x === y` turns a real boolean into 1 or 0,
    // and comparison results reach user variables.
    const finalise = (e: MBAExpr): MBAExpr => {
      // The taint operand is emitted whether or not the draw used it, so a body
      // that missed it would read one word too few from the bytecode stream.
      if (!site.taint || mbaVarNames(e).includes(TAINT_VAR)) return e;
      const out = entangleMBA(e, TAINT_VAR);
      return isBoolean ? asBoolean(out) : out;
    };

    let smallest: MBAExpr | null = null;
    let smallestSize = Infinity;
    for (const rung of ladder) {
      for (let attempt = 0; attempt < HANDLER_DRAW_ATTEMPTS; attempt++) {
        const candidate = draw(rung);
        if (!bound(candidate)) continue;
        const size = mbaNodeCount(candidate);
        if (size >= min && size <= max) return finalise(candidate);
        if (size < smallestSize) {
          smallest = candidate;
          smallestSize = size;
        }
      }
    }
    return finalise(smallest ?? draw(ladder[ladder.length - 1]));
  };

  const buildHandlerExpr = (
    spec: OpSpec,
    kind: "handler" | "frameBound",
    site: Site,
  ): MBAExpr =>
    redraw((o) => buildExpr(spec, kind, site, o), kind, site, !!spec.boolean);

  // Sources the INSTRUCTION carries, in operand order: the real ones, then the
  // taint. mbaOpcodes reads them in exactly this order.
  const srcNamesFor = (spec: OpSpec, site: Site) => {
    const names = spec.arity === 3 ? ["a", "b"] : ["a"];
    if (site.taint) names.push(TAINT_VAR);
    return {
      srcNames: names,
      srcKinds: names.map(() => "reg" as const),
      taintNames: site.taint ? [TAINT_VAR] : undefined,
    };
  };

  const frameKeyFor = (fnId: number | null): FrameKey | undefined =>
    fnId === null
      ? undefined
      : frameKeyConstants(compiler.fnDescriptors[fnId]?.salt ?? 0);

  const newVariant = (
    name: string,
    spec: OpSpec,
    originalOp: number,
    fnId: number | null,
    label: string,
    site: Site,
  ): number | null => {
    const slot = nextFreeSlot(compiler);
    if (slot === -1) return null;
    const kind = fnId === null ? "handler" : "frameBound";
    const srcs = spec.arity === 3 ? ["a", "b"] : ["a"];
    const domains = domainsFor(kind, null, site, srcs);
    compiler.MBA_OPS[slot] = {
      originalOp,
      arity: spec.arity + (site.taint ? 1 : 0),
      expr: buildHandlerExpr(spec, kind, site),
      normalize: spec.tier === 0,
      // Non-null means the runtime pass bakes the inverse of this function's
      // salt into the handler; the handler is then only correct inside it.
      fnId,
      frame: frameKeyFor(fnId),
      domains,
      semantics: [name],
      ...srcNamesFor(spec, site),
    };
    compiler.OP_NAME[slot] = `MBA_${name}_${label}`;
    return slot;
  };

  // Generic variants: a small shared pool per opcode.
  const genericVariantFor = (
    name: string,
    spec: OpSpec,
    originalOp: number,
    site: Site,
  ) => {
    // Sites only share a variant when everything the body was built from
    // agrees. Hot and cold differ in budget; a domain claim differs in what the
    // body may assume, and reusing a handler across two different claims would
    // fire a null vector on real data.
    const cacheKey = `${name}#${siteKey(site)}`;
    let list = variantsByName.get(cacheKey);
    if (!list) {
      list = [];
      for (let i = 0; i < VARIANTS_PER_OP; i++) {
        const slot = newVariant(name, spec, originalOp, null, String(i), site);
        if (slot === null) break;
        list.push(slot);
      }
      variantsByName.set(cacheKey, list);
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
    site: Site,
  ) => {
    const key = `${name}:${fnId}#${siteKey(site)}`;
    if (!frameBoundVariants.has(key)) {
      frameBoundVariants.set(
        key,
        newVariant(name, spec, originalOp, fnId, `f${fnId}`, site),
      );
    }
    return frameBoundVariants.get(key) ?? null;
  };

  // Merged variants, keyed by the (canonically ordered) pair of semantics they
  // host.  Both members of the pair route to the SAME opcode — that is the
  // whole point — so the registry is per-pair rather than per-op, and a site
  // looks up whichever pair it drew a partner from.
  const mergedVariantsFor = (
    n0: string,
    n1: string,
    group: MergeGroup,
    fnId: number | null,
    site: Site,
  ): MergedVariant[] => {
    const [zeroName, oneName] = [n0, n1].sort();
    const cacheKey =
      (fnId === null
        ? `${zeroName}|${oneName}`
        : `${zeroName}|${oneName}:${fnId}`) + `#${siteKey(site)}`;

    let list = mergedVariants.get(cacheKey);
    if (list) return list;

    list = [];
    // Frame-bound variants are minted one per (pair, function): the function
    // already supplies the diversity, so more would only inflate the handler
    // count — the same policy frameBoundVariantFor follows.
    const count = fnId === null ? VARIANTS_PER_OP : 1;
    for (let i = 0; i < count; i++) {
      const slot = nextFreeSlot(compiler);
      if (slot === -1) break;

      const key = makeSelectorKey();
      const zeroSpec = OP_SPECS[zeroName];
      const oneSpec = OP_SPECS[oneName];
      const kind = fnId === null ? "handler" : "frameBound";
      const srcs = zeroSpec.arity === 3 ? ["a", "b"] : ["a"];
      const domains = domainsFor(kind, key, site, srcs);

      compiler.MBA_OPS[slot] = {
        // Both semantics live here; `originalOp` keeps its "what this replaced"
        // meaning by naming the one the selector's 0 branch computes.
        originalOp: OP[zeroName]!,
        // The key operand is not counted here: `arity` is the instruction's
        // source count, and mbaOpcodes reads the key separately, after them.
        arity: zeroSpec.arity + (site.taint ? 1 : 0),
        expr: redraw(
          (o) =>
            buildMergedExpr(
              zeroSpec,
              oneSpec,
              group.boolean,
              kind,
              site,
              o,
              key,
            ),
          kind,
          site,
          group.boolean,
        ),
        // Groups never straddle tiers, so one normalisation rule is correct for
        // both branches.
        normalize: zeroSpec.tier === 0,
        fnId,
        frame: frameKeyFor(fnId),
        domains,
        // Index = selector bit, matching `select`.
        semantics: [zeroName, oneName],
        select: { zeroName, oneName, key },
        ...srcNamesFor(zeroSpec, site),
      };
      compiler.OP_NAME[slot] = `MBA_SEL_${mergedSeq++}`;
      list.push({ op: slot, zeroName, oneName, key });
    }

    mergedVariants.set(cacheKey, list);
    return list;
  };

  // Pick a merged opcode able to serve `name`, plus the key operand that makes
  // it compute `name` rather than its partner.  Returns null when the opcode
  // space is exhausted or the op has no same-tier partner.
  const mergedSiteFor = (
    name: string,
    fnId: number | null,
    site: Site,
  ): { op: number; keyOperand: number } | null => {
    const group = groupFor(name);
    if (!group) return null;
    const partners = group.names.filter(
      (n) => n !== name && OP[n] !== undefined,
    );
    if (partners.length === 0) return null;

    const list = mergedVariantsFor(name, choice(partners), group, fnId, site);
    if (list.length === 0) return null;

    const variant = choice(list);
    const bit = name === variant.zeroName ? 0 : 1;
    // A fresh random key per site, not a shared constant: half of the 2^32
    // operands select each semantic, so no two sites need share a literal even
    // when they ask for the same one.
    return { op: variant.op, keyOperand: findSelectorOperand(variant.key, bit) };
  };

  const result: Bytecode = [];
  let expanded = 0;
  let handlers = 0;
  let mergedSites = 0;

  for (const instr of bc) {
    const op = instr[0];
    const entry = op === null ? undefined : specByOp.get(op);

    if (!entry || instr.length - 1 !== entry.spec.arity) {
      result.push(instr);
      continue;
    }

    const meta = instr as unknown as Record<symbol, unknown>;
    const sourceNode = meta[SOURCE_NODE_SYM];
    const mark = meta[MBA_SAFE_SYM] as MBASafeMark | undefined;
    const generated = mark !== undefined;
    // Sits in the dispatch chain, re-evaluated once per arm per state
    // transition — see MBASafeMark.
    const hot = mark === "hot";

    // Each phase owns one population and must not touch the other's.  In the
    // "user" phase, compiler-internal instructions carry no source node
    // (Template strips it) so they are never eligible — exactly the right
    // default.  In the "generated" phase the marker is the whole gate: it is a
    // pass's promise that every value flowing through the instruction is int32,
    // which is the precondition the MBA algebra needs and the AST analysis
    // cannot supply for an instruction that has no AST node.
    const eligible =
      phase === "generated"
        ? generated
        : !generated && !!sourceNode && !!facts?.isMBASafe(sourceNode as never);

    if (!eligible) {
      result.push(instr);
      continue;
    }

    const { name, spec } = entry;
    const binary = spec.arity === 3;
    const dst = instr[1];
    const srcA = instr[2];
    // `isRegister` narrows the union; a separate local is needed because TS
    // cannot carry the narrowing through the `binary &&` guard below.
    const srcB: RegisterOperand | null =
      binary && isRegister(instr[3]) ? instr[3] : null;

    if (
      !isRegister(dst) ||
      !isRegister(srcA) ||
      (binary && srcB === null) ||
      findFnId(instr) === null
    ) {
      result.push(instr);
      continue;
    }

    // ── Handler form: same operands, different opcode ──────────────────────
    // Always taken in the "generated" phase: those instructions live in the
    // dispatch chain, where an inline expansion is paid again on every state
    // transition (see MBAPhase).
    if (phase === "generated" || chance(handlerChance)) {
      const siteFnId = findFnId(instr)!;
      const boundFnId = chance(FRAME_BOUND_CHANCE) ? siteFnId : null;

      // Declared operand domains, read off the instruction the generating pass
      // stamped.  Indexed by operand position there; positional here, since the
      // handler names its sources `a` / `b` in the same order.
      const declared = meta[MBA_DOMAINS_SYM] as MBAOperandDomains | undefined;
      const site: Site = {
        hot,
        srcDomains: [declared?.[2], ...(binary ? [declared?.[3]] : [])],
        // Only the generated population is tainted.  User arithmetic is mostly
        // unknown to a constant-propagating attacker already, so an extra
        // operand per site would be bytecode spent on a fold that was never
        // going to happen — while the state machine is ALL constants, which is
        // exactly what makes it foldable and worth breaking.
        taint: phase === "generated" ? taintFor(siteFnId) : null,
        constFed: constRegs.isConstFed(instr),
      };

      // Merged first: it is the only form that is not a pure function of the
      // instruction's own operands, so it is the only one a black-box
      // classifier cannot identify by sampling.
      const merged = chance(MERGE_CHANCE)
        ? mergedSiteFor(name, boundFnId, site)
        : null;
      if (merged !== null) {
        const replacement: Instruction = [
          merged.op,
          ...(instr.slice(1) as Instruction[number][]),
          // Taint first, then the key: mbaOpcodes reads every source in
          // `srcNames` order and the key operand last of all.
          ...(site.taint ? [{ ...site.taint }] : []),
          merged.keyOperand,
        ];
        (replacement as unknown as Record<symbol, unknown>)[SOURCE_NODE_SYM] =
          sourceNode;
        result.push(replacement);
        handlers++;
        mergedSites++;
        continue;
      }

      const variant =
        boundFnId !== null
          ? frameBoundVariantFor(name, spec, op as number, siteFnId, site)
          : genericVariantFor(name, spec, op as number, site);
      if (variant !== null) {
        const replacement: Instruction = [
          variant,
          ...(instr.slice(1) as Instruction[number][]),
          ...(site.taint ? [{ ...site.taint }] : []),
        ];
        (replacement as unknown as Record<symbol, unknown>)[SOURCE_NODE_SYM] =
          sourceNode;
        result.push(replacement);
        handlers++;
        continue;
      }
    }

    // ── Expansion form: a run of ordinary opcodes ──────────────────────────
    // Only reachable in the "generated" phase when the opcode space is
    // exhausted.  Expanding there would put a scratch chain inside the dispatch
    // loop, whose back-edges resolveRegisters' linear scan cannot see, so the
    // instruction is left exactly as it is instead.
    if (phase === "generated") {
      result.push(instr);
      continue;
    }

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

    // An inline expansion is plain bytecode: no VM state to bind to, no imul to
    // build a null vector from, and no taint operand (there is no handler to
    // read one). `expansion` turns all of that off; the Site here only carries
    // the budget-relevant flags.
    const expansionSite: Site = {
      hot: false,
      srcDomains: [],
      taint: null,
      constFed: constRegs.isConstFed(instr),
    };
    const resultReg = emitMBA(
      out,
      buildExpr(spec, "expansion", expansionSite),
      env,
      ctx,
    );
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
    `mbaExpand[${phase}]: ${expanded} expanded, ${handlers} handler sites ` +
      `(${mergedSites} key-selected), ` +
      `${Object.keys(compiler.MBA_OPS).length} generated opcodes`,
  );

  return { bytecode: result };
}
