// mbaSuperOps — MBA superoperators
// ───────────────────────────────────────────────────────────────────────────
// Loki (USENIX Sec '22) hardens a VM along two axes.  mbaExpand implements the
// first: a handler whose body is a synthesized mixture, and a per-site key that
// makes one handler host more than one semantic.  This is the second: a handler
// that hosts a whole SEQUENCE of operations, so it corresponds to no single
// source-level operator even before the key is considered.
//
// The existing macroOpcodes pass fuses sequences too, but structurally — the
// generated case is the constituent handler bodies pasted one after another, so
// each sub-operation stays individually readable and each intermediate value is
// still written to a register.  A superoperator here is different: the chain is
// composed into ONE MBA expression, the intermediates never exist, and what the
// handler computes is a function of three to five inputs that matches no entry
// in any operator table.
//
//   before                                  after
//   ─────────────────────────────────       ─────────────────────────────────
//   LOAD_INT      t0, 6394                  MBA_SUP_3  state, state, 6394
//   ADD           state, state, t0
//
//   UNARY_BITNOT  t0, state                 MBA_SUP_7  pred, state
//   BAND          pred, state, t0
//
// ── What may be fused ────────────────────────────────────────────────────────
// A window of consecutive instructions forms a superoperator when it is a
// single-use dataflow TREE: every instruction except the last writes a register
// that is read exactly once in the entire program, by another instruction in
// the same window.  That condition is what makes the intermediates deletable —
// a register with a second reader has to survive as a real value, so the chain
// cannot collapse around it.
//
// Only MBA_SAFE_SYM instructions qualify.  That marker is a pass's promise that
// every value flowing through the instruction is int32, which is exactly the
// precondition mba-utils' algebra needs; user-source instructions are handled
// by mbaExpand, which has the AST analysis to make the same judgement.
//
// ── Why it pays here ─────────────────────────────────────────────────────────
// controlFlowFlattening emits its state machine as deliberately single-use
// chains for this pass to eat.  A state transition goes from two instructions
// to one, and the delta stops being a legible `LOAD_INT` — it becomes an
// untyped operand of an opaque opcode, consumed somewhere inside a mixture.
// The branchless conditional transition collapses from nine instructions to
// three.
//
// ── Pipeline position ────────────────────────────────────────────────────────
// After controlFlowFlattening (there is nothing to fuse before it) and before
// mbaExpand's "generated" phase, which then converts whatever did not fuse.
// Both must precede resolveRegisters, which is what turns the freed
// intermediates back into recycled slots.

import type { Bytecode, Instruction, RegisterOperand } from "../../types.ts";
import {
  Compiler,
  MBA_DOMAINS_SYM,
  MBA_SAFE_SYM,
  type MBAOperandDomains,
  type MBASafeMark,
} from "../../compiler.ts";
import { nextFreeSlot } from "../../utils/op-utils.ts";
import { buildMaxIdMap } from "../../utils/pass-utils.ts";
import { chance, choice } from "../../utils/random-utils.ts";
import { pickTaintRegister } from "../../utils/mba-taint.ts";
import { OP_SPECS, type OpSpec } from "./mbaExpand.ts";
import {
  asBoolean,
  entangleMBA,
  frameKeyConstants,
  mVar,
  mbaNodeCount,
  mbaVarNames,
  poisonMBA,
  poisonedLeaf,
  type MBADomain,
  type MBAExpr,
  type MBAOptions,
} from "../../utils/mba-utils.ts";

// Longest chain that may collapse into one handler.  Each level multiplies the
// composed expression, since every step is itself a full MBA expansion — four
// already gives a body of a few thousand nodes.
const MAX_WINDOW = 4;

// Expansion budget per composed step.  Deliberately below mbaExpand's
// single-op handler budget: a superoperator gets its strength from composition
// (the handler equals no operator at all, and an evaluation-based attack has to
// cover four or five inputs), so it does not need to buy the same depth again
// at every node.
// Every chain this pass sees is compiler-generated state-machine scaffolding
// (only MBA_SAFE_SYM instructions qualify, and only passes set that), so the
// budget matches mbaExpand's WARM tier rather than its user tier: the body runs
// at flattening frequency, and what makes it unreadable is the composition, not
// the depth.
const SUPER_MBA: MBAOptions = {
  depth: 2,
  leafDepth: 1,
  identityChance: 55,
  mulChance: 35,
};

