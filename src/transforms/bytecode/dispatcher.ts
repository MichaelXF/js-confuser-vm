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
//              unique XOR key.  The dispatcher passes it to the decode closure.
//   rClosure — holds the decode closure, created ONCE at function entry
//              (hoisted).  All dispatch calls reuse the same closure object.
//
// Dispatcher block (appended after the function body, never reached by fall-through):
//
//   <dispatcher_N>:
//     CALL     rDisp, rClosure, 2, rDisp, rKey  // rDisp = decode(rDisp, rKey)
//     JUMP_REG rDisp                            // indirect jump to recovered PC
//
// The decode function is compiled ONCE PER FUNCTION from a Template that
// embeds two per-function constants (fnMul, fnAdd).  Every function gets its
// own distinct decode closure body, so identifying one does not help with
// others.
//
//   function decode(x, k) {
//     x = (x ^ k) >>> 0;             // undo per-site XOR
//     x = Math.imul(x, FN_MUL) >>> 0;// per-function modular multiply (u32)
//     x = (x ^ (x >>> 16)) >>> 0;    // non-linear avalanche (self-inverse)
//     return (x + FN_ADD) >>> 0;     // per-function additive offset (u32)
//   }
//
// Jump site transformations (each site has its own random siteKey):
//
//   Original:  JUMP target_label
//   Becomes:   LOAD_INT rDisp, encode(target_label_pc, siteKey)
//              LOAD_INT rKey,  siteKey
//              JUMP     <dispatcher_N>
//
//   Original:  JUMP_IF_FALSE cond, target_label
//   Becomes:   JUMP_IF_TRUE  cond, <skip_N>
//              LOAD_INT rDisp, encode(target_label_pc, siteKey)
//              LOAD_INT rKey,  siteKey
//              JUMP     <dispatcher_N>
//              <skip_N>:
//
//   Original:  JUMP_IF_TRUE cond, target_label
//   Becomes:   JUMP_IF_FALSE cond, <skip_N>
//              LOAD_INT rDisp, encode(target_label_pc, siteKey)
//              LOAD_INT rKey,  siteKey
//              JUMP     <dispatcher_N>
//              <skip_N>:
//
// ── Encoding scheme (u32, non-linear) ────────────────────────────────────────
// Every operation runs modulo 2^32 (the bytecode slot width — slots are stored
// in a Uint32Array, see decodeBytecode in runtime.ts).  decode is a bijection
// on u32; encode is its exact inverse, computed at compile time:
//
//   decode = (+fnAdd) ∘ xorshift16 ∘ (·*fnMul)   ∘ (^siteKey)
//   encode = (^siteKey) ∘ (·*fnMulInv) ∘ xorshift16 ∘ (-fnAdd)
//
// where fnMul is a random ODD u32 (invertible mod 2^32), fnMulInv is its
// modular inverse mod 2^32, fnAdd is a random u32, and xorshift16(x) =
// x ^ (x >>> 16) is its own inverse.  fnMulInv lives only in the compiler;
// the runtime decode never needs it.
//
// The siteKey is a random nonzero u32 unique per jump site — stored as a plain
// integer operand in the bytecode.  fnMul and fnAdd are per-function u32
// constants — never stored as operands; they are compiled as literal constants
// inside the function's own decode Template body.
//
// Attack resistance (vs. the previous u16 XOR+ADD scheme):
//   • Keyspace per site is now u32 (siteKey) over a u32 modulus, and the
//     per-function secret is two u32 constants — naive enumeration jumps from
//     ~2^16 to ~2^96 combinations.
//   • The scheme is NOT affine.  The old (x ^ k) + salt let a single known
//     jump target recover salt by subtraction, instantly decoding every other
//     jump in the function.  The multiply + xorshift avalanche removes that
//     algebraic shortcut: known-plaintext pairs no longer yield the constants
//     by linear solving.
//   • Assuming pure XOR fails: un-XOR-ing with siteKey yields the multiplied,
//     avalanched word — not pc.  Valid-PC heuristics produce wrong answers.
//   • Each function bakes a different (fnMul, fnAdd) pair, so there is no
//     shared signature to fingerprint across functions.
//
// To change the scheme:
//   1. Change the Template source in processFunctionBlock() to match new decode.
//   2. Change applyEncoding() to return the matching encode transform.
//   Only these two places need updating; everything else is scheme-agnostic.
//
// ── Pipeline position ─────────────────────────────────────────────────────────
// Runs BEFORE resolveRegisters (so injected RegisterOperands are picked up by
// liveness analysis) and BEFORE resolveLabels (so label operands with transforms
// are resolved as part of the normal label-resolution pass).

