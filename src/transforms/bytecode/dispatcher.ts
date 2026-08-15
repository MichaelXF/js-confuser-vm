// Routes simple unconditional and conditional jumps through a per-function
// central dispatcher block so that static analysis cannot read jump targets
// directly from the bytecode operands.
//
// ── How it works ─────────────────────────────────────────────────────────────
//
// Each function that contains at least one routable jump gets:
//
//   rDisp    — a stable register shared across the whole function.
//              At every jump site, the per-site encoded target PC is written
//              here before jumping to the dispatcher block.
//   rKey     — a stable register written at every jump site with that site's
//              unique key.  The dispatcher passes it to the decode closure.
//              (In the "split" param mode this carries the LOW half and rKeyHi
//              carries the high half.)
//   rClosure — holds the decode closure, created ONCE at function entry
//              (hoisted).  All dispatch calls reuse the same closure object.
//   rT/rDelta— scratch registers used only by the branchless conditional
//              lowering (see BRANCHLESS_JUMPS below).
//   rOut     — scratch register used only when the decode closure returns its
//              result inside a container (array / object return modes).
//
// Dispatcher block (appended after the function body, never reached by fall-through):
//
//   <dispatcher_N>:
//     CALL     rDisp, rClosure, <argc>, <args…>   // rDisp = decode(...)
//     [LOAD_INT/LOAD_CONST rOut, <index|prop>]    // container return modes only
//     [GET_PROP rDisp, rDisp, rOut]               // container return modes only
//     JUMP_REG rDisp                              // indirect jump to recovered PC
//
// ── Per-function decode closure ──────────────────────────────────────────────
//
// The decode function is compiled ONCE PER FUNCTION from a Template.  Its shape
// is RANDOMISED per function along three independent axes so that identifying
// one decode closure teaches an attacker nothing about the next one — neither
// within a build nor across builds:
//
//   1. Arithmetic — the body is a random sequence of 4–7 invertible u32 steps
//      (multiply / xor / add / sub / rotate / xorshift / bitwise-not / key mix)
//      in random order.  See DecodeStep.  The compile-time `encode` is derived
//      mechanically as the reversed composition of each step's inverse, so the
//      scheme is not hardcoded anywhere.
//
//   2. Parameter plumbing — one of:
//        (x, k)            decode(encoded, key)
//        (k, x)            decode(key, encoded)          — swapped arity order
//        (x, kLo, kHi)     key delivered as two u16 halves, recombined inside
//
//   3. Result plumbing — one of:
//        return x;              direct
//        return [x];            caller reads index 0
//        return { pNN: x };     caller reads a random property name
//
// Example (one possible shape):
//
//   function decode(x, kLo, kHi) {
//     var k = (kLo | (kHi << 16)) >>> 0;
//     x = (x ^ k) >>> 0;
//     x = Math.imul(x, 2463534243) >>> 0;
//     x = ((x << 7) | (x >>> 25)) >>> 0;
//     x = (x ^ (x >>> 19)) >>> 0;
//     x = (x + 91123344) >>> 0;
//     return [x];
//   }
//
// Every step is a bijection on u32, so the composition is a bijection and the
// inverse always exists.  encodedLabelOperand() asserts decode(encode(pc)) === pc
// for every single site at label-resolution time, so a mis-derived inverse is a
// hard build failure rather than a silent miscompile.
//
// ── Jump site transformations ────────────────────────────────────────────────
//
// Each site has its own random u32 siteKey.
//
//   Original:  JUMP target_label
//   Becomes:   LOAD_INT rDisp, encode(target_label_pc, siteKey)
//              <emitKey siteKey>
//              JUMP     <dispatcher_N>
//
// Conditional jumps: see BRANCHLESS_JUMPS.
//
// ── BRANCHLESS_JUMPS ─────────────────────────────────────────────────────────
//
// The legacy lowering kept a real conditional opcode at every site:
//
//   JUMP_IF_TRUE  cond, <skip_N>          <- plaintext "there is a branch here"
//   LOAD_INT rDisp, encode(target)        <- taken edge encrypted
//   LOAD_INT rKey,  siteKey
//   JUMP     <dispatcher_N>
//   <skip_N>:                             <- fall-through edge in the CLEAR
//
// That hands a lifter the entire CFG skeleton for free: every branch site is
// identified by opcode, and one of its two out-edges is a plain PC.  Only the
// taken edge was ever protected.
//
// The branchless lowering removes the conditional opcode entirely and computes
// the target with ordinary arithmetic:
//
//   t = +!cond                            // exactly 0 or 1, never NaN
//   rDisp = enc(base) + t * (enc(other) - enc(base))
//
// which evaluates to enc(base) at t=0 and enc(other) at t=1 — exactly, and
// regardless of `decode` being non-affine, because we only ever interpolate
// between the two endpoints and only ever evaluate at t ∈ {0, 1}.
//
//   Original:  JUMP_IF_FALSE cond, target        (jump when cond is FALSY)
//              t == 1 selects target  ->  base = skip,   other = target
//   Original:  JUMP_IF_TRUE  cond, target        (jump when cond is TRUTHY)
//              t == 0 selects target  ->  base = target, other = skip
//
//   Becomes:   UNARY_NOT rT,     cond            // !cond   (always boolean)
//              UNARY_POS rT,     rT              // 0 | 1
//             [UNARY_NEG rT,     rT]             // 0 | -1  (BAND variant only)
//              LOAD_INT  rDisp,  encode(base_pc,  siteKey)
//              LOAD_INT  rDelta, encode(other_pc, siteKey)
//              SUB       rDelta, rDelta, rDisp
//              MUL|BAND  rDelta, rT,     rDelta  // select
//              ADD       rDisp,  rDisp,  rDelta
//              <emitKey siteKey>
//              JUMP      <dispatcher_N>
//              <skip_N>:
//
// Properties this buys:
//   • JUMP_IF_FALSE / JUMP_IF_TRUE no longer appear in routed functions at all,
//     so branch sites cannot be enumerated by opcode.
//   • BOTH out-edges are encoded.  There is no plaintext CFG edge left.
//   • The emitted sequence is shape-identical for both branch polarities (only
//     the ORDER of the two LOAD_INTs differs), so `if (x)` and `if (!x)` are
//     indistinguishable in the opcode stream.
//   • Branch sites read as ordinary arithmetic; recovering the CFG now requires
//     dataflow analysis rather than pattern matching.
//
// Two interchangeable select encodings are emitted at random so the lowering is
// not one fixed opcode signature:
//   MUL  variant:  rDelta = t * delta          (t ∈ {0, 1})
//   BAND variant:  rDelta = delta & -t         (-t ∈ {0, -1}; all-ones mask)
// The BAND variant goes through ToInt32, so for |delta| >= 2^31 it can yield
// `enc(other) - 2^32` rather than `enc(other)`.  That is harmless: every decode
// step begins with a 32-bit coercion (`^`, `>>>`, `<<`, `~`, `Math.imul`, or
// `+`/`-` followed by `>>> 0`), and the two values are congruent mod 2^32, so
// decode produces the identical result.
//
// Cost: a conditional site grows from 4 instructions / 11 slots to 9–10
// instructions / 29–32 slots.  macroOpcodes reliably folds the sequence back
// down since it becomes the highest-frequency window in the program.
//
// Set BRANCHLESS_JUMPS to false to restore the legacy conditional lowering
// (useful when debugging bytecode by hand — the branchless form is much harder
// to read in the disassembly).
//
// ── Why this is safe against the downstream passes ───────────────────────────
// The lowering depends only on register VALUES — never on operand position, PC
// offsets, or instruction width.  That is what makes it survive
// antiInstrumentation (which permutes operand order and fuses fake effects into
// ADD/SUB/MUL/BAND/UNARY_*), aliasedOpcodes (operand-order variants),
// specializedOpcodes (constant folding, which accounts for flat width via
// `placeholder`), and macroOpcodes (which permits the terminal JUMP).
//
// ── Pipeline position ─────────────────────────────────────────────────────────
// Runs BEFORE resolveRegisters (so injected RegisterOperands are picked up by
// liveness analysis) and BEFORE resolveLabels (so label operands with transforms
// are resolved as part of the normal label-resolution pass).
//
// IMPORTANT: this pass runs AFTER controlFlowFlattening (see the pass list in
// compileAndSerialize).  That ordering is load-bearing: CFF emits its own
// JUMP / JUMP_IF_* terminators and fake-block forks, and they are rewritten here
// like any other jump.  Consequently CFF's conditionals get the branchless
// treatment for free, and CFF does NOT need its own copy of this lowering.  If
// the pass order is ever swapped, that coverage silently disappears.

