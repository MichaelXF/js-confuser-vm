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
//
// Enabled by options.dispatcher = true.

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

// VERY IMPORTANT: All object operands should be unique objects for the entire compilation process.
// This ensures that other passes that may reference/modify operands (e.g. specializedOpcodes) don't accidentally break behavior by mutating cloned objects.
function ref(r: RegisterOperand): RegisterOperand {
  return b.registerOperand(r.id, r.fnId);
}

// Monotonically increasing counter that makes every encoded label operand
// JSON.stringify-distinguishable.  specializedOpcodes keys candidates by
// JSON.stringify(operands), which drops the transform function.  Without this
// counter, two LOAD_INT instructions for the same label but different siteKeys
// would serialize identically and be coalesced into one specialized opcode
// sharing a single operand object — causing both sites to decode with the
// first site's key rather than their own.
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

// ── Register allocation helpers ───────────────────────────────────────────────
// At pass time FnContext objects are gone; we allocate new virtual registers by
// scanning the bytecode for the highest existing id per fnId and incrementing.
function buildMaxIdMap(bc: Bytecode): Map<number, number> {
  const maxId = new Map<number, number>();
  for (const instr of bc) {
    for (let j = 1; j < instr.length; j++) {
      const op = instr[j] as any;
      if (op && op.type === "register") {
        const cur = maxId.get(op.fnId) ?? -1;
        if (op.id > cur) maxId.set(op.fnId, op.id);
      }
    }
  }
  return maxId;
}

// Allocate a new virtual register for fnId, updating maxId in-place.
function allocReg(fnId: number, maxId: Map<number, number>): RegisterOperand {
  const next = (maxId.get(fnId) ?? -1) + 1;
  maxId.set(fnId, next);
  return b.registerOperand(next, fnId);
}

// ── Label operand extraction ──────────────────────────────────────────────────
// Returns the label string if the operand is a { type:"label" } object,
// otherwise returns null.  Used to identify routable jump targets.
function extractLabel(op: InstrOperand | undefined): string | null {
  if (op && typeof op === "object" && (op as any).type === "label")
    return (op as any).label as string;
  return null;
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
): { instrs: Bytecode; templateBytecode: Bytecode } {
  const OP = compiler.OP;

  // Only transform functions that actually contain simple jumps.
  const hasRoutableJump = instrs.some((instr) => {
    const op = instr[0];
    return op === OP.JUMP || op === OP.JUMP_IF_FALSE || op === OP.JUMP_IF_TRUE;
  });
  if (!hasRoutableJump) return { instrs, templateBytecode: [] };

  // Per-function salt baked into this function's decode Template.
  // Never stored as an operand — lives only inside the decode closure body.
  const fnSalt = getRandomInt(1, U16_MAX);

  // Compile a unique decode closure for this function.
  // The fnSalt literal is inlined into the source so each function's closure
  // body is structurally distinct; no single signature covers all functions.
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

  return { instrs: out, templateBytecode: tmpl.bytecode };
}

// ── Pass entry point ──────────────────────────────────────────────────────────
export function dispatcher(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // Pre-compute max virtual register id per function across the whole bytecode.
  const maxId = buildMaxIdMap(bc);

  // Label factory that delegates to the compiler's own counter so labels
  // produced here never collide with compiler-generated or pass-generated ones.
  const labelCounter = () => compiler._makeLabel("dispatcher");

  // Build a set of entry labels so we can detect function boundaries.
  const entryLabels = new Set(compiler.fnDescriptors.map((d) => d.entryLabel));
  // Build a map from entry label → fnId.
  const entryLabelToFnId = new Map(
    compiler.fnDescriptors.map((d) => [d.entryLabel!, d._fnIdx!]),
  );

  const result: Bytecode = [];
  // Collect each function's decode Template bytecode; appended at the end so
  // all MAKE_CLOSURE instructions can reference their entryLabels regardless
  // of where in the bytecode the function appears.
  const decodeBytecodes: Bytecode[] = [];
  let i = 0;

  while (i < bc.length) {
    const instr = bc[i];
    const [op, operand0] = instr;
    const isEntryLabel =
      op === null &&
      (operand0 as any)?.type === "defineLabel" &&
      entryLabels.has((operand0 as any).label);

    if (!isEntryLabel) {
      result.push(instr);
      i++;
      continue;
    }

    // Found a function entry label.  Collect all instructions belonging to
    // this function (until the next entry label or end of bytecode).
    const entryLabel = (operand0 as any).label as string;
    const fnId = entryLabelToFnId.get(entryLabel)!;
    i++; // step past the defineLabel itself

    const fnInstrs: Bytecode = [];
    while (i < bc.length) {
      const next = bc[i];
      const [nextOp, nextOp0] = next;
      if (
        nextOp === null &&
        (nextOp0 as any)?.type === "defineLabel" &&
        entryLabels.has((nextOp0 as any).label)
      )
        break; // next function starts here
      fnInstrs.push(next);
      i++;
    }

    // Emit the entry defineLabel, then the (potentially transformed) body.
    result.push(instr); // the defineLabel
    const { instrs: processed, templateBytecode } = processFunctionBlock(
      fnInstrs,
      fnId,
      compiler,
      maxId,
      labelCounter,
    );
    result.push(...processed);
    if (templateBytecode.length > 0) decodeBytecodes.push(templateBytecode);
  }

  // Append all per-function decode closure bodies at the end of the bytecode.
  // Each block defines the entryLabel that the corresponding MAKE_CLOSURE
  // instruction references.
  for (const tb of decodeBytecodes) {
    result.push(...tb);
  }

  return { bytecode: result };
}
