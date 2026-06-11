// Template
// Compiles a JS code snippet into raw IR bytecode that can be spliced into the
// parent compiler's bytecode stream at any point before resolveRegisters /
// resolveLabels run.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//
//   const tmpl = new Template(`
//     function {name}(x, y) {
//       return x + y;
//     }
//   `);
//
//   const bc = tmpl.compile({ name: "myHelper" }, parentCompiler);
//   result.push(...bc);
//
// ── How it works ──────────────────────────────────────────────────────────────
//
// 1. {name} placeholders are replaced with the caller-supplied string values.
// 2. A fresh child Compiler is created, inheriting the parent's OP table so
//    opcode numbers match exactly (including randomizeOpcodes mappings).
// 3. The child compiles the snippet to raw IR (no passes, no label/register
//    resolution).
// 4. Post-processing makes the child's bytecode compatible with the parent:
//
//    Labels      — every label string is renamed via parentCompiler._makeLabel()
//                  so names never collide with existing or future labels.
//
//    FnIds       — the child's main scope (fnDescriptors[0]) is mapped to
//                  targetFnId (default 0).  Any inner functions (closures
//                  declared inside the template) are appended to
//                  parentCompiler.fnDescriptors with fresh indices.
//
// 5. The main function's entry defineLabel is stripped from the output — it is
//    a synthetic wrapper added by _compileMain and is not part of the injected
//    code.  All other instructions (including the implicit RETURN at the end of
//    the main scope and any inner-function blocks) are returned as-is so the
//    caller can append them wherever appropriate.
//
// ── Limitations (MVP) ─────────────────────────────────────────────────────────
// • Variables are plain string/number interpolation only — no AST-node
//   substitution.
// • Templates that reference upvalue-captured registers from the call site are
//   not supported (inner functions closing over template-local variables work).
// • Opcodes with no JS equivalent (JUMP_REG, BXOR used as decode, etc.) cannot
//   be expressed in a template; write those instruction arrays manually.

import { Compiler, SOURCE_NODE_SYM } from "./compiler.ts";
import { DEFAULT_OPTIONS } from "./options.ts";
import type { Bytecode, Instruction, RegisterOperand } from "./types.ts";

export class Template {
  private readonly _source: string;

  constructor(source: string) {
    this._source = source;
  }

  // ── String interpolation ──────────────────────────────────────────────────
  private _interpolate(variables: Record<string, string | number>): string {
    return this._source.replace(/\{(\w+)\}/g, (match, name) => {
      if (!(name in variables)) {
        throw new Error(`Template: missing variable {${name}}`);
      }
      return String(variables[name]);
    });
  }

  // ── Shared child-compiler setup ───────────────────────────────────────────
  // Creates a child Compiler that inherits the parent's OP table and label
  // counter, shares fnDescriptors (so inner functions auto-register), then
  // compiles `code` to raw IR.  Returns startIdx so callers can slice out
  // the descriptors that belong to this template invocation.
  private _setupChild(
    code: string,
    parentCompiler: Compiler,
  ): { startIdx: number } {
    const child = new Compiler({ ...DEFAULT_OPTIONS, randomizeOpcodes: false });
    child.OP = { ...parentCompiler.OP };
    child.OP_NAME = { ...parentCompiler.OP_NAME };
    child.JUMP_OPS = new Set(parentCompiler.JUMP_OPS);
    child.SENTINELS = { ...parentCompiler.SENTINELS };
    child._makeLabel = parentCompiler._makeLabel.bind(parentCompiler);

    const startIdx = parentCompiler.fnDescriptors.length;
    child.fnDescriptors = parentCompiler.fnDescriptors;

    child.compile(code);

    return { startIdx };
  }

  // ── Inner-function bytecode collection ───────────────────────────────────
  // Gathers the descriptors for functions declared inside the template (all
  // entries after startIdx in fnDescriptors), assembles their defineLabel +
  // body into a flat bytecode array, and strips template source locations so
  // they never leak into the parent's debug output.
  private _collectInnerFunctions(
    parentCompiler: Compiler,
    startIdx: number,
  ): { innerFns: any[]; innerBytecode: Bytecode } {
    const innerFns = parentCompiler.fnDescriptors.slice(startIdx + 1);

    const innerBytecode: Bytecode = [];
    for (const desc of innerFns) {
      innerBytecode.push([
        null,
        { type: "defineLabel", label: desc.entryLabel },
      ] as Instruction);
      for (const instr of (desc as any).bytecode as Bytecode) {
        innerBytecode.push(instr);
      }
    }

    this._stripSourceNodes(innerBytecode);
    return { innerFns, innerBytecode };
  }

  // ── Source-location stripping ─────────────────────────────────────────────
  // Removes the SOURCE_NODE_SYM symbol from every instruction so that template-
  // internal line numbers (which point into the template string, not the user's
  // source) never appear in the bytecode comment block.
  private _stripSourceNodes(bytecode: Bytecode): void {
    for (const instr of bytecode) delete (instr as any)[SOURCE_NODE_SYM];
  }