// A chain out of CFF's dispatch loop (see MBASafeMark "hot").  Every arm is
// re-evaluated on each state transition, so the handler runs O(blocks) times
// more often than one in a block body; composition already makes it match no
// operator, so the per-node budget is cut instead of paid on every edge.
const HOT_SUPER_MBA: MBAOptions = {
  depth: 1,
  leafDepth: 1,
  identityChance: 30,
  mulChance: 20,
};

// A composed body that came out thin is one real risk — `~(a + b)` dressed up
// is still guessable — and an enormous one is the other, since a superoperator
// body is executed, not just stored.  Draws outside the band are retried.
const MIN_SUPER_NODES = 50;
const MAX_SUPER_NODES = 520;
const MIN_HOT_NODES = 24;
const MAX_HOT_NODES = 150;
const DRAW_ATTEMPTS = 12;

// Same policy as mbaExpand: a handler bound to its frame cannot be lifted out
// and probed with fabricated state, so most of them are.
const FRAME_BOUND_CHANCE = 80;
const FRAME_VAR = "v";
const FRAME_INV_VAR = "c";
// A register the fused handler reads and does not depend on, appended as its
// last operand. See utils/mba-taint.ts — this is the one thing here aimed at
// the attacker's constant propagation rather than at their classifier.
const TAINT_VAR = "t";

// Every leaf of a fused chain is a value this compiler chose — the whole pass
// is gated on MBA_SAFE_SYM, which is a promise that nothing else reaches it —
// so the int32 domain holds here without any analysis behind it.  That makes
// this the population where domain-restricted null vectors are most clearly
// sound, and a superoperator is also the handler most worth protecting: it is
// the one an attacker is most likely to attack black-box, because its body is
// too large to read.  See mba-utils' "Domain-restricted identities".
const POISON_CHANCE = 50;

// Distinct handlers minted per (chain shape, function).  Two is enough to stop
// "same shape ⇒ same opcode" from being a reliable read, while keeping the
// handler table from growing with the block count.
const VARIANTS_PER_SHAPE = 2;

/**
 * A leaf of the composed expression: either a register the fused chain reads
 * from outside itself, or an immediate a folded LOAD_INT supplied.
 *
 * Both become operands on the superoperator instruction, in this order.  An
 * immediate is NOT baked into the handler body — that would mint one handler
 * per distinct delta and put the state alphabet straight back into the opcode
 * table.
 */
interface Leaf {
  kind: "reg" | "imm";
  reg?: RegisterOperand;
  value?: number;
  /**
   * What the pass that emitted the instruction declared about this operand
   * (MBA_DOMAINS_SYM), if anything.  A leaf carrying one lets the composed
   * expression hold terms that vanish on exactly the values the leaf can take
   * — which is what stops the handler matching an operator on integer probes.
   * Part of the handler cache key: two chains may only share a handler when
   * their leaves claim the same thing.
   */
  domain?: MBADomain;
}

/** One node of the fused chain: an operation over leaves and/or sub-plans. */
interface PlanNode {
  spec: OpSpec;
  args: (PlanNode | number)[]; // number = index into `leaves`
}

interface Plan {
  root: PlanNode;
  leaves: Leaf[];
  /** Opcode sequence, part of the handler-reuse key. */
  shape: string;
  rootOp: number;
  /** Destination of the last instruction in the window. */
  dst: RegisterOperand;
  fnId: number;
  /** Any instruction in the window sits on CFF's per-edge dispatch path. */
  hot: boolean;
}

function isRegister(operand: unknown): operand is RegisterOperand {
  return (
    !!operand &&
    typeof operand === "object" &&
    (operand as RegisterOperand).type === "register"
  );
}

const regKey = (r: RegisterOperand) => `${r.fnId}:${r.id}`;

