// Control Flow Flattening (CFF)
//
// Splits each function into basic blocks and routes all execution through a
// while-loop + switch-style comparison chain that dispatches based on a
// `state` register.  Original jumps become state transitions.
//
// ── How it works ─────────────────────────────────────────────────────────────
//
// 1. Each function's instruction stream is split into basic blocks at every
//    label definition and after every terminator (JUMP, JUMP_IF_*, RETURN,
//    THROW).
//
// 2. Each block is assigned a random u16 state value.  A sentinel endState
//    (not used by any block) marks loop termination.
//
// 3. A dispatch loop is compiled from a Template:
//
//      var state = <startState>;
//      while (state !== <endState>) {
//        if (state === <s0>) _VM_JUMP_("<block0>");
//        if (state === <s1>) _VM_JUMP_("<block1>");
//        ...
//      }
//
//    The Template's `state` register is extracted via compileInline() so that
//    block bodies can write state transitions to it.
//
// 4. Block bodies are emitted with their original instructions.  Terminators
//    are rewritten:
//
//      JUMP target         → LOAD_INT state, targetBlock.stateValue
//                             JUMP <loopTop>
//
//      JUMP_IF_FALSE c, t  → JUMP_IF_TRUE c, <skipLabel>
//                             LOAD_INT state, targetBlock.stateValue
//                             JUMP <loopTop>
//                             <skipLabel>:
//                             LOAD_INT state, fallthroughBlock.stateValue
//                             JUMP <loopTop>
//
//      RETURN / THROW      → kept in-place (exits the VM frame directly)
//
// 5. Block order is shuffled randomly so spatial locality gives no hints.
//
// ── Pipeline position ─────────────────────────────────────────────────────────
// Same slot as Dispatcher: before resolveRegisters and resolveLabels.
// Can run alongside Dispatcher (they are composable).

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

// ── Helpers (shared pattern with dispatcher.ts) ──────────────────────────────

function ref(r: RegisterOperand): RegisterOperand {
  return b.registerOperand(r.id, r.fnId);
}

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

function extractLabel(op: InstrOperand | undefined): string | null {
  if (op && typeof op === "object" && (op as any).type === "label")
    return (op as any).label as string;
  return null;
}

// ── Basic block splitting ────────────────────────────────────────────────────

interface BasicBlock {
  label: string;
  body: Bytecode;
  terminator: Instruction | null;
  stateValue: number;
  // Index of the block that originally followed this one (for fallthroughs).
  // -1 means "no successor" (last block, or ends with RETURN/THROW).
  originalNextIndex: number;
}

function isTerminator(op: number, compiler: Compiler): boolean {
  const OP = compiler.OP;
  return (
    op === OP.JUMP ||
    op === OP.JUMP_IF_FALSE ||
    op === OP.JUMP_IF_TRUE ||
    op === OP.RETURN ||
    op === OP.THROW
  );
}

function splitBasicBlocks(
  instrs: Bytecode,
  compiler: Compiler,
): BasicBlock[] {
  const blocks: BasicBlock[] = [];
  const usedStates = new Set<number>();

  const assignState = (): number => {
    let s: number;
    do {
      s = getRandomInt(0, U16_MAX);
    } while (usedStates.has(s));
    usedStates.add(s);
    return s;
  };

  let currentLabel: string | null = null;
  let currentBody: Bytecode = [];

  const flushBlock = (terminator: Instruction | null) => {
    if (currentBody.length === 0 && terminator === null && currentLabel === null)
      return;

    const label = currentLabel ?? compiler._makeLabel("cff_block");
    blocks.push({
      label,
      body: currentBody,
      terminator,
      stateValue: assignState(),
      originalNextIndex: -1, // filled in after all blocks are created
    });
    currentBody = [];
    currentLabel = null;
  };

  for (const instr of instrs) {
    const op = instr[0];

    // defineLabel → start a new block boundary
    if (op === null && (instr[1] as any)?.type === "defineLabel") {
      flushBlock(null);
      currentLabel = (instr[1] as any).label;
      continue;
    }

    // Terminator → ends the current block
    if (op !== null && isTerminator(op, compiler)) {
      flushBlock(instr);
      continue;
    }

    currentBody.push(instr);
  }

  // Flush trailing instructions
  flushBlock(null);

  // Split large blocks (> MAX_BLOCK_SIZE instructions) into smaller chunks
  // so that no single block reveals too much sequential code.
  const MAX_BLOCK_SIZE = 3;
  const splitBlocks: BasicBlock[] = [];
  for (const block of blocks) {
    if (block.body.length <= MAX_BLOCK_SIZE) {
      splitBlocks.push(block);
      continue;
    }
    // Chunk the body into pieces of MAX_BLOCK_SIZE
    for (let j = 0; j < block.body.length; j += MAX_BLOCK_SIZE) {
      const isFirst = j === 0;
      const isLast = j + MAX_BLOCK_SIZE >= block.body.length;
      splitBlocks.push({
        label: isFirst ? block.label : compiler._makeLabel("cff_split"),
        body: block.body.slice(j, j + MAX_BLOCK_SIZE),
        terminator: isLast ? block.terminator : null,
        stateValue: isFirst ? block.stateValue : assignState(),
        originalNextIndex: -1,
      });
    }
  }
  // Replace blocks with split result
  blocks.length = 0;
  blocks.push(...splitBlocks);

  // Wire up originalNextIndex for fallthrough resolution
  for (let i = 0; i < blocks.length - 1; i++) {
    blocks[i].originalNextIndex = i + 1;
  }
  // Last block has no successor
  if (blocks.length > 0) {
    blocks[blocks.length - 1].originalNextIndex = -1;
  }

  return blocks;
}