  // ── Main entry point ───────────────────────────────────────────────────────
  /**
   * Compile the template and return the inner (non-main) function descriptors
   * and their bytecode blocks, ready to splice into the parent compiler's
   * instruction stream.
   *
   * The template source should declare one or more named functions.  The
   * top-level ("main") scope of the template is discarded — it exists only as
   * a syntactic wrapper so that function declarations parse correctly.
   *
   * Each inner function is registered in parentCompiler.fnDescriptors with a
   * fresh fnIdx, and its bytecode block (defineLabel + body instructions) is
   * returned so the caller can append it to the parent bytecode stream at the
   * desired location (typically at the end, after all function bodies).
   *
   * @param variables       Substitution map for {name} placeholders.
   * @param parentCompiler  The Compiler whose OP table, label counter, and
   *                        fnDescriptors are shared.
   *
   * @returns
   *   functions  — ordered list of inner FnDescriptors (index 0 = first named
   *                function in the template source).  Use .entryLabel and
   *                ._fnIdx to build MAKE_CLOSURE operands.
   *   bytecode   — IR bytecode blocks for all inner functions, ready to splice
   *                after the parent's function bodies.  Does NOT include the
   *                template's main-scope instructions.
   */
  compile(
    variables: Record<string, string | number>,
    parentCompiler: Compiler,
  ): { functions: any[]; bytecode: Bytecode } {
    const code = this._interpolate(variables);
    const { startIdx } = this._setupChild(code, parentCompiler);
    const { innerFns, innerBytecode } = this._collectInnerFunctions(
      parentCompiler,
      startIdx,
    );
    return { functions: innerFns, bytecode: innerBytecode };
  }

  // ── Inline compilation ───────────────────────────────────────────────────
  /**
   * Compile the template and return the **main scope** bytecode, with all
   * register operands remapped to belong to `targetFnId`.  This allows
   * bytecode transforms to express high-level JS control flow (while-loops,
   * if-chains, variable declarations) via Template and splice the result
   * directly into an existing function's instruction stream.
   *
   * The implicit trailing RETURN added by _compileFunctionDecl is stripped —
   * inline code should flow into the surrounding bytecode, not return.
   *
   * @param variables       Substitution map for {name} placeholders.
   * @param parentCompiler  The Compiler whose OP table, label counter, and
   *                        fnDescriptors are shared.
   * @param targetFnId      The function whose register file the template's
   *                        registers should be remapped into.
   * @param maxId           Live map of max register id per fnId — updated
   *                        in-place as new registers are allocated.
   *
   * @returns
   *   bytecode   — main-scope IR (no entry defineLabel, no trailing RETURN),
   *                ready to splice into the target function's instruction stream.
   *   registers  — mapping of JS variable names → remapped RegisterOperands,
   *                so the caller can reference template-declared variables
   *                (e.g. the `state` variable in CFF).
   *   functions  — inner function descriptors (same as compile()).
   *   innerBytecode — inner function bytecode blocks (same as compile()).
   */
  compileInline(
    variables: Record<string, string | number>,
    parentCompiler: Compiler,
    targetFnId: number,
    maxId: Map<number, number>,
  ): {
    bytecode: Bytecode;
    registers: Map<string, RegisterOperand>;
    functions: any[];
    innerBytecode: Bytecode;
  } {
    const code = this._interpolate(variables);
    const { startIdx } = this._setupChild(code, parentCompiler);

    const mainDesc = parentCompiler.fnDescriptors[startIdx] as any;
    const mainFnId: number = mainDesc._fnIdx;
    const mainBc = mainDesc.bytecode as Bytecode;

    // ── Remap registers from the template's main fnId → targetFnId ────────
    // Build a mapping: old register id → new RegisterOperand in targetFnId.
    const regRemap = new Map<number, RegisterOperand>();
    const remapReg = (id: number): RegisterOperand => {
      if (!regRemap.has(id)) {
        const next = (maxId.get(targetFnId) ?? -1) + 1;
        maxId.set(targetFnId, next);
        regRemap.set(id, { type: "register", id: next, fnId: targetFnId });
      }
      return regRemap.get(id)!;
    };

    for (const instr of mainBc) {
      for (let j = 1; j < instr.length; j++) {
        const op = instr[j] as any;
        if (op && typeof op === "object" && op.type === "register" && op.fnId === mainFnId) {
          const mapped = remapReg(op.id);
          op.id = mapped.id;
          op.fnId = mapped.fnId;
        }
      }
    }

    // ── Build variable name → remapped register mapping ───────────────────
    const registers = new Map<string, RegisterOperand>();
    const locals: Map<string, RegisterOperand> = mainDesc.ctx.scope._locals;
    for (const [name, reg] of locals) {
      const mapped = regRemap.get(reg.id);
      if (mapped) registers.set(name, mapped);
    }

    // ── Strip entry defineLabel and trailing implicit RETURN ───────────────
    let bytecode = mainBc.filter((instr) => {
      const op0 = instr[1] as any;
      return !(
        instr[0] === null &&
        op0?.type === "defineLabel" &&
        op0.label === mainDesc.entryLabel
      );
    });

    // Remove trailing LOAD_CONST undefined + RETURN (implicit return added
    // by _compileFunctionDecl).
    const OP = parentCompiler.OP;
    if (
      bytecode.length >= 2 &&
      bytecode[bytecode.length - 1][0] === OP.RETURN &&
      bytecode[bytecode.length - 2][0] === OP.LOAD_CONST
    ) {
      bytecode = bytecode.slice(0, -2);
    }

    this._stripSourceNodes(bytecode);

    const { innerFns, innerBytecode } = this._collectInnerFunctions(
      parentCompiler,
      startIdx,
    );

    return { bytecode, registers, functions: innerFns, innerBytecode };
  }
}