export function mbaSuperOps(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const OP = compiler.OP as Record<string, number | undefined>;

  // Current opcode value → the spec describing how to build its expression.
  // Opcode values may be randomized, so this has to go through OP.
  const specByOp = new Map<number, { name: string; spec: OpSpec }>();
  for (const name of Object.keys(OP_SPECS)) {
    const value = OP[name];
    if (typeof value === "number")
      specByOp.set(value, { name, spec: OP_SPECS[name] });
  }
  const LOAD_INT = OP.LOAD_INT;
  const MOVE = OP.MOVE;

  // One taint register per function, picked once and shared by every handler in
  // it. See utils/mba-taint.ts; one unresolvable input is as good as five, and
  // a per-site register would only multiply the handler table.
  const maxId = buildMaxIdMap(bc);
  const taintByFn = new Map<number, RegisterOperand>();
  const taintFor = (fnId: number): RegisterOperand => {
    let reg = taintByFn.get(fnId);
    if (!reg) {
      reg = pickTaintRegister(bc, compiler, fnId, maxId);
      taintByFn.set(fnId, reg);
    }
    return reg;
  };

  // ── Use counting ──────────────────────────────────────────────────────────
  // A register may be folded away only if the whole program touches it exactly
  // twice: once where it is defined and once where it is read.  Counting over
  // the entire bytecode (rather than the window) is what makes that sound —
  // registers are still virtual and function-scoped here, so an appearance
  // anywhere is a real appearance.
  const appearances = new Map<string, number>();
  for (const instr of bc) {
    for (let j = 1; j < instr.length; j++) {
      const o = instr[j];
      if (isRegister(o)) {
        const k = regKey(o);
        appearances.set(k, (appearances.get(k) ?? 0) + 1);
      }
    }
  }

  const markOf = (instr: Instruction) =>
    (instr as unknown as Record<symbol, unknown>)[MBA_SAFE_SYM] as
      | MBASafeMark
      | undefined;
  const isMarked = (instr: Instruction) => markOf(instr) !== undefined;

  const domainsOf = (instr: Instruction): MBAOperandDomains | undefined =>
    (instr as unknown as Record<symbol, unknown>)[MBA_DOMAINS_SYM] as
      | MBAOperandDomains
      | undefined;

  type Part =
    | {
        kind: "imm";
        dst: RegisterOperand;
        value: number;
        domain?: MBADomain;
      }
    | {
        kind: "op";
        dst: RegisterOperand;
        srcs: RegisterOperand[];
        srcDomains: (MBADomain | undefined)[];
        spec: OpSpec;
      };

  // An instruction this pass understands: `[op, dst, src...]` with every source
  // a register, or a LOAD_INT supplying an immediate.
  const classify = (instr: Instruction): Part | null => {
    const op = instr[0];
    if (op === null || !isMarked(instr)) return null;
    const declared = domainsOf(instr);
    if (op === LOAD_INT) {
      if (instr.length !== 3) return null;
      if (!isRegister(instr[1]) || typeof instr[2] !== "number") return null;
      return {
        kind: "imm",
        dst: instr[1],
        value: instr[2],
        domain: declared?.[2],
      };
    }
    const entry = specByOp.get(op);
    if (!entry || instr.length - 1 !== entry.spec.arity) return null;
    if (!isRegister(instr[1])) return null;
    const srcs: RegisterOperand[] = [];
    const srcDomains: (MBADomain | undefined)[] = [];
    for (let j = 2; j < instr.length; j++) {
      const o = instr[j];
      if (!isRegister(o)) return null;
      srcs.push(o);
      srcDomains.push(declared?.[j]);
    }
    return { kind: "op", dst: instr[1], srcs, srcDomains, spec: entry.spec };
  };

  // ── Planning ──────────────────────────────────────────────────────────────
  // Walk the window backwards from its last instruction, substituting any
  // source that a foldable earlier instruction defines.  A source that is not
  // foldable becomes a leaf.  The window only counts as fusable if EVERY
  // instruction in it is reached that way — a leftover would otherwise be
  // silently deleted along with its effect.
  //
  // This produces only the SHAPE.  Building the MBA is separate (and much more
  // expensive), so a window that cannot fuse costs nothing to reject.
  const planWindow = (window: Instruction[]): Plan | null => {
    // A trailing `MOVE d, t` where `t` is the previous instruction's single-use
    // destination is absorbed by redirecting the fused handler's write to `d`.
    // Template-compiled code produces these constantly — `c += delta` becomes
    // ADD into a temporary followed by a MOVE — and leaving them behind would
    // strand a legible copy in front of every dispatch arm.
    let moveDst: RegisterOperand | null = null;
    const tail = window[window.length - 1];
    if (window.length > 2 && tail[0] === MOVE) {
      const dst = tail[1];
      const src = tail[2];
      const prev = window[window.length - 2];
      if (
        isRegister(dst) &&
        isRegister(src) &&
        isRegister(prev[1]) &&
        regKey(prev[1]) === regKey(src) &&
        (appearances.get(regKey(src)) ?? 0) === 2
      ) {
        moveDst = dst;
        window = window.slice(0, -1);
      } else {
        return null;
      }
    }

    const parts: Part[] = [];
    for (const instr of window) {
      const p = classify(instr);
      if (p === null) return null;
      parts.push(p);
    }

    // The last instruction is the root and must be a real operation: a window
    // ending in LOAD_INT computes nothing.
    const root = parts[parts.length - 1];
    if (root.kind !== "op") return null;

    // Every instruction before the root must define a single-use register, or
    // there is no way to delete it.  Two definitions of the same register in
    // one window would also make "which one feeds this read" ambiguous.
    const producers = new Map<string, number>();
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if ((appearances.get(regKey(p.dst)) ?? 0) !== 2) return null;
      if (producers.has(regKey(p.dst))) return null;
      producers.set(regKey(p.dst), i);
    }
    // The root's own destination is the output; it must not also be an
    // intermediate.  (It may well be one of the SOURCES — `state = state + d`
    // is the common case — which is safe because the single write happens after
    // the whole expression has been evaluated.)
    const output = moveDst ?? root.dst;
    if (producers.has(regKey(output))) return null;

    const leaves: Leaf[] = [];
    const consumed = new Set<number>([parts.length - 1]);

    const addLeaf = (leaf: Leaf): number => leaves.push(leaf) - 1;

    const build = (index: number): PlanNode | null => {
      const part = parts[index];
      if (part.kind !== "op") return null;
      const args: (PlanNode | number)[] = [];
      for (let s = 0; s < part.srcs.length; s++) {
        const src = part.srcs[s];
        const from = producers.get(regKey(src));
        if (from === undefined) {
          // A register the chain reads from outside itself. Its domain is
          // whatever the reading instruction declared for that operand.
          args.push(
            addLeaf({ kind: "reg", reg: src, domain: part.srcDomains[s] }),
          );
          continue;
        }
        // Single-use guarantees this, but a malformed window would otherwise
        // duplicate a subtree and change how many times it is evaluated.
        if (consumed.has(from)) return null;
        consumed.add(from);
        const producer = parts[from];
        if (producer.kind === "imm") {
          // A folded LOAD_INT. The domain travels with the immediate, since
          // what the handler receives is the word the load carried.
          args.push(
            addLeaf({
              kind: "imm",
              value: producer.value,
              domain: producer.domain,
            }),
          );
          continue;
        }
        const sub = build(from);
        if (sub === null) return null;
        args.push(sub);
      }
      return { spec: part.spec, args };
    };

    const rootNode = build(parts.length - 1);
    if (rootNode === null) return null;
    // A window with an unreached instruction is not a tree — reject it rather
    // than drop the stray, whose result a later instruction may still want.
    if (consumed.size !== parts.length) return null;

    return {
      root: rootNode,
      leaves,
      shape: window.map((i) => i[0]).join(",") + (moveDst ? ",mv" : ""),
      rootOp: window[window.length - 1][0] as number,
      dst: output,
      fnId: output.fnId,
      // A chain is hot if any of it is: the fused handler runs wherever the
      // hottest instruction in it ran.
      hot: window.some((i) => markOf(i) === "hot"),
    };
  };

  // ── Composition ───────────────────────────────────────────────────────────
  // Every spec.build returns a fully expanded, int32-truncated expression, so
  // nesting them is exact: each level re-truncates, and no intermediate can
  // drift past float64's exact-integer range.
  const compose = (
    node: PlanNode,
    options: MBAOptions,
    noise: string[],
  ): MBAExpr => {
    // A leaf goes in ALREADY POISONED where its declared domain supports a
    // firing vector, so the term is inside everything this node and every node
    // above it wraps around it.  Drawn per USE, not per leaf: a leaf read twice
    // in the chain gets two unrelated vectors.  See poisonedLeaf — it is also
    // the only placement that reaches a comparison node at all.
    const args = node.args.map((a) =>
      typeof a === "number"
        ? poisonedLeaf(`p${a}`, options.domains?.[`p${a}`])
        : compose(a, options, noise),
    );
    // A comparison node yields a real boolean, so nothing may be folded around
    // it — see OpSpec.boolean.  Inner nodes are unaffected: their int32
    // subterms still get vectors from the engine.
    const poison = node.spec.boolean ? 0 : options.poisonChance;
    // ALL of the chain's leaves are the noise pool at every node, not just the
    // ones this node happens to read.  They are guaranteed live (each is an
    // operand of the instruction) and guaranteed int32, so entangling them is
    // free — and it is the axis that actually costs an attacker: a subtree over
    // four or five distinct variables is past the arity at which
    // evaluation-based simplifiers stop trying.
    const built = node.spec.build(
      args[0],
      node.spec.arity === 3 ? args[1] : null,
      { ...options, noise },
    );
    return poison > 0
      ? poisonMBA(built, { ...options, noise, poisonChance: poison })
      : built;
  };

  // Draw until the body is substantial, and — for a frame-bound handler —
  // until the binding actually landed in it.  A handler is generated once, so
  // redrawing turns a likelihood into a guarantee.
  const domainsFor = (plan: Plan): Record<string, MBADomain> => {
    const domains: Record<string, MBADomain> = {};
    plan.leaves.forEach((leaf, i) => {
      // int32 for register leaves only: an immediate comes straight out of the
      // bytecode stream, so an attacker probing the lifted handler cannot put a
      // non-integer there and a vector over one would be pure size.
      //
      // A DECLARED domain applies to both kinds, and is the one that matters —
      // it is non-zero on the ordinary integers a classifier probes with, which
      // int32-ness never is. See mba-utils' "Where the probes actually land".
      const base = leaf.kind === "reg" ? { int32: true } : null;
      if (base || leaf.domain) domains[`p${i}`] = { ...base, ...leaf.domain };
    });
    return domains;
  };

  const drawExpr = (
    plan: Plan,
    boundFnId: number | null,
    hasTaint: boolean,
  ): MBAExpr => {
    const base = plan.hot ? HOT_SUPER_MBA : SUPER_MBA;
    const min = plan.hot ? MIN_HOT_NODES : MIN_SUPER_NODES;
    const max = plan.hot ? MAX_HOT_NODES : MAX_SUPER_NODES;

    const domains = domainsFor(plan);

    const options: MBAOptions = {
      ...base,
      domains,
      poisonChance: POISON_CHANCE,
      ...(boundFnId === null
        ? {}
        : { frameVar: FRAME_VAR, invVar: FRAME_INV_VAR }),
    };

    // A four-instruction chain composes four expansions, so the top budget can
    // overshoot the ceiling on every draw.  Stepping the budget down makes the
    // bound real instead of merely preferred — and a shallower superoperator is
    // still a superoperator: it matches no operator either way, because the
    // composition is what does that work, not the depth.
    const depth = options.depth ?? 2;
    const ladder: MBAOptions[] = [
      options,
      { ...options, depth: Math.max(1, depth - 1), mulChance: 25 },
      { ...options, depth: 0, identityChance: 25, mulChance: 15 },
    ];

    const leafNoise = plan.leaves.map((_, i) => `p${i}`);
    const noise = hasTaint ? [...leafNoise, TAINT_VAR] : leafNoise;

    // The taint operand is emitted whether or not the draw used it, so a body
    // that missed it would read one word too few from the bytecode stream — the
    // same argument mbaExpand's redraw() makes.  The firing null vector needs no
    // guarantee here: compose() puts one on every leaf whose domain supports it.
    // A chain whose ROOT is a comparison yields a real boolean, so it is
    // re-coerced after the entangling identity is folded around it.
    const isBoolean = !!plan.root.spec.boolean;
    const finalise = (e: MBAExpr): MBAExpr => {
      if (!hasTaint || mbaVarNames(e).includes(TAINT_VAR)) return e;
      const out = entangleMBA(e, TAINT_VAR);
      return isBoolean ? asBoolean(out) : out;
    };

    let smallest: MBAExpr | null = null;
    let smallestSize = Infinity;
    for (const rung of ladder) {
      for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
        const candidate = compose(plan.root, rung, noise);
        if (boundFnId !== null && !mbaVarNames(candidate).includes(FRAME_VAR))
          continue;
        const size = mbaNodeCount(candidate);
        if (size >= min && size <= max) return finalise(candidate);
        if (size < smallestSize) {
          smallest = candidate;
          smallestSize = size;
        }
      }
    }
    return finalise(
      smallest ?? compose(plan.root, ladder[ladder.length - 1], noise),
    );
  };

  // ── Handler registry ──────────────────────────────────────────────────────
  // Keyed by (chain shape, leaf kinds, function).  Two windows with the same
  // shape share a handler, which is what keeps the opcode table small when a
  // function has fifty identical state transitions.
  const variants = new Map<string, number[]>();
  let seq = 0;

  const handlerFor = (
    plan: Plan,
    taint: RegisterOperand | null,
  ): number | null => {
    const kinds = plan.leaves.map((l) => l.kind).join("");
    const boundFnId = chance(FRAME_BOUND_CHANCE) ? plan.fnId : null;
    // The leaves' DOMAINS are part of the key, not just their kinds. A handler
    // carries terms that vanish on exactly what its leaves were declared to
    // hold, so sharing one across two chains whose leaves claim different
    // things would fire a null vector on real data — a miscompile, not a
    // weakening. Same reason the taint flag is in here.
    const domainKey = JSON.stringify(plan.leaves.map((l) => l.domain ?? null));
    const cacheKey = [
      plan.shape,
      kinds,
      domainKey,
      boundFnId ?? "*",
      taint ? "t" : "-",
    ].join("|");

    let list = variants.get(cacheKey);
    if (!list) {
      list = [];
      variants.set(cacheKey, list);
    }

    if (list.length < VARIANTS_PER_SHAPE) {
      const slot = nextFreeSlot(compiler);
      if (slot !== -1) {
        const srcNames = plan.leaves.map((_, i) => `p${i}`);
        const srcKinds = plan.leaves.map((l) => l.kind);
        if (taint) {
          srcNames.push(TAINT_VAR);
          srcKinds.push("reg");
        }
        compiler.MBA_OPS[slot] = {
          // There is no single "original op" any more — that is the point of a
          // superoperator.  The root's opcode is recorded so the registry entry
          // still says where the chain ended.
          originalOp: plan.rootOp,
          arity: 1 + srcNames.length,
          expr: drawExpr(plan, boundFnId, taint !== null),
          // Leaves are int32 by the MBA_SAFE_SYM contract, so the coercion does
          // not change any value — it is kept because it is exact either way,
          // and because it stops generated handlers from splitting into two
          // populations distinguishable by whether they normalise.
          normalize: true,
          fnId: boundFnId,
          frame:
            boundFnId === null
              ? undefined
              : frameKeyConstants(
                  compiler.fnDescriptors[boundFnId]?.salt ?? 0,
                ),
          srcNames,
          srcKinds,
          taintNames: taint ? [TAINT_VAR] : undefined,
          domains: domainsFor(plan),
        };
        compiler.OP_NAME[slot] = `MBA_SUP_${seq++}`;
        list.push(slot);
      }
    }

    return list.length > 0 ? choice(list) : null;
  };

  // ── Rewrite ───────────────────────────────────────────────────────────────
  const result: Bytecode = [];
  let fusedCount = 0;
  let savedInstrs = 0;
  let i = 0;

  while (i < bc.length) {
    let matched = false;

    // Longest first: a four-instruction chain is strictly better than the
    // two-instruction one nested inside it.
    for (let len = Math.min(MAX_WINDOW, bc.length - i); len >= 2; len--) {
      const plan = planWindow(bc.slice(i, i + len));
      if (!plan) continue;

      const taint = taintFor(plan.fnId);
      const opcode = handlerFor(plan, taint);
      if (opcode === null) continue;

      const operands: Instruction[number][] = [{ ...plan.dst }];
      for (const leaf of plan.leaves) {
        operands.push(leaf.kind === "reg" ? { ...leaf.reg! } : leaf.value!);
      }
      // Last, matching the order handlerFor recorded in `srcNames`.
      if (taint) operands.push({ ...taint });
      result.push([opcode, ...operands]);

      fusedCount++;
      savedInstrs += len - 1;
      i += len;
      matched = true;
      break;
    }

    if (!matched) {
      result.push(bc[i]);
      i++;
    }
  }

  compiler.log(
    `mbaSuperOps: ${fusedCount} chains fused, ${savedInstrs} instructions ` +
      `removed, ${seq} superoperator handlers`,
  );

  return { bytecode: result };
}