import type {
  Bytecode,
  Instruction,
  RegisterOperand,
  InstrOperand,
} from "../../types.ts";
import * as b from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import { getRandomInt, choice, chance, shuffle } from "../../utils/random-utils.ts";
import { U32_MAX } from "../../utils/op-utils.ts";
import { Template } from "../../template.ts";
import {
  ref,
  buildMaxIdMap,
  allocReg,
  extractLabel,
  forEachFunction,
} from "../../utils/pass-utils.ts";
import { ok } from "assert";

// Lower conditional jumps to a branchless arithmetic select (see header).
// Flip to false to emit the legacy JUMP_IF_* lowering, which is far easier to
// follow when reading a disassembly by hand.
const BRANCHLESS_JUMPS = true;

// VERY IMPORTANT: All object operands should be unique objects for the entire compilation process.
// This ensures that other passes that may reference/modify operands (e.g. specializedOpcodes) don't accidentally break behavior by mutating cloned objects.

// ── Decode scheme ────────────────────────────────────────────────────────────
// A decode function is a composition of invertible u32 steps.  Each step knows
// three things: how to run forwards (compile-time mirror of the runtime), how to
// run backwards (used to build `encode`), and how to render itself as JS for the
// Template.  Adding a new step kind means adding one case to each of those three
// functions and nothing else.

