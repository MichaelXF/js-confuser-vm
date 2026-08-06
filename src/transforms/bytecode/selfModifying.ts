import type { Bytecode, Instruction, InstrOperand } from "../../types.ts";
import { Compiler } from "../../compiler.ts";
import {
  choice,
  chance,
  getRandomInt,
  shuffle,
} from "../../utils/random-utils.ts";
import { getInstructionSize, U16_MAX, U32_MAX } from "../../utils/op-utils.ts";

// PATCH is [opcode, destPc, sliceStart, sliceEnd, key] — 5 flat slots.
export const PATCH_FLAT_SIZE = 5;

// Hangs off a real region's defineLabel operand, for encryptPatches to find.
// Later passes rebuild instruction arrays but keep operand objects by identity,
// so it has to live on the operand rather than in a registry keyed by position.
// Decoy patches carry none of this — there is nothing about them to encrypt.
export interface PatchRegion {
  key: number;
  instrCount: number;
  flatSize: number;
  destPcOperand: any; // resolveLabels fills in resolvedValue
}

// Floor on how much this pass adds, in bytecode entries. Small programs have
// only a handful of patchable blocks, so without a floor they end up with one
// patched instruction and nothing else.
const MIN_ADDED = 100;

// Decoy budget, as a fraction of the real-patch budget.
const DECOY_RATIO = 0.2;

// Max number of separate patched regions carved out of one basic block.
const MAX_CHUNKS = 3;

// The junk arena — dead blocks at the end of the bytecode that every decoy
// PATCH reads from and writes to. See createJunkBlock().
const ARENA_BLOCKS_MIN = 3;
const ARENA_BLOCKS_MAX = 5;
const ARENA_BLOCK_MIN_SLOTS = 24;
const ARENA_BLOCK_MAX_SLOTS = 64;
const DECOY_COPY_MAX_SLOTS = 16;

// Odds a given unconditional terminator gets a decoy planted after it.
const DECOY_AFTER_TERMINATOR_CHANCE = 35;

// Odds a slot of placeholder garbage starts a decoy PATCH rather than filler.
const DECOY_IN_FILLER_CHANCE = 25;

// Operand shapes for the junk instructions decoys are padded with. None of this
// ever runs, it just has to look like real code to a linear disassembler.
//
// Deliberately no constant-reading ops (LOAD_CONST / LOAD_GLOBAL / TYPEOF_SAFE):
// their operands are a pool index + conceal key, and the comment generator
// decrypts those for the listing. A junk key turns a real string into arbitrary
// UTF-16, which breaks the output if it happens to contain U+2028.
type Kind = "reg" | "int";
const FILLER_SHAPES: Record<string, Kind[]> = {
  TRY_END: [],
  LOAD_THIS: ["reg"],
  MOVE: ["reg", "reg"],
  LOAD_INT: ["reg", "int"],
  UNARY_NEG: ["reg", "reg"],
  UNARY_NOT: ["reg", "reg"],
  UNARY_BITNOT: ["reg", "reg"],
  TYPEOF: ["reg", "reg"],
  ADD: ["reg", "reg", "reg"],
  SUB: ["reg", "reg", "reg"],
  MUL: ["reg", "reg", "reg"],
  DIV: ["reg", "reg", "reg"],
  MOD: ["reg", "reg", "reg"],
  BAND: ["reg", "reg", "reg"],
  BOR: ["reg", "reg", "reg"],
  BXOR: ["reg", "reg", "reg"],
  SHL: ["reg", "reg", "reg"],
  SHR: ["reg", "reg", "reg"],
  USHR: ["reg", "reg", "reg"],
  LT: ["reg", "reg", "reg"],
  GT: ["reg", "reg", "reg"],
  LTE: ["reg", "reg", "reg"],
  GTE: ["reg", "reg", "reg"],
  EQ: ["reg", "reg", "reg"],
  NEQ: ["reg", "reg", "reg"],
  GET_PROP: ["reg", "reg", "reg"],
};

// A dead, labelled run of junk with a known flat size. Decoy PATCHes address
// nothing else, so applying one — statically or, if some placement assumption
// were ever wrong, at runtime — only ever writes junk over junk.
interface JunkBlock {
  label: string;
  slots: number;
  instrs: Bytecode;
}

const flatSize = (chunk: Bytecode) =>
  chunk.reduce((acc, instr) => acc + getInstructionSize(instr), 0);

