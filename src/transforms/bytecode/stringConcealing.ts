// String Concealing
//
// Replaces every string constant with a slice into a single shared "string
// bank" that is decoded at runtime with a position-dependent keystream cipher.
//
// ── Why a bank ───────────────────────────────────────────────────────────────
// Previously each string was its own encoded constant, so the encoded length
// leaked the plaintext length (an attacker could map by length + frequency).
// Here every string is concatenated into ONE opaque blob padded with random
// decoy bytes, so individual boundaries and lengths are no longer visible from
// static inspection of the constant pool.
//
//   bank = [100‑250 decoys] str0 [0‑5 decoys] str1 [0‑5 decoys] … [100‑250 decoys]
//
// Each original string is referenced by the triple (key, start, length).
//
// ── Cipher ───────────────────────────────────────────────────────────────────
// A Weyl-sequence keystream (golden-ratio increment + xorshift mix) produces a
// fresh 16-bit keyword per character, XOR'd against the char code:
//
//   key = (key + 0x9e3779b9) | 0          // 32-bit Weyl step
//   ks  = (key ^ (key >>> 13)) & 0xffff   // 16-bit keystream word
//   enc = charCode ^ ks                   // XOR (self-inverse)
//
// XOR over the full 16-bit range means EVERY UTF-16 code unit round-trips,
// including control characters, newlines and non-ASCII / astral text. The
// per-string key is a full 32-bit seed (2^32 keyspace) so the encoding is not
// trivially enumerable.
//
// ── Transport / storage ──────────────────────────────────────────────────────
// The encoded bank is full-range u16, which would serialise as a wall of CJK /
// control glyphs. Instead it is packed as u16-LE bytes and base64-encoded, so
// the stored constant is pure ASCII (and smaller on disk than the raw glyphs).
//
// ── Runtime shape — PROGRAM-LEVEL bank ───────────────────────────────────────
// The bank is inflated EXACTLY ONCE, in the program's main scope, and every
// string in it is decoded EXACTLY ONCE into a plain main-scope array (NOT a
// global — nothing is written to globalThis). That table register is shared
// with the functions that need it through the VM's ordinary upvalue mechanism:
// an extra upvalue is threaded down the closure-creation tree to every
// string-using function and its ancestors. A string-using function reads the
// table from that upvalue once in its prologue, and each site is then an
// ordinary indexed read:
//
//   main:               MAKE_CLOSURE rInflate
//                       LOAD_CONST   rB64, <base64 blob>
//                       CALL         rBank, rInflate, 1, rB64      (once)
//                       LOAD_INT     rMetaLen, <header length>
//                       MAKE_CLOSURE rDecode
//                       MAKE_CLOSURE rDecodeAll
//                       CALL         rTableMain, rDecodeAll, 3, …  (once)
//   string-using fn:    LOAD_UPVALUE rTable, <threaded idx>
//   per site:           LOAD_INT     rIdx, <table index>
//                       GET_PROP     rDst, rTable, rIdx
//
// Main's prologue is a fixed seven instructions no matter how many strings the
// program has, because the per-string loop lives inside `decodeAll`.
//
// ── Why the table, and not per-site decoding ─────────────────────────────────
// Decoding at the use site re-ran the whole thing on every dynamic execution of
// that instruction, and the strings the compiler emits implicitly are exactly
// the ones that sit in loops: `s.charAt(i)` compiles to a LOAD_CONST of the
// name "charAt", so a loop paid a full keystream pass plus a VM call per
// iteration. With `controlFlowFlattening` and `dispatcher` also enabled each of
// those calls was a flattened invocation with a dispatcher round-trip, which is
// where a measured 2,500x-over-native runtime came from.
//
// Memoizing the decoder was not enough, because the VM call itself dominates,
// not the keystream loop. Hoisting into each function's prologue was not enough
// either: it trades a loop's cost for one call per distinct string per
// invocation, which a frequently-called function pays back in full. Decoding
// once for the whole program is the only shape where a site costs O(1) opcodes
// and no call at all.
//
// The trade is that every string is in memory in plaintext from startup rather
// than on first use. That is a small change in exposure — the bank and the
// decoder both ship anyway, and any heap snapshot taken after warmup showed the
// used strings regardless — in exchange for making the option usable at all.
//
// Startup does more work than it used to, since strings a given run never
// reaches are decoded anyway. That cost is bounded by the total string length
// and is paid once, which is the right trade against paying per access forever.
//
// ── Pipeline position ─────────────────────────────────────────────────────────
// Runs BEFORE resolveRegisters and resolveLabels (same slot as Dispatcher/CFF),
// and FIRST among the bytecode passes so each FnDescriptor.upvalues count is
// still pristine (used to pick the threaded upvalue index).