// ── Cross-block register promotion ───────────────────────────────────────────
// Scans all blocks (bodies + terminators) and finds register operands that
// appear in more than one block.  Those registers must not be in the "temp"
// pool because resolveRegisters' linear scan doesn't understand the CFF
// dispatch loop and would reuse their slots between blocks.
//
// Promotion is done in-place: we delete the `kind` property on the operand
// objects so they default to the "local::" pool (which never reuses slots).

function promoteMultiBlockRegisters(blocks: BasicBlock[]): void {
  // (fnId, regId) → index of first block where this register was seen
  const regFirstBlock = new Map<string, number>();
  // Set of register keys that appear in 2+ blocks
  const multiBlockRegs = new Set<string>();

  for (let bi = 0; bi < blocks.length; bi++) {
    const allInstrs = blocks[bi].terminator
      ? [...blocks[bi].body, blocks[bi].terminator!]
      : blocks[bi].body;

    for (const instr of allInstrs) {
      for (let j = 1; j < instr.length; j++) {
        const op = instr[j] as any;
        if (op && typeof op === "object" && op.type === "register") {
          const key = `${op.fnId}:${op.id}`;
          const first = regFirstBlock.get(key);
          if (first === undefined) {
            regFirstBlock.set(key, bi);
          } else if (first !== bi) {
            multiBlockRegs.add(key);
          }
        }
      }
    }
  }

  if (multiBlockRegs.size === 0) return;

  // Second pass: promote all operand instances of multi-block registers
  for (const block of blocks) {
    const allInstrs = block.terminator
      ? [...block.body, block.terminator!]
      : block.body;

    for (const instr of allInstrs) {
      for (let j = 1; j < instr.length; j++) {
        const op = instr[j] as any;
        if (op && typeof op === "object" && op.type === "register") {
          const key = `${op.fnId}:${op.id}`;
          if (multiBlockRegs.has(key)) {
            delete op.kind; // "local::" pool — no slot reuse
          }
        }
      }
    }
  }
}

// ── Generate the dispatch loop via Template ──────────────────────────────────

function buildDispatchTemplate(
  blocks: BasicBlock[],
  endState: number,
  startState: number,
  compiler: Compiler,
  fnId: number,
  maxId: Map<number, number>,
): {
  bytecode: Bytecode;
  rState: RegisterOperand;
  loopTopLabel: string;
  loopExitLabel: string;
  innerBytecode: Bytecode;
} {
  // Build the if-chain cases
  const cases = blocks
    .map(
      (block) =>
        `if (state === ${block.stateValue}) _VM_JUMP_("${block.label}");`,
    )
    .join("\n    ");

  const source = `
    var state = ${startState};
    while (state !== ${endState}) {
      ${cases}
    }
  `;

  const tmpl = new Template(source);
  const result = tmpl.compileInline({}, compiler, fnId, maxId);

  // Mark ALL dispatch-loop registers as "local" pool so resolveRegisters
  // never reuses their slots for function-body temps.  The dispatch loop
  // is re-entered on every state transition (backward JUMP to while_top),
  // but the linear-scan liveness in resolveRegisters doesn't track loops,
  // so it would incorrectly think dispatch temps die after one pass and
  // overlap their slots with body registers that are live across blocks.
  for (const instr of result.bytecode) {
    for (let j = 1; j < instr.length; j++) {
      const op = instr[j] as any;
      if (op && typeof op === "object" && op.type === "register") {
        delete op.kind; // removes "temp" → defaults to "local::" pool
      }
    }
  }

  const rState = result.registers.get("state");
  if (!rState) {
    throw new Error("CFF: Template did not produce a 'state' register");
  }

  // Find the while loop labels from the compiled IR
  let loopTopLabel: string | null = null;
  let loopExitLabel: string | null = null;

  for (const instr of result.bytecode) {
    if (instr[0] === null && (instr[1] as any)?.type === "defineLabel") {
      const label = (instr[1] as any).label as string;
      if (label.includes("while_top") && !loopTopLabel) {
        loopTopLabel = label;
      }
      if (label.includes("while_exit") && !loopExitLabel) {
        loopExitLabel = label;
      }
    }
  }

  if (!loopTopLabel || !loopExitLabel) {
    throw new Error("CFF: Could not find while loop labels in Template output");
  }

  return {
    bytecode: result.bytecode,
    rState,
    loopTopLabel,
    loopExitLabel,
    innerBytecode: result.innerBytecode,
  };
}