type DecodeStep =
  | { kind: "xor"; c: number }
  | { kind: "add"; c: number }
  | { kind: "sub"; c: number }
  | { kind: "mul"; c: number; cInv: number }
  // s is constrained to [16, 31] so that x ^ (x >>> s) is its own inverse:
  // ((x >>> s) >>> s) === 0 for every u32 x once s >= 16.
  | { kind: "xorshift"; s: number }
  // n is constrained to [1, 31]; rotl(n) is inverted by rotl(32 - n).  n === 0
  // (or 32) would render as a shift by 32, which JS evaluates as a shift by 0.
  | { kind: "rot"; n: number }
  | { kind: "not" }
  | { kind: "keyXor" }
  | { kind: "keyAdd" };

// modInverseU32: modular inverse of an ODD u32 `a` modulo 2^32 (extended
// Euclid in BigInt to avoid float-precision loss on the intermediate products).
// Multiply steps always pick an odd constant, so gcd(c, 2^32) === 1 and the
// inverse exists.
function modInverseU32(a: number): number {
  const MOD = 1n << 32n;
  let [oldR, r] = [BigInt(a >>> 0), MOD];
  let [oldT, t] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldT, t] = [t, oldT - q * t];
  }
  return Number(((oldT % MOD) + MOD) % MOD);
}

function randomOddU32(): number {
  return (getRandomInt(1, U32_MAX >>> 1) * 2 + 1) >>> 0;
}

// Compile-time mirror of what the generated JS does at runtime.  Must stay
// bit-identical to stepSource().
function stepForward(step: DecodeStep, x: number, k: number): number {
  switch (step.kind) {
    case "xor":
      return (x ^ step.c) >>> 0;
    case "add":
      return (x + step.c) >>> 0;
    case "sub":
      return (x - step.c) >>> 0;
    case "mul":
      return Math.imul(x, step.c) >>> 0;
    case "xorshift":
      return (x ^ (x >>> step.s)) >>> 0;
    case "rot":
      return ((x << step.n) | (x >>> (32 - step.n))) >>> 0;
    case "not":
      return ~x >>> 0;
    case "keyXor":
      return (x ^ k) >>> 0;
    case "keyAdd":
      return (x + k) >>> 0;
  }
}

// Exact inverse of stepForward for the same step.
function stepInverse(step: DecodeStep, x: number, k: number): number {
  switch (step.kind) {
    case "xor":
      return (x ^ step.c) >>> 0; // self-inverse
    case "add":
      return (x - step.c) >>> 0;
    case "sub":
      return (x + step.c) >>> 0;
    case "mul":
      return Math.imul(x, step.cInv) >>> 0;
    case "xorshift":
      return (x ^ (x >>> step.s)) >>> 0; // self-inverse for s >= 16
    case "rot":
      return ((x << (32 - step.n)) | (x >>> step.n)) >>> 0; // rotl(32 - n)
    case "not":
      return ~x >>> 0; // self-inverse
    case "keyXor":
      return (x ^ k) >>> 0; // self-inverse
    case "keyAdd":
      return (x - k) >>> 0;
  }
}

