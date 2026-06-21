import type * as b from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { getRandomInt } from "../../utils/random-utils.ts";
import { U32_MAX } from "../../utils/op-utils.ts";

// Encrypt a string with a position-dependent, full-width u32 XOR key, then base64.
//
// The key is a full 32-bit seed (2^32 keyspace). A Weyl-sequence keystream
// (golden-ratio increment + xorshift fold) derives a fresh 16-bit keyword per
// character, so EVERY bit of the key affects the output and the keystream
// advances with position i — masking the key to 16 bits (the old `(key+i)&0xFFFF`
// scheme) would have thrown away the upper half and left only a 2^16 keyspace
// to brute-force. The 16-bit keyword XORs cleanly with each u16 char code; the
// results are packed as little-endian byte pairs (matching decodeBytecode) and
// base64-encoded so the stored constant is always safe ASCII — no raw Unicode
// surrogates, control chars, or quote chars that would break JS string literals.
//
// Mirrored exactly by runtime `_constant` and compiler `_decryptConst`.
function concealString(s: string, key: number): string {
  const bytes = new Uint8Array(s.length * 2);
  let k = key;
  for (let i = 0; i < s.length; i++) {
    k = (k + 0x9e3779b9) | 0; // 32-bit Weyl step (position-based)
    const ks = (k ^ (k >>> 13)) & 0xffff; // 16-bit keystream word from full 32-bit state
    const code = s.charCodeAt(i) ^ ks;
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

// Resolve all {type:"constant", value} (index) and {type:"constant", value, key: true} (key) operands
//
// constPoolIndex — index into the constants array (as before).
// concealKey     — XOR key used to conceal this constant.
//                  0 means no concealment (concealConstants is off, or the
//                  value type is not concealable: null, undefined, bool, float…).
//
// The constants array stores the CONCEALED value when key != 0.
// The runtime's _readConstant(idx, key) reverses the concealment on the fly.
//
// The index slot is a small u16-range pool index; the key slot is a full u32.
// Both ride the bytecode stream as plain operands, which is now u32-wide
// (serialized as 4 little-endian bytes, decoded via Uint32Array), so the
// existing operand serialization handles them identically.
export function resolveConstants(
  bc: b.Bytecode,
  compiler: Compiler,
): {
  bytecode: b.Bytecode;
  constants: any[];
} {
  const constants: any[] = [];
  const constantsMap = new Map<any, number>(); // original value → pool index
  const keyMap = new Map<number, number>(); // pool index → conceal key

  function intern(operand: b.InstrOperand): [b.InstrOperand, number] {
    const value = (operand as any).value;

    let idx = constantsMap.get(value);
    let key = 0;

    if (typeof idx !== "number") {
      idx = constants.length;
      constantsMap.set(value, idx);

      if (compiler.options.concealConstants && typeof value === "string") {
        // Strings: position-dependent full-width XOR (2^32 keyspace). Key >= 1.
        key = getRandomInt(1, U32_MAX);
        constants.push(concealString(value, key));
      } else if (
        compiler.options.concealConstants &&
        typeof value === "number" &&
        Number.isInteger(value)
      ) {
        // Integers: XOR with a full u32 key. JS `^` operates on int32, so the
        // stored value (often negative) and the runtime XOR-back are symmetric
        // for any int32-range integer, and all 32 key bits resist enumeration.
        key = getRandomInt(1, U32_MAX);
        constants.push(value ^ key);
      } else {
        // Not concealable (null, undefined, boolean, float, RegExp…) or option off.
        key = 0;
        constants.push(value);
      }

      keyMap.set(idx, key);
    } else {
      // Reuse existing pool entry — same key that was assigned on first intern.
      key = keyMap.get(idx)!;
    }

    const idxOperand: any = {
      type: "number",
      resolvedValue: idx,
    };

    const keyOperand: any = {
      type: "number",
      resolvedValue: key,
    };

    // key is a plain u32 number — no wrapping needed.
    return [idxOperand, keyOperand];
  }

  const resolved: b.Bytecode = [];
  for (const instr of bc) {
    const [op, ...operands] = instr;

    const hasConstant = operands.some(
      (o) =>
        o !== undefined &&
        o !== null &&
        typeof o === "object" &&
        (o as any).type === "constant",
    );

    if (hasConstant) {
      // 1-to-2 expansion: each {type:"constant"} becomes [constIdx, concealKey].
      const newOperands: b.InstrOperand[] = operands.map((operand) => {
        if ((operand as any)?.type === "constant") {
          const [idxOperand, key] = intern(operand);
          const newOperand = (operand as any)?.key ? key : idxOperand;

          return Object.assign(operand, newOperand);
        } else {
          return operand;
        }
      });

      const newInstr = [op, ...newOperands] as b.Instruction;
      (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
      resolved.push(newInstr);
    } else {
      resolved.push(instr);
    }
  }

  return { bytecode: resolved, constants };
}
