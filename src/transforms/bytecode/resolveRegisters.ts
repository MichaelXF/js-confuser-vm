// resolveRegisters
// Converts virtual RegisterOperand objects into concrete slot indices and sets
// each FnDescriptor's regCount.
//
// Two-tier slot assignment:
//
//   "local::" pool  (params, `arguments`, hoisted vars, upvalue-captured vars)
//   ─────────────────────────────────────────────────────────────────────────
//   Sorted by virtual-id, slots assigned sequentially with NO reuse.
//   This is required because:
//     • The runtime writes args[i] to regs[base + i] at call time, so params
//       MUST occupy slots 0..paramCount-1 in virtual-id order.
//     • Open upvalues hold an absolute slot index and read regs[base+slot] for
//       the lifetime of the outer frame — reusing a captured slot corrupts reads.
//
//   All other pools  (e.g. "temp::", "canary::", pass-introduced pools)
//   ─────────────────────────────────────────────────────────────────────────
//   Linear-scan with a free list: registers are sorted by firstUse, and any
//   slot whose previous occupant's lastUse < current register's firstUse is
//   recycled. An explicit [null, freeRegOperand(reg)] pseudo-instruction clamps
//   lastUse early, enabling reuse before the natural end of the live range.
//
//   Pools are processed in priority order: "local::" always first (slots
//   0..N), then remaining pools alphabetically. This keeps temp slots above
//   the reserved param/local region.
//
//   regCount = max concrete slot used across all pools + 1.
//
// Run AFTER all IR-level passes but BEFORE resolveLabels / resolveConstants.

import type { Bytecode } from "../../types.ts";
import { Compiler } from "../../compiler.ts";