// JS source for one step, operating on the locals `x` and `k`.
function stepSource(step: DecodeStep): string {
  switch (step.kind) {
    case "xor":
      return `x = (x ^ ${step.c}) >>> 0;`;
    case "add":
      return `x = (x + ${step.c}) >>> 0;`;
    case "sub":
      return `x = (x - ${step.c}) >>> 0;`;
    case "mul":
      return `x = Math.imul(x, ${step.c}) >>> 0;`;
    case "xorshift":
      return `x = (x ^ (x >>> ${step.s})) >>> 0;`;
    case "rot":
      return `x = ((x << ${step.n}) | (x >>> ${32 - step.n})) >>> 0;`;
    case "not":
      return `x = (~x) >>> 0;`;
    case "keyXor":
      return `x = (x ^ k) >>> 0;`;
    case "keyAdd":
      return `x = (x + k) >>> 0;`;
  }
}

function applyDecode(steps: DecodeStep[], x: number, k: number): number {
  let v = x >>> 0;
  for (let i = 0; i < steps.length; i++) v = stepForward(steps[i], v, k);
  return v >>> 0;
}

function applyEncode(steps: DecodeStep[], pc: number, k: number): number {
  let v = pc >>> 0;
  for (let i = steps.length - 1; i >= 0; i--) v = stepInverse(steps[i], v, k);
  return v >>> 0;
}

// Build a random step list.  A multiply (algebraic mixing), an xorshift
// (non-linear avalanche) and exactly one key-mixing step are always present so
// the scheme never degenerates into something affine or key-independent; the
// rest is filler, and the whole list is shuffled so even the mandatory steps
// land in unpredictable positions.
function makeDecodeSteps(): DecodeStep[] {
  const mulC = randomOddU32();

  const steps: DecodeStep[] = [
    { kind: "mul", c: mulC, cInv: modInverseU32(mulC) },
    { kind: "xorshift", s: getRandomInt(16, 31) },
    chance(50) ? { kind: "keyXor" } : { kind: "keyAdd" },
  ];

  const extras = getRandomInt(1, 4);
  for (let i = 0; i < extras; i++) {
    switch (getRandomInt(0, 4)) {
      case 0:
        steps.push({ kind: "xor", c: getRandomInt(1, U32_MAX) });
        break;
      case 1:
        steps.push({ kind: "add", c: getRandomInt(1, U32_MAX) });
        break;
      case 2:
        steps.push({ kind: "sub", c: getRandomInt(1, U32_MAX) });
        break;
      case 3:
        steps.push({ kind: "rot", n: getRandomInt(1, 31) });
        break;
      case 4:
        steps.push({ kind: "not" });
        break;
    }
  }

  return shuffle(steps);
}

// How the encoded value and the site key are handed to the decode closure.
//   "xk"    → decode(x, k)
//   "kx"    → decode(k, x)
//   "split" → decode(x, kLo, kHi), key recombined inside the closure
type ParamMode = "xk" | "kx" | "split";

// How the decoded PC comes back out of the decode closure.
//   "direct" → return x
//   "array"  → return [x]        , dispatcher reads index 0
//   "object" → return { p: x }   , dispatcher reads the property
type ReturnMode = "direct" | "array" | "object";

interface DecodeScheme {
  steps: DecodeStep[];
  paramMode: ParamMode;
  returnMode: ReturnMode;
  propName: string;
  source: string;
}

// Identifier of the form <letter><digit><letters>.  The embedded digit
// guarantees the name can never collide with a JS reserved word, so it is
// always safe to emit as a bare object-literal key.
function randomPropName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const pick = () => letters[getRandomInt(0, letters.length - 1)];
  let s = pick() + String(getRandomInt(0, 9));
  const tail = getRandomInt(2, 4);
  for (let i = 0; i < tail; i++) s += pick();
  return s;
}

