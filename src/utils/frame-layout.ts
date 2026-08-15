import type { Options } from "../options.ts";
import { choice, getRandomInt, shuffle } from "./random-utils.ts";

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
//   SALT        the executing function's 32-bit identity word (see below)
//
// REG_BASE is stored rather than derived so register access never depends on
// the header layout; that is what lets the layout be randomized for free.
//
// SALT is the only slot nothing in the interpreter reads. It carries a random
// u32 drawn per function at compile time and pushed into the frame from the
// closure's descriptor, and it exists for the MBA layer: a frame-bound handler
// multiplies by a value derived from it and by the modular inverse of the value
// ITS OWN function is expected to have, so the handler is the identity in that
// frame and garbage in every other one.
//
// It replaces the register count, which used to play that role. Both bind a
// handler to a frame; the difference is the key space. A register count is a
// small integer an attacker can enumerate — or recover with an oracle, since it
// is a value the interpreter itself computes — while a salt is 2^32 wide, is
// never derived from anything observable, and is per FUNCTION rather than per
// frame SHAPE, so two functions that happen to use the same number of registers
// no longer share handlers' key material.
export const FRAME_SLOT_NAMES = [
  "PC",
  "CALLER",
  "RET_DST",
  "THIS",
  "CLOSURE",
  "HANDLERS",
  "FRAME_SIZE",
  "REG_BASE",
  "SALT",
] as const;

export interface FrameLayout {
  SLOTS: Record<string, number>;
  /**
   * Scramble constants for the decoy slots — see NOISE_KEYS below.  Always
   * populated, even when no decoy was provisioned, so the runtime's `@NOISE`
   * blocks always have something to reference before classObfuscation drops
   * them.
   */
  NOISE_KEYS: Record<string, number>;
  HEADER_SIZE: number;
  FRAME_START: number;
}

// Decoy header slots ("noisy registers")
// Nothing reads these — they exist so a frame dump has more than one moving
// part and no single slot that visibly walks the bytecode. Push kinds are
// written once per frame, dispatch kinds churn every instruction; the @NOISE
// blocks in runtime.ts hold what each one is.
//
// Only a random subset is provisioned per build. A decoy that wasn't picked is
// simply missing from SLOTS, so its runtime block reads `typeof undefined ===
// "number"` and classObfuscation / minify drop it.
export const NOISE_SLOT_PREFIX = "NOISE_";

const PUSH_NOISE_SLOT_NAMES = ["NOISE_END", "NOISE_PARAMS", "NOISE_ARGS"];
const DISPATCH_NOISE_SLOT_NAMES = [
  "NOISE_PC",
  "NOISE_COUNTER",
  "NOISE_MIRROR",
  "NOISE_ACC",
];

// Scramble constants for the decoy slots.
//
// The decoys used to hold their seeds verbatim — a frame end, a param count, a
// PC that walked 0, 1, 2 — which was legible on sight and, worse, legible in
// contrast: the SALT slot holds a value under the build's salt encoding, so a
// small plain integer sitting next to it identifies itself as the slot that is
// NOT encoded.  A decoy whose whole job is to be indistinguishable cannot be
// the one thing in the header that is distinguishable.
//
// Nothing reads these, so there is no inverse and no correctness burden: an odd
// multiplier and a xor are enough to put every decoy anywhere in the 32-bit
// range and keep it moving there.
function pickNoiseKeys(): Record<string, number> {
  const odd = () => (getRandomInt(1, 0x7fffffff) * 2 + 1) | 0;
  return {
    END: odd(),
    PARAMS: odd(),
    PC: odd(),
    MIRROR: odd(),
    ACC: odd(),
    // The counter walks by a full-width odd stride (a Weyl sequence) rather
    // than by one, so it never looks like an instruction count.
    STEP: odd(),
    COUNTER: getRandomInt(0, 0xffffffff) | 0,
    X: getRandomInt(1, 0x7fffffff) | 0,
  };
}

function pickNoiseSlots(): string[] {
  const picked = [
    ...shuffle([...PUSH_NOISE_SLOT_NAMES]).slice(0, getRandomInt(0, 2)),
    ...shuffle([...DISPATCH_NOISE_SLOT_NAMES]).slice(0, getRandomInt(0, 2)),
  ];
  // At least one, so a randomized build always carries some noise.
  if (picked.length === 0)
    picked.push(
      choice([...PUSH_NOISE_SLOT_NAMES, ...DISPATCH_NOISE_SLOT_NAMES]),
    );
  return picked;
}

// Builds the header layout baked into a single obfuscated output.
//
// With randomizeOpcodes the slot order is permuted, the header gains decoy and
// unused junk slots, and the first frame is pushed further into the array — so
// no two builds put a pc, a caller pointer or a register at the same relative
// offset, and the extra slots sit in a dump looking exactly like the real ones.
// Everything here is a build-time constant folded into the runtime by
// classObfuscation's inlineConstants, so none of it costs anything at runtime.
export function createFrameLayout(options: Options): FrameLayout {
  const randomize = !!options.randomizeOpcodes;
  const names = [...FRAME_SLOT_NAMES, ...(randomize ? pickNoiseSlots() : [])];

  const headerSize = names.length + (randomize ? getRandomInt(0, 4) : 0);

  const offsets = [...Array(headerSize).keys()];
  if (randomize) shuffle(offsets);

  const entries = names.map(
    (name, i) => [name, offsets[i]] as [string, number],
  );
  // Otherwise the decoys are always the trailing keys of the emitted object.
  if (randomize) shuffle(entries);

  return {
    SLOTS: Object.fromEntries(entries),
    NOISE_KEYS: pickNoiseKeys(),
    HEADER_SIZE: headerSize,
    FRAME_START: randomize ? getRandomInt(1, 16) : 1,
  };
}
