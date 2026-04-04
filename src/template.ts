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

import { Compiler } from "./compiler.ts";
import { DEFAULT_OPTIONS } from "./options.ts";
import type { Bytecode, Instruction } from "./types.ts";

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
    // ── 1. Interpolate ────────────────────────────────────────────────────
    const code = this._interpolate(variables);

    // ── 2. Create child compiler, inherit parent's OP table ───────────────
    // randomizeOpcodes is disabled — we copy the parent's already-randomized
    // mapping directly so all opcode numbers are identical.
    const child = new Compiler({ ...DEFAULT_OPTIONS, randomizeOpcodes: false });
    child.OP = { ...parentCompiler.OP };
    child.OP_NAME = { ...parentCompiler.OP_NAME };
    child.JUMP_OPS = new Set(parentCompiler.JUMP_OPS);

    child._makeLabel = parentCompiler._makeLabel.bind(parentCompiler);

    // Record how many descriptors the parent already has so we can find the
    // child's main (index = startIdx) and inner functions (startIdx+1 …).
    const startIdx = parentCompiler.fnDescriptors.length;
    child.fnDescriptors = parentCompiler.fnDescriptors; // share — inner functions auto-register

    // ── 3. Compile to raw IR (no passes) ──────────────────────────────────
    child.compile(code);

    // parentCompiler.fnDescriptors[startIdx]   → child's main (discard)
    // parentCompiler.fnDescriptors[startIdx+1…] → inner helper functions
    const innerDescs = parentCompiler.fnDescriptors.slice(startIdx + 1);

    // Build bytecode blocks for inner functions only.
    // child.bytecode was assembled by _compileMain from ALL fnDescriptors
    // starting at startIdx.  We rebuild it here from the inner descs only.
    const innerBytecode: Bytecode = [];
    for (const desc of innerDescs) {
      innerBytecode.push([
        null,
        { type: "defineLabel", label: desc.entryLabel },
      ] as Instruction);
      for (const instr of (desc as any).bytecode as Bytecode) {
        innerBytecode.push(instr);
      }
    }

    return { functions: innerDescs, bytecode: innerBytecode };
  }
}