// Split a body into `count` contiguous, non-empty chunks at random boundaries.
function splitChunks(body: Bytecode, count: number): Bytecode[] {
  const N = body.length;
  if (count <= 1) return [body];

  const cuts = new Set<number>();
  while (cuts.size < count - 1) cuts.add(getRandomInt(1, N - 1));

  const bounds = [0, ...Array.from(cuts).sort((a, b) => a - b), N];
  const chunks: Bytecode[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    chunks.push(body.slice(bounds[i], bounds[i + 1]));
  }
  return chunks;
}

function createDecoyFactory(compiler: Compiler, arena: JunkBlock[]) {
  const { OP } = compiler;
  const opValues = Object.values(OP).map((v) => +v);

  const shapes = Object.keys(FILLER_SHAPES)
    .filter((name) => typeof OP[name] === "number")
    .map((name) => ({
      op: OP[name] as number,
      kinds: FILLER_SHAPES[name],
      width: 1 + FILLER_SHAPES[name].length,
    }));

  const genOperand = (kind: Kind): InstrOperand =>
    kind === "reg" ? getRandomInt(0, 24) : getRandomInt(0, U16_MAX);

  // Reads one junk block, writes another. Both ranges are clamped inside their
  // block, so the copy can never touch real code or a real region's ciphertext.
  const decoyPatch = (): Instruction => {
    const dst = choice(arena);
    const src = choice(arena);
    const len = getRandomInt(
      1,
      Math.min(DECOY_COPY_MAX_SLOTS, dst.slots, src.slots),
    );
    const srcOffset = getRandomInt(0, src.slots - len);

    return [
      OP.PATCH as number,
      { type: "label", label: dst.label, offset: getRandomInt(0, dst.slots - len) },
      { type: "label", label: src.label, offset: srcOffset },
      { type: "label", label: src.label, offset: srcOffset + len },
      getRandomInt(0, U32_MAX),
    ] as unknown as Instruction;
  };

  const filler = (maxWidth: number): Instruction => {
    const fits = maxWidth > 1 ? shapes.filter((s) => s.width <= maxWidth) : [];
    if (fits.length === 0) return [choice(opValues)] as Instruction;
    const shape = choice(fits);
    return [shape.op, ...shape.kinds.map(genOperand)] as Instruction;
  };

  return {
    // Junk occupying exactly `slots` flat slots.
    fillerStream(slots: number): Bytecode {
      const out: Bytecode = [];
      let remaining = slots;
      while (remaining > 0) {
        if (remaining >= PATCH_FLAT_SIZE && chance(DECOY_IN_FILLER_CHANCE)) {
          out.push(decoyPatch());
          remaining -= PATCH_FLAT_SIZE;
          continue;
        }
        const instr = filler(remaining);
        out.push(instr);
        remaining -= getInstructionSize(instr);
      }
      return out;
    },

    // Junk of exactly `count` entries, weighted towards decoy PATCHes.
    decoyRun(count: number): Bytecode {
      const out: Bytecode = [];
      for (let i = 0; i < count; i++) {
        out.push(chance(40) ? decoyPatch() : filler(4));
      }
      return out;
    },
  };
}