// ── State transition helpers ─────────────────────────────────────────────────

function emitStateTransition(
  out: Bytecode,
  rState: RegisterOperand,
  targetState: number,
  loopTopLabel: string,
  compiler: Compiler,
): void {
  out.push([compiler.OP.LOAD_INT!, ref(rState), targetState]);
  out.push([compiler.OP.JUMP!, { type: "label", label: loopTopLabel }]);
}

// ── Per-function transformation ──────────────────────────────────────────────

function processFunctionBlock(
  instrs: Bytecode,
  fnId: number,
  compiler: Compiler,
  maxId: Map<number, number>,
): { instrs: Bytecode; templateBytecode: Bytecode } {
  const OP = compiler.OP;

  // Only transform functions that contain simple jumps
  const hasRoutableJump = instrs.some((instr) => {
    const op = instr[0];
    return op === OP.JUMP || op === OP.JUMP_IF_FALSE || op === OP.JUMP_IF_TRUE;
  });
  if (!hasRoutableJump) return { instrs, templateBytecode: [] };

  // ── 1. Split into basic blocks ──────────────────────────────────────────
  const blocks = splitBasicBlocks(instrs, compiler);
  if (blocks.length < 2) return { instrs, templateBytecode: [] };

  // ── 1b. Promote cross-block registers to "local" pool ──────────────────
  // resolveRegisters does a linear-scan liveness analysis that doesn't
  // understand the CFF dispatch loop (backward jumps).  A "temp" register
  // that's live across two blocks would appear to die within its first
  // block and get its slot reused, corrupting values read in later blocks.
  //
  // Fix: find every register that appears in more than one block and
  // delete its "temp" kind so it lands in the "local::" pool (no reuse).
  promoteMultiBlockRegisters(blocks);

  const usedStates = new Set(blocks.map((b) => b.stateValue));

  // Pick endState sentinel
  let endState: number;
  do {
    endState = getRandomInt(0, U16_MAX);
  } while (usedStates.has(endState));

  const startState = blocks[0].stateValue;

  // ── 2. Build dispatch loop from Template ────────────────────────────────
  const dispatch = buildDispatchTemplate(
    blocks,
    endState,
    startState,
    compiler,
    fnId,
    maxId,
  );
  const { rState, loopTopLabel, loopExitLabel } = dispatch;

  // ── 3. Pre-compute all state mappings BEFORE shuffle ─────────────────
  // These maps capture the correct stateValues while the blocks array is
  // still in its original split order.  After the shuffle, indexing into
  // blocks[] by original index would give the wrong block.

  // label → stateValue (for jump target resolution)
  const labelToState = new Map<string, number>();
  for (const block of blocks) {
    labelToState.set(block.label, block.stateValue);
  }

  // originalIndex → fallthrough stateValue
  const fallthroughStateMap = new Map<number, number>();
  for (let i = 0; i < blocks.length; i++) {
    const next = blocks[i].originalNextIndex;
    fallthroughStateMap.set(
      i,
      next >= 0 ? blocks[next].stateValue : endState,
    );
  }

  // ── 4. Shuffle block order ──────────────────────────────────────────────
  // Track which original index each shuffled position came from, so we can
  // look up fallthroughStateMap correctly during emission.
  const originalIndices = blocks.map((_, i) => i);

  // Fisher-Yates shuffle
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = getRandomInt(0, i);
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    [originalIndices[i], originalIndices[j]] = [
      originalIndices[j],
      originalIndices[i],
    ];
  }

  // ── 5. Emit: dispatch loop + block bodies ───────────────────────────────
  const out: Bytecode = [];

  // Dispatch loop (var state = ...; while(...) { if-chain })
  out.push(...dispatch.bytecode);

  // Each block: defineLabel → body → state transition → JUMP loopTop
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const origIdx = originalIndices[i];

    // Block label
    out.push([null, { type: "defineLabel", label: block.label }]);

    // Block body
    out.push(...block.body);

    // Terminator rewriting
    const term = block.terminator;

    if (term === null) {
      // Fallthrough → transition to the original next block's state
      emitStateTransition(
        out,
        rState,
        fallthroughStateMap.get(origIdx)!,
        loopTopLabel,
        compiler,
      );
    } else if (term[0] === OP.RETURN || term[0] === OP.THROW) {
      // Exits the frame — emit as-is
      out.push(term);
    } else if (term[0] === OP.JUMP) {
      const targetLabel = extractLabel(term[1]);
      if (targetLabel !== null) {
        const targetState = labelToState.get(targetLabel);
        if (targetState !== undefined) {
          emitStateTransition(out, rState, targetState, loopTopLabel, compiler);
        } else {
          // Target outside this function's blocks — keep original
          out.push(term);
        }
      } else {
        out.push(term);
      }
    } else if (term[0] === OP.JUMP_IF_FALSE) {
      // Original: if (!cond) goto target; else fallthrough
      // → if (cond) goto skipLabel  (inverted)
      //   state = targetState; goto loopTop
      //   skipLabel:
      //   state = fallthroughState; goto loopTop
      const cond = term[1] as RegisterOperand;
      const targetLabel = extractLabel(term[2]);

      if (targetLabel !== null) {
        const targetState = labelToState.get(targetLabel);
        if (targetState !== undefined) {
          const skipLabel = compiler._makeLabel("cff_skip");

          out.push([
            OP.JUMP_IF_TRUE!,
            cond,
            { type: "label", label: skipLabel },
          ]);
          emitStateTransition(
            out,
            rState,
            targetState,
            loopTopLabel,
            compiler,
          );
          out.push([null, { type: "defineLabel", label: skipLabel }]);
          emitStateTransition(
            out,
            rState,
            fallthroughStateMap.get(origIdx)!,
            loopTopLabel,
            compiler,
          );
        } else {
          out.push(term);
        }
      } else {
        out.push(term);
      }
    } else if (term[0] === OP.JUMP_IF_TRUE) {
      // Original: if (cond) goto target; else fallthrough
      // → if (!cond) goto skipLabel  (inverted)
      //   state = targetState; goto loopTop
      //   skipLabel:
      //   state = fallthroughState; goto loopTop
      const cond = term[1] as RegisterOperand;
      const targetLabel = extractLabel(term[2]);

      if (targetLabel !== null) {
        const targetState = labelToState.get(targetLabel);
        if (targetState !== undefined) {
          const skipLabel = compiler._makeLabel("cff_skip");

          out.push([
            OP.JUMP_IF_FALSE!,
            cond,
            { type: "label", label: skipLabel },
          ]);
          emitStateTransition(
            out,
            rState,
            targetState,
            loopTopLabel,
            compiler,
          );
          out.push([null, { type: "defineLabel", label: skipLabel }]);
          emitStateTransition(
            out,
            rState,
            fallthroughStateMap.get(origIdx)!,
            loopTopLabel,
            compiler,
          );
        } else {
          out.push(term);
        }
      } else {
        out.push(term);
      }
    }
  }

  return { instrs: out, templateBytecode: dispatch.innerBytecode };
}

