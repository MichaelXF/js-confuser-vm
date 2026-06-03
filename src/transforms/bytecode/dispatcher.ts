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
// embeds a per-function constant (fnSalt).  Every function gets its own
// distinct decode closure body, so identifying one does not help with others.
//
//   function decode(x, k) { return ((x ^ k) + FN_SALT) & 0xFFFF; }
//
// Jump site transformations (each site has its own random siteKey):
//
//   Original:  JUMP target_label
//   Becomes:   LOAD_INT rDisp, (target_label_pc - fnSalt) ^ siteKey
//              LOAD_INT rKey,  siteKey
//              JUMP     <dispatcher_N>
//
//   Original:  JUMP_IF_FALSE cond, target_label
//   Becomes:   JUMP_IF_TRUE  cond, <skip_N>
//              LOAD_INT rDisp, (target_label_pc - fnSalt) ^ siteKey
//              LOAD_INT rKey,  siteKey
//              JUMP     <dispatcher_N>
//              <skip_N>:
//
//   Original:  JUMP_IF_TRUE cond, target_label
//   Becomes:   JUMP_IF_FALSE cond, <skip_N>
//              LOAD_INT rDisp, (target_label_pc - fnSalt) ^ siteKey
//              LOAD_INT rKey,  siteKey
//              JUMP     <dispatcher_N>
//              <skip_N>:
//
// ── Encoding scheme ──────────────────────────────────────────────────────────
// Two-key mixed encoding: XOR (per-site) + SUB/ADD (per-function).
//
//   encode(pc, siteKey, fnSalt) = (pc - fnSalt) ^ siteKey
//   decode(x,  k,       fnSalt) = (x  ^ k)      + fnSalt
//
// The siteKey is a random nonzero u16 unique per jump site — stored as a plain
// integer operand in the bytecode.
// The fnSalt is a random nonzero u16 unique per function — it is never stored
// as an operand anywhere; it is compiled as a literal constant inside the
// function's own decode Template body.
//
// Attack resistance:
//   • Brute-forcing a single jump requires enumerating siteKey × fnSalt
//     (~4 billion combinations) rather than just siteKey (65 535).
//   • Assuming pure XOR fails: un-XOR-ing with siteKey yields (pc - fnSalt),
//     not pc.  Valid-PC heuristics produce wrong answers.
//   • Each function emits its own decode closure bytecode with a different
//     fnSalt literal baked in.  There is no shared signature to fingerprint.
//   • The encode and decode operations differ structurally (SUB vs ADD),
//     removing the self-inverse property that makes XOR-only schemes obvious.
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
import { U16_MAX } from "../../utils/op-utils.ts";
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
  fnSalt: number,
): InstrOperand {
  return {
    type: "label",
    label,
    _id: _encodedLabelId++, // unique per site — survives JSON.stringify
    transform: (pc) => applyEncoding(pc, siteKey, fnSalt),
  } as InstrOperand;
}

// ── Encoding scheme (XOR + SUB/ADD, u16 modular) ────────────────────────────
// applyEncoding(pc, siteKey, fnSalt): the value stored in rDisp at the jump site.
// Must be the inverse of the decode function compiled by the Template.
//   encode: ((pc - fnSalt) & 0xFFFF) ^ siteKey   → always a valid u16
//   decode: ((x ^ siteKey) + fnSalt) & 0xFFFF    ← compiled into the per-function Template
// The & 0xFFFF mask keeps both sides in [0, 65535], preventing negative LOAD_INT operands.
function applyEncoding(pc: number, siteKey: number, fnSalt: number): number {
  return ((pc - fnSalt) & U16_MAX) ^ siteKey;
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

  // Per-function salt baked into this function's decode Template.
  // Never stored as an operand — lives only inside the decode closure body.
  const fnSalt = getRandomInt(1, U16_MAX);

  // Compile a unique decode closure for this function.
  const tmpl = new Template(
    `function decode(x, k) { return ((x ^ k) + ${fnSalt}) & ${U16_MAX}; }`,
  ).compile({}, compiler);
  const decodeDesc = tmpl.functions[0];

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

      const siteKey = getRandomInt(1, U16_MAX);
      out.push([
        OP.LOAD_INT!,
        ref(rDisp),
        encodedLabelOperand(targetLabel, siteKey, fnSalt),
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

      const siteKey = getRandomInt(1, U16_MAX);
      const skipLabel = compiler._makeLabel(targetLabel + "_skip");
      out.push([OP.JUMP_IF_TRUE!, cond, { type: "label", label: skipLabel }]);
      out.push([
        OP.LOAD_INT!,
        ref(rDisp),
        encodedLabelOperand(targetLabel, siteKey, fnSalt),
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

      const siteKey = getRandomInt(1, U16_MAX);
      const skipLabel = compiler._makeLabel(targetLabel + "_skip");
      out.push([OP.JUMP_IF_FALSE!, cond, { type: "label", label: skipLabel }]);
      out.push([
        OP.LOAD_INT!,
        ref(rDisp),
        encodedLabelOperand(targetLabel, siteKey, fnSalt),
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

  return { instrs: out, tail: tmpl.bytecode };
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