import type {
  Bytecode,
  Instruction,
  RegisterOperand,
  InstrOperand,
} from "../../types.ts";
import * as b from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import { getRandomInt } from "../../utils/random-utils.ts";
import { U32_MAX } from "../../utils/op-utils.ts";
import { Template } from "../../template.ts";
import {
  ref,
  buildMaxIdMap,
  allocReg,
  extractLabel,
  forEachFunction,
} from "../../utils/pass-utils.ts";
// VERY IMPORTANT: All object operands should be unique objects for the entire compilation process.
// This ensures that other passes that may reference/modify operands (e.g. specializedOpcodes) don't accidentally break behavior by mutating cloned objects.

// VERY IMPORTANT: All "encoded" label operands include a unique "_id" property that survives JSON.stringify.
// This allows Specialized Opcodes and other passes to correct distinguish them as the "transform" function WILL NOT be preserved
let _encodedLabelId = 0;
function encodedLabelOperand(
  label: string,
  siteKey: number,
  fnAdd: number,
  fnMulInv: number,
): InstrOperand {
  return {
    type: "label",
    label,
    _id: _encodedLabelId++, // unique per site — survives JSON.stringify
    transform: (pc) => applyEncoding(pc, siteKey, fnAdd, fnMulInv),
  } as InstrOperand;
}

// modInverseU32: modular inverse of an ODD u32 `a` modulo 2^32 (extended
// Euclid in BigInt to avoid float-precision loss on the intermediate products).
// fnMul is always odd, so gcd(fnMul, 2^32) === 1 and the inverse exists.
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

// ── Encoding scheme (u32 modular, non-linear) ───────────────────────────────
// applyEncoding(pc, siteKey, fnAdd, fnMulInv): the value stored in rDisp at the
// jump site.  It is the EXACT inverse of the decode function compiled by the
// Template, walked in reverse order:
//
//   decode: x=(x^k)>>>0; x=imul(x,fnMul)>>>0; x=(x^(x>>>16))>>>0; (x+fnAdd)>>>0
//   encode: y=(pc-fnAdd)>>>0; y=(y^(y>>>16))>>>0; y=imul(y,fnMulInv)>>>0; (y^k)>>>0
//
// Every stage is coerced back to u32 with `>>> 0` so the result is always a
// valid non-negative LOAD_INT operand and matches the VM's modular arithmetic
// bit-for-bit.  imul(·, fnMul) and imul(·, fnMulInv) cancel (mod 2^32), and
// x ^ (x >>> 16) is its own inverse, so decode(encode(pc)) === pc.
function applyEncoding(
  pc: number,
  siteKey: number,
  fnAdd: number,
  fnMulInv: number,
): number {
  let y = (pc - fnAdd) >>> 0; // inverse of (+ fnAdd)
  y = (y ^ (y >>> 16)) >>> 0; // inverse of the xorshift avalanche (self-inverse)
  y = Math.imul(y, fnMulInv) >>> 0; // inverse of (* fnMul)
  y = (y ^ siteKey) >>> 0; // inverse of (^ siteKey)
  return y;
}

