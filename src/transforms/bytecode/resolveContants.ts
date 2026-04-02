import type * as b from "../../types.ts";
import { Compiler, SOURCE_NODE_SYM } from "../../compiler.ts";
import { getRandomInt } from "../../utils/random-utils.ts";
import { U16_MAX } from "../../utils/op-utils.ts";

// Encrypt a string with a position-dependent XOR key (u16) then base64-encode.
//
// Each char code is XOR'd with ((key + i) & 0xFFFF), producing a u16 value.
// The u16 values are packed as little-endian byte pairs (matching decodeBytecode),
// then base64-encoded so the stored constant is always safe ASCII — no raw Unicode
// surrogates, control chars, or quote chars that would break JS string literals.
function concealString(s: string, key: number): string {
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i) ^ ((key + i) & 0xffff);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return Buffer.from(bytes).toString("base64");
}

// Resolve all {type:"constant", value} operands to a PAIR of integer operands:
//   [constPoolIndex, concealKey]
//
// constPoolIndex — index into the constants array (as before).
// concealKey     — XOR key used to conceal this constant.
//                  0 means no concealment (concealConstants is off, or the
//                  value type is not concealable: null, undefined, bool, float…).
//
// The constants array stores the CONCEALED value when key != 0.
// The runtime's _readConstant(idx, key) reverses the concealment on the fly.
//
// Both slots are u16; all existing operand serialization handles them identically.
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
    const operandAsObject =
      typeof operand === "object" && operand ? operand : {};
    const value = (operand as any).value;

    let idx = constantsMap.get(value);
    let key = 0;

    if (typeof idx !== "number") {
      idx = constants.length;
      constantsMap.set(value, idx);

      if (compiler.options.concealConstants && typeof value === "string") {
        // Strings: position-dependent XOR. Key must be >= 1.
        key = getRandomInt(1, U16_MAX);
        constants.push(concealString(value, key));
      } else if (
        compiler.options.concealConstants &&
        typeof value === "number" &&
        Number.isInteger(value)
      ) {
        // Integers: simple XOR. Result is still a valid JS integer.
        key = getRandomInt(1, U16_MAX);
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
      ...(operandAsObject as object),
      type: "number",
      resolvedValue: idx,
    };

    const keyOperand: any = {
      ...(operandAsObject as object),
      type: "number",
      resolvedValue: key,
    };

    // key is a plain u16 number — no wrapping needed.
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
      const newOperands: b.InstrOperand[] = [];
      for (const operand of operands) {
        if ((operand as any)?.type === "constant") {
          const [idxOperand, key] = intern(operand);

          const newOperand = (operand as any)?.key ? key : idxOperand;

          newOperands.push(newOperand);
          // newOperands.push(key); // plain number — serialized as a regular u16 slot
        } else {
          newOperands.push(operand);
        }
      }
      const newInstr = [op, ...newOperands] as b.Instruction;
      (newInstr as any)[SOURCE_NODE_SYM] = (instr as any)[SOURCE_NODE_SYM];
      resolved.push(newInstr);
    } else {
      resolved.push(instr);
    }
  }

  return { bytecode: resolved, constants };
}