// ── Pass entry point ──────────────────────────────────────────────────────────
export function controlFlowFlattening(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const maxId = buildMaxIdMap(bc);

  const entryLabels = new Set(compiler.fnDescriptors.map((d) => d.entryLabel));
  const entryLabelToFnId = new Map(
    compiler.fnDescriptors.map((d) => [d.entryLabel!, d._fnIdx!]),
  );

  const result: Bytecode = [];
  const templateBytecodes: Bytecode[] = [];
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

    const entryLabel = (operand0 as any).label as string;
    const fnId = entryLabelToFnId.get(entryLabel)!;
    i++;

    const fnInstrs: Bytecode = [];
    while (i < bc.length) {
      const next = bc[i];
      const [nextOp, nextOp0] = next;
      if (
        nextOp === null &&
        (nextOp0 as any)?.type === "defineLabel" &&
        entryLabels.has((nextOp0 as any).label)
      )
        break;
      fnInstrs.push(next);
      i++;
    }

    result.push(instr); // the defineLabel
    const { instrs: processed, templateBytecode } = processFunctionBlock(
      fnInstrs,
      fnId,
      compiler,
      maxId,
    );
    result.push(...processed);
    if (templateBytecode.length > 0) templateBytecodes.push(templateBytecode);
  }

  for (const tb of templateBytecodes) {
    result.push(...tb);
  }

  return { bytecode: result };
}
