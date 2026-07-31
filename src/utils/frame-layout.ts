import type { Options } from "../options.ts";
import { getRandomInt, shuffle } from "./random-utils.ts";

// Frame layout
// The VM keeps every frame as one contiguous block inside the flat slot array
// (VM._regs):
//
//   [ header slots (HEADER_SIZE) | registers (regCount) ]
//
// The header replaces what used to be named properties on a Frame object
// (_pc / _base / _parent / _retDstReg / thisVal / closure / _handlerStack), so
// a runtime dump shows nothing but integers and values interleaved with the
// program's own data. FRAME_START is the first legal frame base — slot 0 is
// reserved as the run() result cell and doubles as the "no frame" sentinel
// (a CALLER of 0 means the frame returns to the host).
//
// Slot meanings:
//   PC          current program counter for this frame
//   CALLER      caller's frame base (0 = host boundary) — this is the call
//               stack; there is no array of frames to enumerate
//   RET_DST     (destination register << 1) | isConstructorCall
//   THIS        `this` value; for `new` it is also the newly created object
//   CLOSURE     the Closure this frame is executing
//   HANDLERS    exception-handler stack (lazily created)
//   FRAME_SIZE  HEADER_SIZE + regCount — the block's total length
//   REG_BASE    absolute index of r0
//
// REG_BASE is stored rather than derived so register access never depends on
// the header layout; that is what lets the layout be randomized for free.
export const FRAME_SLOT_NAMES = [
  "PC",
  "CALLER",
  "RET_DST",
  "THIS",
  "CLOSURE",
  "HANDLERS",
  "FRAME_SIZE",
  "REG_BASE",
] as const;

export interface FrameLayout {
  SLOTS: Record<string, number>;
  HEADER_SIZE: number;
  FRAME_START: number;
}

// Builds the header layout baked into a single obfuscated output.
//
// With randomizeOpcodes the slot order is permuted, the header is padded with
// unused junk slots, and the first frame is pushed further into the array — so
// no two builds put a pc, a caller pointer or a register at the same relative
// offset, and the padding slots sit in a dump looking exactly like the real
// ones. Everything here is a build-time constant folded into the runtime by
// classObfuscation's inlineConstants, so none of it costs anything at runtime.
export function createFrameLayout(options: Options): FrameLayout {
  const names = [...FRAME_SLOT_NAMES];
  const randomize = !!options.randomizeOpcodes;

  const headerSize = names.length + (randomize ? getRandomInt(0, 8) : 0);

  const offsets = [...Array(headerSize).keys()];
  if (randomize) shuffle(offsets);

  const SLOTS: Record<string, number> = {};
  for (let i = 0; i < names.length; i++) SLOTS[names[i]] = offsets[i];

  return {
    SLOTS,
    HEADER_SIZE: headerSize,
    FRAME_START: randomize ? getRandomInt(1, 16) : 1,
  };
}