import { Compiler } from "../../compiler.ts";
import { Template } from "../../template.ts";
import type { Bytecode, Instruction, RegisterOperand } from "../../types.ts";
import * as b from "../../types.ts";
import { ref, buildMaxIdMap, allocReg, forEachFunction } from "../../utils/pass-utils.ts";
import { getRandomInt } from "../../utils/random-utils.ts";
import { U32_MAX } from "../../utils/op-utils.ts";

// ── Cipher ────────────────────────────────────────────────────────────────────
// Encode mirrors the runtime decode EXACTLY (see the decode template). XOR is
// self-inverse. `key` must be the raw (unmasked) seed emitted as the LOAD_INT
// operand, so both sides begin the Weyl sequence from the same integer.
function xorEncode(str: string, key: number): string {
  let k = key;
  let out = "";
  for (let i = 0; i < str.length; i++) {
    k = (k + 0x9e3779b9) | 0;
    const ks = (k ^ (k >>> 13)) & 0xffff;
    out += String.fromCharCode(str.charCodeAt(i) ^ ks);
  }
  return out;
}

// Random decoy run, full 16-bit range so decoys look like encoded payload.
function decoyRun(count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += String.fromCharCode(getRandomInt(0, 0xffff));
  return out;
}

// Pack the u16 bank as little-endian bytes and base64-encode (ASCII, compact).
// Mirrored at runtime by the inflate template: byte[2i] = low, byte[2i+1] = high.
function bankToBase64(bank: string): string {
  const bytes = new Uint8Array(bank.length * 2);
  for (let i = 0; i < bank.length; i++) {
    const c = bank.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

// Units per metadata record in the blob header: key, start and length each as a
// high/low u16 pair. Six code units per string, in table-index order.
const META_UNITS = 6;

// Pack every entry's (key, start, length) into the u16 header that precedes the
// bank in the shipped blob. The runtime walks this header instead of having the
// compiler unroll one decode sequence per string into main's prologue: that
// unrolled form made startup quadratic under controlFlowFlattening, whose
// dispatch chain is a linear scan, so N extra prologue blocks cost O(N^2)
// comparisons before the program runs a single instruction of its own.
//
// The header shares one blob with the bank so that startup inflates a single
// base64 constant rather than two, which also keeps one fewer large literal in
// the output. `start` values are therefore absolute in the combined blob:
// buildBank is seeded with the header length, which is known up front from the
// string count.
//
// Splitting each field into two u16 halves keeps every unit inside the range
// `inflate` round-trips. The key is reassembled as a signed int32, which the
// keystream's `| 0` makes indistinguishable from the unsigned seed the encoder
// started from, since the two differ by exactly 2^32.
function packMeta(entries: Iterable<BankEntry>): string {
  let out = "";
  for (const entry of entries) {
    for (const field of [entry.key, entry.start, entry.length]) {
      out += String.fromCharCode((field >>> 16) & 0xffff, field & 0xffff);
    }
  }
  return out;
}

interface BankEntry {
  key: number;
  start: number;
  length: number;
  // Slot this string occupies in the decoded table main builds at startup.
  // Assigned in bank order, so it is unrelated to the order strings appear in
  // the program.
  index: number;
}

// `startOffset` is where the bank will sit inside the shipped blob, so every
// recorded `start` is already an absolute index into what the runtime inflates.
function buildBank(
  strings: Iterable<string>,
  startOffset: number,
): {
  bank: string;
  table: Map<string, BankEntry>;
} {
  const parts: string[] = [];
  const table = new Map<string, BankEntry>();
  let pos = startOffset;

  const lead = decoyRun(getRandomInt(100, 250)); // leading decoys
  parts.push(lead);
  pos += lead.length;

  for (const str of strings) {
    const gap = decoyRun(getRandomInt(0, 5)); // 0‑5 decoys between strings
    parts.push(gap);
    pos += gap.length;

    const key = getRandomInt(1, U32_MAX);
    const encoded = xorEncode(str, key);
    table.set(str, {
      key,
      start: pos,
      length: str.length,
      index: table.size,
    });
    parts.push(encoded);
    pos += encoded.length;
  }

  parts.push(decoyRun(getRandomInt(100, 250))); // trailing decoys
  return { bank: parts.join(""), table };
}

function isStringLoadConst(instr: any, OP: any): boolean {
  return (
    instr[0] === OP.LOAD_CONST &&
    instr.length === 3 &&
    (instr[2] as any)?.type === "constant" &&
    typeof (instr[2] as any).value === "string"
  );
}

// ── Pass entry point ──────────────────────────────────────────────────────────
export function stringConcealing(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  const OP = compiler.OP;
  const mainId = compiler.mainFn._fnIdx!;
  const entryLabelToFnId = new Map(
    compiler.fnDescriptors.map((d) => [d.entryLabel!, d._fnIdx!]),
  );
  const entryLabels = new Set(entryLabelToFnId.keys());

  // ── Prescan: collect strings + closure-creation graph ───────────────────────
  // stringsByFn — fnId → the distinct strings that function loads. Its keys are
  //               the functions that contain a string LOAD_CONST.
  // parentOf    — childFnId → creating (lexical parent) fnId.
  const strings = new Set<string>();
  const stringsByFn = new Map<number, Set<string>>();
  const parentOf = new Map<number, number>();

  let curFn = -1;
  for (const instr of bc) {
    if (
      instr[0] === null &&
      (instr[1] as any)?.type === "defineLabel" &&
      entryLabels.has((instr[1] as any).label)
    ) {
      curFn = entryLabelToFnId.get((instr[1] as any).label)!;
      continue;
    }
    if (curFn < 0) continue;
    if (isStringLoadConst(instr, OP)) {
      const value = (instr[2] as any).value as string;
      strings.add(value);
      let used = stringsByFn.get(curFn);
      if (!used) {
        used = new Set();
        stringsByFn.set(curFn, used);
      }
      used.add(value);
    } else if (instr[0] === OP.MAKE_CLOSURE) {
      const childId = entryLabelToFnId.get((instr[2] as any)?.label);
      if (childId !== undefined) parentOf.set(childId, curFn);
    }
  }

  const directUser = new Set(stringsByFn.keys());

  if (strings.size === 0) return { bytecode: bc };

  // ── needSet = string users ∪ all their ancestors (so the upvalue can be
  // threaded down to them). Walking each user to the root adds every ancestor. ──
  const needSet = new Set<number>();
  for (const u of directUser) {
    let p: number | undefined = u;
    while (p !== undefined && !needSet.has(p)) {
      needSet.add(p);
      p = parentOf.get(p);
    }
  }

  // Threaded upvalue index per function = its ORIGINAL upvalue count (appended
  // last). main holds the table as a local, so it has no threaded index.
  const tableUvIndex = new Map<number, number>();
  for (const f of needSet) {
    if (f === mainId) continue;
    tableUvIndex.set(f, compiler.fnDescriptors[f]?.upvalues?.length ?? 0);
  }

  const maxId = buildMaxIdMap(bc);
  const rTableMain = allocReg(mainId, maxId); // program-level decoded table
  const metaLength = META_UNITS * strings.size;
  const { bank, table } = buildBank(strings, metaLength);
  const blobB64 = bankToBase64(packMeta(table.values()) + bank);

  // Helper closures, compiled once and shared by reference.
  //   inflate(b64)   → reconstruct the u16 blob from base64
  //   decode(...)    → keystream-decrypt one string out of the blob
  //   decodeAll(...) → walk the header, decoding every string into a table
  const helpers = new Template(`
    function inflate(s) {
      var bytes = atob(s);
      var out = "";
      for (var i = 0; i < bytes["length"]; i += 2) {
        out += String["fromCharCode"](
          bytes["charCodeAt"](i) | (bytes["charCodeAt"](i + 1) << 8)
        );
      }
      return out;
    }
    function decode(bank, key, start, length) {
      var result = "";
      for (var i = 0; i < length; i++) {
        key = (key + 0x9e3779b9) | 0;
        var ks = (key ^ (key >>> 13)) & 0xffff;
        result += String["fromCharCode"](bank["charCodeAt"](start + i) ^ ks);
      }
      return result;
    }
    function decodeAll(bank, metaLength, decode) {
      var out = [];
      var slot = 0;
      for (var i = 0; i < metaLength; i += {units}) {
        out[slot] = decode(
          bank,
          (bank["charCodeAt"](i) << 16) | bank["charCodeAt"](i + 1),
          (bank["charCodeAt"](i + 2) << 16) | bank["charCodeAt"](i + 3),
          (bank["charCodeAt"](i + 4) << 16) | bank["charCodeAt"](i + 5)
        );
        slot++;
      }
      return out;
    }
  `).compile({ units: META_UNITS }, compiler);
  const [inflateDesc, decodeDesc, decodeAllDesc] = helpers.functions;

  const mkClosure = (dst: RegisterOperand, desc: any, params: number) =>
    [
      OP.MAKE_CLOSURE!,
      ref(dst),
      { type: "label", label: desc.entryLabel },
      params,
      b.fnRegCountOperand(desc._fnIdx),
      0, // upvalue count
      0, // hasRest
    ] as unknown as Instruction;

  const { bytecode } = forEachFunction(bc, compiler, (fnInstrs, fnId) => {
    if (!needSet.has(fnId)) return { instrs: fnInstrs };

    const isMain = fnId === mainId;
    const usesStrings = directUser.has(fnId);

    // Table source for closures created in THIS frame: main captures its local,
    // every other frame inherits its own threaded upvalue.
    const childUpvalue: InstrOperandPair = isMain
      ? [1, ref(rTableMain)]
      : [0, tableUvIndex.get(fnId)!];

    const prologue: Bytecode = [];
    // Register holding the decoded string table for this frame.
    let rTable: RegisterOperand | null = null;
    // Scratch index register, only needed by frames that actually read strings.
    let rIdx: RegisterOperand | null = null;

    if (isMain) {
      // Inflate the bank and the metadata blob, then decode every string in the
      // bank exactly once into the table. Only main does this; every other frame
      // inherits the result through the threaded upvalue. The emitted sequence
      // is a fixed seven instructions no matter how many strings the program
      // has, because the per-string loop lives inside `decodeAll`.
      const rInflate = allocReg(fnId, maxId);
      const rB64 = allocReg(fnId, maxId);
      const rBank = allocReg(fnId, maxId);
      const rMetaLen = allocReg(fnId, maxId);
      const rDecode = allocReg(fnId, maxId);
      const rDecodeAll = allocReg(fnId, maxId);

      prologue.push(mkClosure(rInflate, inflateDesc, 1));
      prologue.push([OP.LOAD_CONST!, ref(rB64), b.constantOperand(blobB64)]);
      prologue.push([OP.CALL!, ref(rBank), ref(rInflate), 1, ref(rB64)]);
      prologue.push([OP.LOAD_INT!, ref(rMetaLen), metaLength]);
      prologue.push(mkClosure(rDecode, decodeDesc, 4));
      prologue.push(mkClosure(rDecodeAll, decodeAllDesc, 3));
      prologue.push([
        OP.CALL!,
        ref(rTableMain),
        ref(rDecodeAll),
        3,
        ref(rBank),
        ref(rMetaLen),
        ref(rDecode),
      ]);

      rTable = rTableMain;
    } else if (usesStrings) {
      rTable = allocReg(fnId, maxId);
      prologue.push([OP.LOAD_UPVALUE!, ref(rTable), tableUvIndex.get(fnId)!]);
    }

    if (usesStrings) {
      rIdx = allocReg(fnId, maxId);
    }

    const out: Bytecode = [...prologue];

    for (const instr of fnInstrs) {
      // Thread the bank upvalue into every closure this frame creates that
      // needs it (string users + ancestors).
      if (instr[0] === OP.MAKE_CLOSURE) {
        const childId = entryLabelToFnId.get((instr[2] as any)?.label);
        if (childId !== undefined && needSet.has(childId)) {
          (instr as any)[5] = ((instr as any)[5] as number) + 1; // bump uvCount
          (instr as any).push(childUpvalue[0], childUpvalue[1]);
        }
        out.push(instr);
        continue;
      }

      if (usesStrings && isStringLoadConst(instr, OP)) {
        const dst = instr[1] as RegisterOperand;
        const entry = table.get((instr[2] as any).value as string)!;
        out.push([OP.LOAD_INT!, ref(rIdx!), entry.index]);
        out.push([OP.GET_PROP!, ref(dst), ref(rTable!), ref(rIdx!)]);
        continue;
      }

      out.push(instr);
    }

    return { instrs: out };
  });

  // Append the helper functions' bytecode (defines their entryLabels).
  bytecode.push(...helpers.bytecode);

  return { bytecode };
}

// [isLocal flag, upvalue source] — RegisterOperand when capturing a local,
// plain number when inheriting a parent upvalue.
type InstrOperandPair = [number, RegisterOperand | number];