export function selfModifying(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  // Walk the bytecode looking for "defineLabel" pseudo-ops, which start basic
  // blocks. For each block we collect the body (instructions between the label
  // and the next label/jump terminator), carve it into 1-3 regions, move each
  // region to the end of the bytecode under a fresh "patch_LXX" label, and
  // replace it in-place with:
  //
  //   defineLabel ("originalLabel")               ← kept as-is (pseudo-op)
  //   <prefix instructions>                        ← body before the region (kept)
  //   PATCH  destPc  sliceStart  sliceEnd  key     ← 5 flat slots total
  //   Garbage Opcodes  × regionFlatSize            ← placeholder slots
  //   <suffix instructions>                        ← body after the region (kept)
  //
  // PATCH reads four inline operands via _operand():
  //   destPc     = originalLabel + emittedFlatSize + 5  (first placeholder slot)
  //   sliceStart = patchLabel          (flat PC of appended region)
  //   sliceEnd   = patchLabel + regionFlatSize
  //   key        = u32 seed for the region's keystream
  //
  // On first execution PATCH decrypts bytecode[sliceStart..sliceEnd) over the
  // placeholder region starting at destPc. Execution then falls through into
  // the freshly-patched region (and onward into the next PATCH, or the suffix).
  // Subsequent calls are idempotent.
  //
  // Chained regions work because a body is always cut at a jump/RETURN
  // terminator: region N can only fall through into PATCH N+1.
  //
  // Real regions are left in plaintext here and tagged with a PatchRegion;
  // encryptPatches encrypts them at the end of the pipeline, once every operand
  // has a concrete value.

  const { OP, JUMP_OPS } = compiler;

  const result: Bytecode = [];
  // Each entry is [regionMarker, ...regionInstrs] or a whole junk block; they
  // get shuffled together so real and junk regions share the same address space.
  const trailing: Bytecode[] = [];
  let patchCount = 0;
  let junkCount = 0;

  // Budget: allow this pass to add at most one extra copy (100%) of the input
  // bytecode size, or MIN_ADDED entries, whichever is larger. "Size" here is the
  // number of instruction entries, matching the reported `bytecodeSize`.
  //
  // A region is charged 2 + regionFlatSize: one PATCH entry, one defineLabel
  // marker, and its placeholders (the region entries themselves just move). The
  // placeholders are worth fewer entries than that — they're multi-slot junk —
  // so the charge is an over-estimate and the budget is never exceeded.
  const budget = Math.max(bc.length, MIN_ADDED);
  let charged = 0;

  // What the pass actually grows the bytecode by, for the MIN_ADDED floor.
  let entriesAdded = 0;

  // Decoys are charged separately so they can't starve the real patches. The
  // arena doesn't count against the inline cap — it isn't inline.
  const inlineDecoyBudget = Math.ceil((budget * DECOY_RATIO) / 2);
  let inlineDecoyAdded = 0;

  // Arena shells first — the decoy factory needs their labels and sizes before
  // anything (including their own contents) can point into them.
  const arena: JunkBlock[] = [];
  const createJunkBlock = (): JunkBlock => {
    const block: JunkBlock = {
      label: `junk_${junkCount++}`,
      slots: getRandomInt(ARENA_BLOCK_MIN_SLOTS, ARENA_BLOCK_MAX_SLOTS),
      instrs: [],
    };
    arena.push(block);
    return block;
  };
  for (let n = getRandomInt(ARENA_BLOCKS_MIN, ARENA_BLOCKS_MAX); n > 0; n--) {
    createJunkBlock();
  }

  const decoys = createDecoyFactory(compiler, arena);

  const emitJunkBlock = (block: JunkBlock) => {
    block.instrs = decoys.fillerStream(block.slots);
    entriesAdded += 1 + block.instrs.length;
    trailing.push([
      [null, { type: "defineLabel", label: block.label }] as Instruction,
      ...block.instrs,
    ]);
  };
  for (const block of arena) emitJunkBlock(block);

  // Nothing falls through these, so anything planted after one is dead code.
  // A defineLabel that follows resolves to its own post-insertion position, so
  // jumps still skip whatever we put in between.
  const isUnconditionalTerminator = (op: number | null) =>
    op !== null &&
    (op === OP.JUMP ||
      op === OP.RETURN ||
      op === OP.THROW ||
      op === OP.JUMP_REG);

  let i = 0;
  while (i < bc.length) {
    const instr = bc[i];
    const [op, operand] = instr;

    // Detect a defineLabel pseudo-op — start of a new basic block.
    if (
      op === null &&
      operand !== null &&
      typeof operand === "object" &&
      (operand as any).type === "defineLabel"
    ) {
      const originalLabel = (operand as any).label as string;
      result.push(instr); // keep the defineLabel marker
      i++;

      // Collect body: everything after the label until the next terminator.
      let j = i;
      while (j < bc.length) {
        const [nextOp] = bc[j];

        // Any other pseudo-op is a boundary too — it has no flat size, so it
        // can't be moved into a region.
        if (nextOp === null) break;

        // Jump instructions, RETURN all terminate the body.
        if (JUMP_OPS.has(nextOp) || nextOp === OP.RETURN) break;

        j++;
      }

      const body = bc.slice(i, j);
      const N = body.length;

      // Each region adds (2 + regionFlatSize) entries (see budget note above).
      // Stop patching once there isn't room for even the smallest one —
      // remaining blocks (and empty blocks) are emitted untouched.
      const remaining = budget - charged;
      if (N === 0 || remaining < 2 + 1) {
        for (const bodyInstr of body) {
          result.push(bodyInstr);
        }
        i = j;
        continue;
      }

      // ── Pick the region(s) ───────────────────────────────────────────────
      // prefix = body[0, regionStart)   (kept in place, executes normally)
      // chunks = the patched regions
      // suffix = body[regionEnd, N)     (kept in place)
      let prefix: Bytecode = [];
      let suffix: Bytecode = [];
      let chunks: Bytecode[];

      const bodyFlatSize = flatSize(body);
      let chunkCount = Math.min(N, getRandomInt(1, MAX_CHUNKS));
      while (chunkCount > 1 && 2 * chunkCount + bodyFlatSize > remaining) {
        chunkCount--;
      }

      if (2 * chunkCount + bodyFlatSize <= remaining) {
        // Whole body fits — patch all of it.
        chunks = splitChunks(body, chunkCount);
      } else {
        // Otherwise fall back to a single random-sized, random-offset region,
        // trimmed from the end until it fits the remaining budget.
        const regionStart = getRandomInt(0, N - 1);
        const regionLen = getRandomInt(1, N - regionStart);

        let region = body.slice(regionStart, regionStart + regionLen);
        while (region.length > 1 && 2 + flatSize(region) > remaining) {
          region = region.slice(0, -1);
        }
        if (2 + flatSize(region) > remaining) {
          // Even a single-instruction region doesn't fit — leave block untouched.
          for (const bodyInstr of body) {
            result.push(bodyInstr);
          }
          i = j;
          continue;
        }

        prefix = body.slice(0, regionStart);
        suffix = body.slice(regionStart + region.length);
        chunks = [region];
      }

      // ── Prefix instructions (kept as-is) ────────────────────────────────
      for (const prefixInstr of prefix) {
        result.push(prefixInstr);
      }

      // Flat slots emitted since originalLabel — where the next PATCH lands.
      let emittedFlatSize = flatSize(prefix);

      for (const region of chunks) {
        const regionFlatSize = flatSize(region);
        const patchLabel = `patch_${originalLabel}_${patchCount++}`;
        const key = getRandomInt(0, U32_MAX);

        // Same object goes in the instruction and the descriptor; resolveLabels
        // mutates it in place, so encryptPatches sees the resolved destPc.
        const destPcOperand = {
          type: "label",
          label: originalLabel,
          offset: emittedFlatSize + PATCH_FLAT_SIZE,
        };

        result.push([
          OP.PATCH as number,
          destPcOperand,
          { type: "label", label: patchLabel },
          { type: "label", label: patchLabel, offset: regionFlatSize },
          key,
        ] as unknown as Instruction);
        emittedFlatSize += PATCH_FLAT_SIZE;

        // Placeholders — overwritten by PATCH before they can execute, so this
        // is a free spot for decoy PATCHes.
        const placeholders = decoys.fillerStream(regionFlatSize);
        result.push(...placeholders);
        emittedFlatSize += regionFlatSize;

        trailing.push([
          [
            null,
            {
              type: "defineLabel",
              label: patchLabel,
              _patchRegion: {
                key,
                instrCount: region.length,
                flatSize: regionFlatSize,
                destPcOperand,
              } as PatchRegion,
            },
          ] as unknown as Instruction,
          ...region,
        ]);

        charged += 2 + regionFlatSize;
        entriesAdded += 2 + placeholders.length;
      }

      // ── Suffix instructions (kept as-is) ────────────────────────────────
      for (const suffixInstr of suffix) {
        result.push(suffixInstr);
      }

      i = j; // skip over the original body in the input array
      continue;
    }

    result.push(instr);
    i++;

    // Dead code after an unconditional terminator.
    if (
      inlineDecoyAdded < inlineDecoyBudget &&
      isUnconditionalTerminator(op) &&
      chance(DECOY_AFTER_TERMINATOR_CHANCE)
    ) {
      const run = decoys.decoyRun(getRandomInt(1, 2));
      result.push(...run);
      inlineDecoyAdded += run.length;
      entriesAdded += run.length;
    }
  }

  // Top up with more junk blocks until the floor is met.
  while (entriesAdded < MIN_ADDED) {
    emitJunkBlock(createJunkBlock());
  }

  // Shuffled so real regions and junk blocks share one indistinguishable
  // stretch of trailing bytecode.
  return { bytecode: [...result, ...shuffle(trailing).flat()] };
}
