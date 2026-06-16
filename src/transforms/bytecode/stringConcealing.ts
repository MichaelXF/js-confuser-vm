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
// The bank is inflated EXACTLY ONCE, in the program's main scope, into a plain
// main-scope register (NOT a global — nothing is written to globalThis). That
// register is shared with the functions that need it through the VM's ordinary
// upvalue mechanism: an extra upvalue is threaded down the closure-creation tree
// to every string-using function and its ancestors. Each string-using function
// reads the already-inflated bank from that upvalue and passes it to a small
// per-function `decode` closure (decode itself is function-level — cheap):
//
//   main:               MAKE_CLOSURE rInflate
//                       LOAD_CONST   rB64, <base64 bank>
//                       CALL         rBankMain, rInflate, 1, rB64   (once)
//   string-using fn:    LOAD_UPVALUE rBank, <threaded idx>
//                       MAKE_CLOSURE rDecode
//   per site:           LOAD_INT     rKey/rStart/rLen
//                       CALL         rDst, rDecode, 4, rBank, rKey, rStart, rLen
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

interface BankEntry {
  key: number;
  start: number;
  length: number;
}

function buildBank(strings: Iterable<string>): {
  bank: string;
  table: Map<string, BankEntry>;
} {
  const parts: string[] = [];
  const table = new Map<string, BankEntry>();
  let pos = 0;

  const lead = decoyRun(getRandomInt(100, 250)); // leading decoys
  parts.push(lead);
  pos += lead.length;

  for (const str of strings) {
    const gap = decoyRun(getRandomInt(0, 5)); // 0‑5 decoys between strings
    parts.push(gap);
    pos += gap.length;

    const key = getRandomInt(1, U32_MAX);
    const encoded = xorEncode(str, key);
    table.set(str, { key, start: pos, length: str.length });
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
  // directUser  — functions that contain a string LOAD_CONST.
  // parentOf    — childFnId → creating (lexical parent) fnId.
  const strings = new Set<string>();
  const directUser = new Set<number>();
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
      strings.add((instr[2] as any).value as string);
      directUser.add(curFn);
    } else if (instr[0] === OP.MAKE_CLOSURE) {
      const childId = entryLabelToFnId.get((instr[2] as any)?.label);
      if (childId !== undefined) parentOf.set(childId, curFn);
    }
  }

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
  // last). main holds the bank as a local, so it has no threaded index.
  const bankUvIndex = new Map<number, number>();
  for (const f of needSet) {
    if (f === mainId) continue;
    bankUvIndex.set(f, compiler.fnDescriptors[f]?.upvalues?.length ?? 0);
  }

  const maxId = buildMaxIdMap(bc);
  const rBankMain = allocReg(mainId, maxId); // program-level inflated bank
  const { bank, table } = buildBank(strings);
  const bankB64 = bankToBase64(bank);

  // Helper closures, compiled once and shared by reference.
  //   inflate(b64)                  → reconstruct the u16 bank from base64
  //   decode(bank, key, start, len) → slice + keystream-decrypt one string
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
  `).compile({}, compiler);
  const [inflateDesc, decodeDesc] = helpers.functions;

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

    // Bank source for closures created in THIS frame: main captures its local,
    // every other frame inherits its own threaded upvalue.
    const childUpvalue: InstrOperandPair = isMain
      ? [1, ref(rBankMain)]
      : [0, bankUvIndex.get(fnId)!];

    const prologue: Bytecode = [];
    let rBank: RegisterOperand | null = null;
    let rDecode: RegisterOperand | null = null;
    let rKey: RegisterOperand, rStart: RegisterOperand, rLen: RegisterOperand;

    if (isMain) {
      const rInflate = allocReg(fnId, maxId);
      const rB64 = allocReg(fnId, maxId);
      prologue.push(mkClosure(rInflate, inflateDesc, 1));
      prologue.push([OP.LOAD_CONST!, ref(rB64), b.constantOperand(bankB64)]);
      prologue.push([OP.CALL!, ref(rBankMain), ref(rInflate), 1, ref(rB64)]);
      rBank = rBankMain;
    } else if (usesStrings) {
      rBank = allocReg(fnId, maxId);
      prologue.push([OP.LOAD_UPVALUE!, ref(rBank), bankUvIndex.get(fnId)!]);
    }

    if (usesStrings) {
      rDecode = allocReg(fnId, maxId);
      prologue.push(mkClosure(rDecode, decodeDesc, 4));
      rKey = allocReg(fnId, maxId);
      rStart = allocReg(fnId, maxId);
      rLen = allocReg(fnId, maxId);
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
        out.push([OP.LOAD_INT!, ref(rKey!), entry.key]);
        out.push([OP.LOAD_INT!, ref(rStart!), entry.start]);
        out.push([OP.LOAD_INT!, ref(rLen!), entry.length]);
        out.push([
          OP.CALL!,
          ref(dst),
          ref(rDecode!),
          4,
          ref(rBank!),
          ref(rKey!),
          ref(rStart!),
          ref(rLen!),
        ]);
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