function makeDecodeScheme(): DecodeScheme {
  const steps = makeDecodeSteps();
  const paramMode = choice(["xk", "kx", "split"]) as ParamMode;
  const returnMode = choice(["direct", "array", "object"]) as ReturnMode;
  const propName = randomPropName();

  const body: string[] = [];

  let params: string;
  if (paramMode === "xk") {
    params = "x, k";
  } else if (paramMode === "kx") {
    params = "k, x";
  } else {
    params = "x, kLo, kHi";
    body.push("var k = (kLo | (kHi << 16)) >>> 0;");
  }

  for (const step of steps) body.push(stepSource(step));

  if (returnMode === "direct") {
    body.push("return x;");
  } else if (returnMode === "array") {
    body.push("return [x];");
  } else {
    // NOTE: the space after `{` matters — Template._interpolate() throws on any
    // unresolved `{word}` placeholder, and `{ p1abc: x }` cannot match that.
    body.push(`return { ${propName}: x };`);
  }

  const source = `function decode(${params}) {\n  ${body.join("\n  ")}\n}`;

  return { steps, paramMode, returnMode, propName, source };
}

// ── Encoded label operands ───────────────────────────────────────────────────
// VERY IMPORTANT: All "encoded" label operands include a unique "_id" property that survives JSON.stringify.
// This allows Specialized Opcodes and other passes to correct distinguish them as the "transform" function WILL NOT be preserved
let _encodedLabelId = 0;
function encodedLabelOperand(
  label: string,
  siteKey: number,
  scheme: DecodeScheme,
): InstrOperand {
  return {
    type: "label",
    label,
    _id: _encodedLabelId++, // unique per site — survives JSON.stringify
    transform: (pc: number) => {
      const encoded = applyEncode(scheme.steps, pc, siteKey);
      // Self-check: a mis-derived inverse would otherwise produce a build that
      // jumps to garbage PCs at runtime.  Fail loudly at compile time instead.
      ok(
        applyDecode(scheme.steps, encoded, siteKey) === pc >>> 0,
        "dispatcher: decode(encode(pc)) !== pc — decode scheme inverse is wrong",
      );
      return encoded;
    },
  } as InstrOperand;
}

// ── Dispatcher block ─────────────────────────────────────────────────────────
// Emits the dispatcher label + decode call + indirect jump.  rClosure is already
// live (created at function entry); this block simply calls the decode closure,
// unwraps the result if the scheme returns a container, and jumps to it.
function buildDispatcherBlock(
  compiler: Compiler,
  scheme: DecodeScheme,
  rDisp: RegisterOperand,
  rKey: RegisterOperand,
  rKeyHi: RegisterOperand,
  rClosure: RegisterOperand,
  rOut: RegisterOperand,
  dispatcherLabel: string,
): Instruction[] {
  const OP = compiler.OP;

  const args: RegisterOperand[] =
    scheme.paramMode === "xk"
      ? [ref(rDisp), ref(rKey)]
      : scheme.paramMode === "kx"
        ? [ref(rKey), ref(rDisp)]
        : [ref(rDisp), ref(rKey), ref(rKeyHi)];

  const block: Instruction[] = [
    [null, { type: "defineLabel", label: dispatcherLabel }],

    // decode(...) → rDisp.  Args are read before dst is written.
    [
      OP.CALL!,
      ref(rDisp), // dst — receives the decoded PC (or its container)
      ref(rClosure), // the hoisted decode closure
      args.length, // argc
      ...args,
    ] as Instruction,
  ];

  // Container return modes: pull the PC back out.  GET_PROP reads dst, then obj,
  // then key — so reusing rDisp as both dst and obj is safe.
  if (scheme.returnMode === "array") {
    block.push([OP.LOAD_INT!, ref(rOut), 0]);
    block.push([OP.GET_PROP!, ref(rDisp), ref(rDisp), ref(rOut)]);
  } else if (scheme.returnMode === "object") {
    block.push([
      OP.LOAD_CONST!,
      ref(rOut),
      b.constantOperand(scheme.propName),
    ] as Instruction);
    block.push([OP.GET_PROP!, ref(rDisp), ref(rDisp), ref(rOut)]);
  }

  block.push([OP.JUMP_REG!, ref(rDisp)]);

  return block;
}