// buildDispatcherBlock: emits the dispatcher label + call + indirect jump.
// rClosure is already live (created at function entry); this block simply
// calls the decode closure and jumps to the result.
function buildDispatcherBlock(
  compiler: Compiler,
  rDisp: RegisterOperand,
  rKey: RegisterOperand,
  rClosure: RegisterOperand,
  dispatcherLabel: string,
): Instruction[] {
  const OP = compiler.OP;
  return [
    [null, { type: "defineLabel", label: dispatcherLabel }],

    // decode(rDisp, rKey) → rDisp.  Args are read before dst is written.
    [
      OP.CALL!,
      ref(rDisp), // dst — receives decoded PC
      ref(rClosure), // the hoisted decode closure
      2, // argc
      ref(rDisp), // arg[0] = encoded value
      ref(rKey), // arg[1] = per-site key
    ],

    [OP.JUMP_REG!, ref(rDisp)],
  ];
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

  // Per-function constants baked into this function's decode Template.
  // Never stored as operands — they live only inside the decode closure body.
  //   fnMul    — random ODD u32, invertible mod 2^32 (the multiply step).
  //   fnAdd    — random u32 additive offset.
  //   fnMulInv — modular inverse of fnMul; used by encode only (compile time).
  const fnMul = (getRandomInt(1, U32_MAX >>> 1) * 2 + 1) >>> 0; // odd u32 in [3, 2^32-1]
  const fnAdd = getRandomInt(1, U32_MAX);
  const fnMulInv = modInverseU32(fnMul);

  // Compile a unique decode closure for this function.  Each stage is masked
  // back to u32 with `>>> 0` so it mirrors the compile-time encode exactly.
  const template = new Template(
    `function decode(x, k) {
       x = (x ^ k) >>> 0;
       x = Math.imul(x, ${fnMul}) >>> 0;
       x = (x ^ (x >>> 16)) >>> 0;
       return (x + ${fnAdd}) >>> 0;
     }`,
  ).compile({}, compiler);
  const decodeDesc = template.functions[0];

  const dispatcherLabel = labelCounter();
  const rDisp = allocReg(fnId, maxId); // carries encoded PC to dispatcher
  const rKey = allocReg(fnId, maxId); // carries per-site key to dispatcher
  const rClosure = allocReg(fnId, maxId); // holds the hoisted decode closure

  const out: Bytecode = [];

  // ── Hoist: create the decode closure once at function entry ───────────────
  out.push([
    OP.MAKE_CLOSURE!,
    ref(rClosure),
    { type: "label", label: decodeDesc.entryLabel },
    decodeDesc.paramCount, // 2 (x, k)
    b.fnRegCountOperand(decodeDesc._fnIdx), // resolved by resolveRegisters()
    0, // no upvalues
    0, // hasRest = false
  ]);

  // ── Transform each instruction ────────────────────────────────────────────
  for (const instr of instrs) {
    const op = instr[0];

    if (op === OP.JUMP) {
      // [JUMP, label] → [LOAD_INT rDisp, encoded] + [LOAD_INT rKey, siteKey] + [JUMP dispatcher]
      const targetLabel = extractLabel(instr[1]);
      if (targetLabel === null) {
        out.push(instr);
        continue;
      }

      const siteKey = getRandomInt(1, U32_MAX);
      out.push([
        OP.LOAD_INT!,
        ref(rDisp),
        encodedLabelOperand(targetLabel, siteKey, fnAdd, fnMulInv),
      ]);
      out.push([OP.LOAD_INT!, ref(rKey), siteKey]);
      out.push([OP.JUMP!, { type: "label", label: dispatcherLabel }]);
    } else if (op === OP.JUMP_IF_FALSE) {
      // Invert to JUMP_IF_TRUE so the false path (jump taken) falls into dispatch.
      const cond = instr[1] as RegisterOperand;
      const targetLabel = extractLabel(instr[2]);
      if (targetLabel === null) {
        out.push(instr);
        continue;
      }

      const siteKey = getRandomInt(1, U32_MAX);
      const skipLabel = compiler._makeLabel(targetLabel + "_skip");
      out.push([OP.JUMP_IF_TRUE!, cond, { type: "label", label: skipLabel }]);
      out.push([
        OP.LOAD_INT!,
        ref(rDisp),
        encodedLabelOperand(targetLabel, siteKey, fnAdd, fnMulInv),
      ]);
      out.push([OP.LOAD_INT!, ref(rKey), siteKey]);
      out.push([OP.JUMP!, { type: "label", label: dispatcherLabel }]);
      out.push([null, { type: "defineLabel", label: skipLabel }]);
    } else if (op === OP.JUMP_IF_TRUE) {
      // Invert to JUMP_IF_FALSE so the true path (jump taken) falls into dispatch.
      const cond = instr[1] as RegisterOperand;
      const targetLabel = extractLabel(instr[2]);
      if (targetLabel === null) {
        out.push(instr);
        continue;
      }

      const siteKey = getRandomInt(1, U32_MAX);
      const skipLabel = compiler._makeLabel(targetLabel + "_skip");
      out.push([OP.JUMP_IF_FALSE!, cond, { type: "label", label: skipLabel }]);
      out.push([
        OP.LOAD_INT!,
        ref(rDisp),
        encodedLabelOperand(targetLabel, siteKey, fnAdd, fnMulInv),
      ]);
      out.push([OP.LOAD_INT!, ref(rKey), siteKey]);
      out.push([OP.JUMP!, { type: "label", label: dispatcherLabel }]);
      out.push([null, { type: "defineLabel", label: skipLabel }]);
    } else {
      out.push(instr);
    }
  }

  // Dispatcher block appended after the function body.  Never reached by
  // fall-through; all entries are via the JUMP dispatcher instructions above.
  out.push(
    ...buildDispatcherBlock(compiler, rDisp, rKey, rClosure, dispatcherLabel),
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