export function resolveRegisters(
  bc: Bytecode,
  compiler: Compiler,
): { bytecode: Bytecode } {
  function registerPoolKey(op: {
    kind?: string;
    scopeId?: string | number;
  }): string {
    return `${op.kind ?? "local"}::${op.scopeId ?? ""}`;
  }

  // ── Pass 1: collect live ranges ───────────────────────────────────────────
  // For each (fnId, virtId) record the first and last instruction index where
  // the register appears as a real operand.  A freeReg marker clamps lastUse.
  type RegInfo = {
    firstUse: number;
    lastUse: number;
    poolKey: string;
    freed: boolean; // true once a freeReg has been seen; prevents further extension
  };
  // fnId -> virtId -> RegInfo
  const fnRegInfo = new Map<number, Map<number, RegInfo>>();

  for (let i = 0; i < bc.length; i++) {
    const instr = bc[i];
    for (let j = 1; j < instr.length; j++) {
      const op = instr[j] as any;
      if (!op || typeof op !== "object") continue;

      if (op.type === "register") {
        const { fnId, id } = op;
        const poolKey = registerPoolKey(op);
        let fnMap = fnRegInfo.get(fnId);
        if (!fnMap) {
          fnMap = new Map();
          fnRegInfo.set(fnId, fnMap);
        }
        const existing = fnMap.get(id);
        if (!existing) {
          fnMap.set(id, { firstUse: i, lastUse: i, poolKey, freed: false });
        } else if (!existing.freed) {
          // Only extend lastUse if no explicit freeReg has clamped it yet.
          existing.lastUse = i;
        }
      } else if (op.type === "freeReg") {
        // Explicit end-of-life marker: clamp lastUse and prevent extension.
        const { fnId, id } = op;
        const fnMap = fnRegInfo.get(fnId);
        if (fnMap) {
          const info = fnMap.get(id);
          if (info && !info.freed) {
            info.lastUse = i;
            info.freed = true;
          }
        }
      }
    }
  }

  // ── Pass 2: slot assignment per function ──────────────────────────────────
  // fnId -> virtId -> concrete slot
  const fnSlotMaps = new Map<number, Map<number, number>>();

  // Pool ordering: "local::" always first; all other keys sorted alphabetically.
  function poolSortKey(key: string): [number, string] {
    return key === "local::" ? [0, ""] : [1, key];
  }

  for (const [fnId, regMap] of fnRegInfo) {
    // Group by pool key.
    const pools = new Map<
      string,
      Array<{ id: number; firstUse: number; lastUse: number }>
    >();
    for (const [id, info] of regMap) {
      let pool = pools.get(info.poolKey);
      if (!pool) {
        pool = [];
        pools.set(info.poolKey, pool);
      }
      pool.push({ id, firstUse: info.firstUse, lastUse: info.lastUse });
    }

    const sortedPoolKeys = Array.from(pools.keys()).sort((a, b) => {
      const [pa, sa] = poolSortKey(a);
      const [pb, sb] = poolSortKey(b);
      if (pa !== pb) return pa - pb;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    const slotMap = new Map<number, number>(); // virtId -> slot
    fnSlotMaps.set(fnId, slotMap);

    // nextSlot is the high-water mark: the next fresh slot to allocate.
    // It is shared across all pools so each pool's slots start above the
    // previous pool's maximum slot.
    let nextSlot = 0;

    for (const poolKey of sortedPoolKeys) {
      const regs = pools.get(poolKey)!;

      if (poolKey === "local::") {
        // ── Local pool: virtual-id order, no reuse ────────────────────────
        // Params must be at the lowest slots (written by the runtime at call
        // time); upvalue captures must keep their slot for the frame's lifetime.
        regs.sort((a, b) => a.id - b.id);
        for (const reg of regs) {
          slotMap.set(reg.id, nextSlot++);
        }
      } else {
        // ── Non-local pool: firstUse order, linear-scan reuse ─────────────
        regs.sort((a, b) => a.firstUse - b.firstUse);

        // freeList entries: { slot, freeAt } where freeAt = lastUse of current
        // occupant.  A slot becomes available when freeAt < next reg's firstUse.
        const freeList: Array<{ slot: number; freeAt: number }> = [];

        for (const reg of regs) {
          // Find the lowest-numbered slot whose last occupant has ended.
          let bestSlot = -1;
          let bestIdx = -1;
          for (let k = 0; k < freeList.length; k++) {
            if (freeList[k].freeAt < reg.firstUse) {
              if (bestSlot === -1 || freeList[k].slot < bestSlot) {
                bestSlot = freeList[k].slot;
                bestIdx = k;
              }
            }
          }

          let assignedSlot: number;
          if (bestIdx !== -1) {
            assignedSlot = bestSlot;
            freeList.splice(bestIdx, 1);
          } else {
            assignedSlot = nextSlot++;
          }

          slotMap.set(reg.id, assignedSlot);
          freeList.push({ slot: assignedSlot, freeAt: reg.lastUse });
        }
        // nextSlot already reflects the high-water mark; reused slots are
        // always < nextSlot by construction.
      }
    }
  }

  // ── Pass 3: patch register operands ──────────────────────────────────────
  for (const instr of bc) {
    for (let i = 1; i < instr.length; i++) {
      const op = instr[i] as any;
      if (!op || typeof op !== "object") continue;
      if (op.type === "register") {
        op.resolvedValue = fnSlotMaps.get(op.fnId)?.get(op.id);
      }
    }
  }

  // ── Pass 4: set regCount on each FnDescriptor ─────────────────────────────
  // regCount = max concrete slot used + 1  (not sum of virtual-register counts).
  for (const desc of compiler.fnDescriptors) {
    const fnId = desc._fnIdx!;
    const slotMap = fnSlotMaps.get(fnId);
    let regCount = 0;
    if (slotMap) {
      for (const slot of slotMap.values()) {
        if (slot + 1 > regCount) regCount = slot + 1;
      }
    }
    desc.regCount = regCount;
  }

  compiler.mainRegCount = compiler.mainFn?.regCount ?? 0;

  // ── Pass 5: patch fnRegCount operands ────────────────────────────────────
  for (const instr of bc) {
    for (let i = 1; i < instr.length; i++) {
      const op = instr[i] as any;
      if (!op || typeof op !== "object") continue;
      if (op.type === "fnRegCount") {
        const desc = compiler.fnDescriptors[op.fnId];
        op.resolvedValue = desc?.regCount ?? 0;
      }
    }
  }

  return { bytecode: bc };
}