// ── Per-function transformation ───────────────────────────────────────────────
// Returns the transformed instruction stream and the template bytecode block
// for the per-function decode closure (to be appended at the end of the output).
function processFunctionBlock(
  instrs: Bytecode,
  fnId: number,
  compiler: Compiler,
  maxId: Map<number, number>,
  labelCounter: () => string,
): { instrs: Bytecode; tail: Bytecode } {
  const OP = compiler.OP;

  // Only transform functions that actually contain simple jumps.
  const hasRoutableJump = instrs.some((instr) => {
    const op = instr[0];
    return op === OP.JUMP || op === OP.JUMP_IF_FALSE || op === OP.JUMP_IF_TRUE;
  });
  if (!hasRoutableJump) return { instrs, tail: [] };

  // Randomised per-function decode shape: arithmetic, parameter plumbing and
  // result plumbing are all independently chosen.  Nothing about this function's
  // decode closure carries over to any other function.
  const scheme = makeDecodeScheme();

  const template = new Template(scheme.source).compile({}, compiler);
  const decodeDesc = template.functions[0];

  const dispatcherLabel = labelCounter();

  // Registers allocated here that never end up in the emitted stream cost
  // nothing: resolveRegisters only assigns slots to registers it actually sees
  // as operands, so an unused allocation merely burns a virtual id.
  const rDisp = allocReg(fnId, maxId); // carries encoded PC to dispatcher
  const rKey = allocReg(fnId, maxId); // per-site key (low half in "split" mode)
  const rKeyHi = allocReg(fnId, maxId); // high half of the key ("split" mode only)
  const rClosure = allocReg(fnId, maxId); // holds the hoisted decode closure
  const rOut = allocReg(fnId, maxId); // container unwrap key (array/object modes)
  const rT = allocReg(fnId, maxId); // branchless select: 0|1 (or 0|-1)
  const rDelta = allocReg(fnId, maxId); // branchless select: encoded-target delta

  const out: Bytecode = [];

  // ── Hoist: create the decode closure once at function entry ───────────────
  out.push(
    compiler.markClosureParent(
      [
        OP.MAKE_CLOSURE!,
        ref(rClosure),
        { type: "label", label: decodeDesc.entryLabel },
        decodeDesc.paramCount, // 2 or 3, depending on the param mode
        b.fnRegCountOperand(decodeDesc._fnIdx), // resolved by resolveRegisters()
        0, // no upvalues
        0, // hasRest = false
        compiler.saltSeedOperand(), // frame SALT seed — resolveSalts fills it in
      ] as Instruction,
      fnId,
    ),
  );

  // Write the site key into the register(s) the decode closure expects.
  const emitKey = (dst: Bytecode, siteKey: number) => {
    if (scheme.paramMode === "split") {
      dst.push([OP.LOAD_INT!, ref(rKey), siteKey & 0xffff]);
      dst.push([OP.LOAD_INT!, ref(rKeyHi), siteKey >>> 16]);
    } else {
      dst.push([OP.LOAD_INT!, ref(rKey), siteKey]);
    }
  };

  // Unconditional route: load the single encoded target and enter the dispatcher.
  const emitRoute = (dst: Bytecode, targetLabel: string, siteKey: number) => {
    dst.push([
      OP.LOAD_INT!,
      ref(rDisp),
      encodedLabelOperand(targetLabel, siteKey, scheme),
    ] as Instruction);
    emitKey(dst, siteKey);
    dst.push([OP.JUMP!, { type: "label", label: dispatcherLabel }]);
  };

  // Branchless conditional route.
  //
  //   t      = +!cond                                  (exactly 0 or 1)
  //   rDisp  = enc(baseLabel) + t * (enc(otherLabel) - enc(baseLabel))
  //
  // t == 0 selects baseLabel, t == 1 selects otherLabel — exactly, because we
  // interpolate between the two encoded endpoints and only ever evaluate at the
  // endpoints.  `cond` is forwarded as the SAME operand object taken from the
  // original instruction (not a ref() copy) so that any `pinned` marker set by
  // controlFlowFlattening survives into the rewritten stream.
  const emitBranchless = (
    dst: Bytecode,
    cond: RegisterOperand,
    baseLabel: string,
    otherLabel: string,
    siteKey: number,
  ) => {
    // Two interchangeable select encodings so the lowering is not one fixed
    // opcode signature.
    const useBand = chance(50);

    dst.push([OP.UNARY_NOT!, ref(rT), cond]); // !cond — always a boolean
    dst.push([OP.UNARY_POS!, ref(rT), ref(rT)]); // +bool — 0 or 1, never NaN
    if (useBand) dst.push([OP.UNARY_NEG!, ref(rT), ref(rT)]); // 0 or -1 (all ones)

    dst.push([
      OP.LOAD_INT!,
      ref(rDisp),
      encodedLabelOperand(baseLabel, siteKey, scheme),
    ] as Instruction);
    dst.push([
      OP.LOAD_INT!,
      ref(rDelta),
      encodedLabelOperand(otherLabel, siteKey, scheme),
    ] as Instruction);

    dst.push([OP.SUB!, ref(rDelta), ref(rDelta), ref(rDisp)]);

    // MUL and BAND are both commutative — randomise operand order for free
    // shape diversity.
    const selOp = (useBand ? OP.BAND : OP.MUL)!;
    dst.push(
      chance(50)
        ? [selOp, ref(rDelta), ref(rT), ref(rDelta)]
        : [selOp, ref(rDelta), ref(rDelta), ref(rT)],
    );

    dst.push([OP.ADD!, ref(rDisp), ref(rDisp), ref(rDelta)]);

    emitKey(dst, siteKey);
    dst.push([OP.JUMP!, { type: "label", label: dispatcherLabel }]);
  };

  // Legacy conditional route (BRANCHLESS_JUMPS === false): keep a real
  // conditional opcode and route only the taken edge.
  const emitLegacyConditional = (
    dst: Bytecode,
    invertedOp: number,
    cond: RegisterOperand,
    targetLabel: string,
    skipLabel: string,
    siteKey: number,
  ) => {
    dst.push([invertedOp, cond, { type: "label", label: skipLabel }]);
    emitRoute(dst, targetLabel, siteKey);
  };

  // ── Transform each instruction ────────────────────────────────────────────
  for (const instr of instrs) {
    const op = instr[0];

    if (op === OP.JUMP) {
      // [JUMP, label] → [LOAD_INT rDisp, encoded] + <key> + [JUMP dispatcher]
      const targetLabel = extractLabel(instr[1]);
      if (targetLabel === null) {
        out.push(instr);
        continue;
      }

      emitRoute(out, targetLabel, getRandomInt(1, U32_MAX));
    } else if (op === OP.JUMP_IF_FALSE || op === OP.JUMP_IF_TRUE) {
      const cond = instr[1] as RegisterOperand;
      const targetLabel = extractLabel(instr[2]);
      if (targetLabel === null) {
        out.push(instr);
        continue;
      }

      const siteKey = getRandomInt(1, U32_MAX);
      const skipLabel = compiler._makeLabel(targetLabel + "_skip");
      const jumpWhenFalse = op === OP.JUMP_IF_FALSE;

      if (BRANCHLESS_JUMPS) {
        // t = +!cond.
        //   JUMP_IF_FALSE: taken when cond is falsy → t == 1 → target is "other"
        //   JUMP_IF_TRUE:  taken when cond is truthy → t == 0 → target is "base"
        const baseLabel = jumpWhenFalse ? skipLabel : targetLabel;
        const otherLabel = jumpWhenFalse ? targetLabel : skipLabel;
        emitBranchless(out, cond, baseLabel, otherLabel, siteKey);
      } else {
        // Invert the test so the taken path falls into the dispatcher.
        emitLegacyConditional(
          out,
          (jumpWhenFalse ? OP.JUMP_IF_TRUE : OP.JUMP_IF_FALSE)!,
          cond,
          targetLabel,
          skipLabel,
          siteKey,
        );
      }

      out.push([null, { type: "defineLabel", label: skipLabel }]);
    } else {
      out.push(instr);
    }
  }

  // Dispatcher block appended after the function body.  Never reached by
  // fall-through; all entries are via the JUMP dispatcher instructions above.
  out.push(
    ...buildDispatcherBlock(
      compiler,
      scheme,
      rDisp,
      rKey,
      rKeyHi,
      rClosure,
      rOut,
      dispatcherLabel,
    ),
  );

  return { instrs: out, tail: template.bytecode };
}

// ── Pass entry point ──────────────────────────────────────────────────────────
export function dispatcher(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const maxId = buildMaxIdMap(bc);
  // Label factory delegates to the compiler's counter so labels never collide.
  const labelCounter = () => compiler._makeLabel("dispatcher");
  // forEachFunction collects each function's tail (decode closure bytecode) and
  // appends them all after the last function body, so every MAKE_CLOSURE can
  // reference its entryLabel regardless of where it appears in the bytecode.
  return forEachFunction(bc, compiler, (fnInstrs, fnId) =>
    processFunctionBlock(fnInstrs, fnId, compiler, maxId, labelCounter),
  );
}
