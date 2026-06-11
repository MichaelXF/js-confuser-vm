import * as t from "@babel/types";
import * as b from "./types.ts";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { generate } from "@babel/generator";
import { join } from "path";
import { readFileSync } from "fs";
import { stripTypeScriptTypes } from "module";
import { ok } from "assert";
import { buildRuntime } from "./build-runtime.ts";
import { DEFAULT_OPTIONS, type Options } from "./options.ts";
import { resolveLabels } from "./transforms/bytecode/resolveLabels.ts";
import { resolveRegisters } from "./transforms/bytecode/resolveRegisters.ts";
import { resolveConstants } from "./transforms/bytecode/resolveConstants.ts";
import { selfModifying } from "./transforms/bytecode/selfModifying.ts";
import { macroOpcodes } from "./transforms/bytecode/macroOpcodes.ts";
import { specializedOpcodes } from "./transforms/bytecode/specializedOpcodes.ts";
import { aliasedOpcodes } from "./transforms/bytecode/aliasedOpcodes.ts";
import { getRandomInt } from "./utils/random-utils.ts";
import { U16_MAX, U32_MAX } from "./utils/op-utils.ts";
import { concealConstants } from "./transforms/bytecode/concealConstants.ts";
import { dispatcher } from "./transforms/bytecode/dispatcher.ts";
import { controlFlowFlattening } from "./transforms/bytecode/controlFlowFlattening.ts";
import { stringConcealing } from "./transforms/bytecode/stringConcealing.ts";
import { now } from "./utils/profile-utils.ts";
import { walkHoistScope } from "./utils/ast-utils.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

const readVMRuntimeFile = () => {
  // During "npm run build", babel-plugin-inline-runtime.cjs replaces this function with the raw, type-stripped contents
  let code = readFileSync(join(import.meta.dirname, "./runtime.ts"), "utf-8");
  return stripTypeScriptTypes?.(code) || code;
};

export const VM_RUNTIME = readVMRuntimeFile().split("@START")[1];
export const SOURCE_NODE_SYM = Symbol("SOURCE_NODE");

// Opcodes
// Register-based encoding.  Operand convention (x86 / CPython style):
//  destination register first, then source registers, then immediates.
//
//  dst      – register index that receives the result
//  src      – register index holding an input value
//  imm/Idx  – immediate integer (constant-pool index, upvalue index, argc …)
//
// Every arithmetic/comparison/unary instruction: [op, dst, src1, src2?]
// Every load:                                    [op, dst, ...]
// Every store:                                   [op, target, src]
// Calls:     CALL  [op, dst, callee, argc, arg0, arg1, …]
//           CALL_METHOD [op, dst, receiver, callee, argc, arg0, …]
export const OP_ORIGINAL = {
  // Loads
  LOAD_CONST: 0, // dst, constIdx      regs[dst] = constants[constIdx]
  LOAD_INT: 1, // dst, imm           regs[dst] = imm  (raw u16 literal)
  LOAD_GLOBAL: 2, // dst, nameIdx       regs[dst] = globals[constants[nameIdx]]
  LOAD_UPVALUE: 3, // dst, uvIdx         regs[dst] = upvalues[uvIdx].read()
  LOAD_THIS: 4, // dst                regs[dst] = frame.thisVal
  MOVE: 5, // dst, src           regs[dst] = regs[src]

  // Stores
  STORE_GLOBAL: 6, // nameIdx, src       globals[constants[nameIdx]] = regs[src]
  STORE_UPVALUE: 7, // uvIdx,   src       upvalues[uvIdx].write(regs[src])

  // Property access
  GET_PROP: 8, // dst, obj, key      regs[dst] = regs[obj][regs[key]]
  SET_PROP: 9, // obj, key, val      regs[obj][regs[key]] = regs[val]  (result stays in val reg)
  DELETE_PROP: 10, // dst, obj, key      regs[dst] = delete regs[obj][regs[key]]

  // Arithmetic / bitwise  (dst, src1, src2)
  ADD: 11,
  SUB: 12,
  MUL: 13,
  DIV: 14,
  MOD: 15,
  BAND: 16,
  BOR: 17,
  BXOR: 18,
  SHL: 19,
  SHR: 20,
  USHR: 21,

  // Comparison  (dst, src1, src2)
  LT: 22,
  GT: 23,
  LTE: 24,
  GTE: 25,
  EQ: 26,
  NEQ: 27,
  LOOSE_EQ: 28,
  LOOSE_NEQ: 29,
  IN: 30,
  INSTANCEOF: 31,

  // Unary  (dst, src)
  UNARY_NEG: 32,
  UNARY_POS: 33,
  UNARY_NOT: 34,
  UNARY_BITNOT: 35,
  TYPEOF: 36, // dst, src
  VOID: 37, // dst, src   – regs[dst] = undefined (src evaluated for side-effects)
  TYPEOF_SAFE: 38, // dst, nameConstIdx – safe typeof for potentially-undeclared globals

  // Control flow
  JUMP: 39, // target
  JUMP_IF_FALSE: 40, // src, target    if !regs[src] then pc = target
  JUMP_IF_TRUE: 41, // src, target    if  regs[src] then pc = target  (|| short-circuit)

  // Calls & constructors
  CALL: 42, // dst, callee, argc, [argRegs…]
  CALL_METHOD: 43, // dst, receiver, callee, argc, [argRegs…]
  NEW: 44, // dst, callee, argc, [argRegs…]
  RETURN: 45, // src
  THROW: 46, // src

  // Closures
  // dst, startPc, paramCount, regCount, uvCount, [isLocal, idx, …]
  MAKE_CLOSURE: 47,

  // Collections
  BUILD_ARRAY: 48, // dst, count,     [elemRegs…]
  BUILD_OBJECT: 49, // dst, pairCount, [keyReg, valReg, …]

  // Property definitions (getters / setters)
  DEFINE_GETTER: 50, // obj, key, fn
  DEFINE_SETTER: 51, // obj, key, fn

  // For-in iteration
  FOR_IN_SETUP: 52, // dst, src              dst = { _keys: enumKeys(src), i: 0 }
  FOR_IN_NEXT: 53, // dst, iter, exitTarget

  // Exception handling
  TRY_SETUP: 54, // handlerPc, exceptionReg
  TRY_END: 55,

  // Self-modifying bytecode
  PATCH: 56, // destPc, sliceStart, sliceEnd

  // Debug
  DEBUGGER: 57,

  // Indirect jump (register-addressed)
  // Used by Dispatcher pass. The target PC is read from a register
  // rather than encoded as a bytecode immediate, so static analysis cannot
  // determine the destination without tracking register values at runtime.
  JUMP_REG: 58, // src — frame._pc = regs[src]

  // Exception handling (finally)
  // Arms a finalizer for the current region.  Operands:
  //  finallyPc, contReg, payloadReg, throwPad
  // The finalizer runs on every exit path (normal, return, break/continue,
  // throw).  contReg holds the PC to resume at once the finalizer completes;
  // the finalizer ends with JUMP_REG contReg.  payloadReg carries the pending
  // value (return value or in-flight exception).  throwPad is the PC the
  // runtime resumes at when an exception is pending (re-raises after finally).
  FINALLY_SETUP: 59,
};

// Scope
// Maps variable names to virtual RegisterOperands.
// Locals are allocated at compile time via ctx._newReg(); zero name lookups at runtime.
// resolveRegisters() assigns concrete slot indices before serialization.
class Scope {
  parent: Scope | null;
  _locals: Map<string, b.RegisterOperand>;

  constructor(parent = null) {
    this.parent = parent;
    this._locals = new Map();
  }

  define(name: string, ctx: FnContext): b.RegisterOperand {
    if (!this._locals.has(name)) {
      this._locals.set(name, ctx._newReg());
    }
    return this._locals.get(name)!;
  }

  resolve(
    name: string,
  ): { kind: "local"; reg: b.RegisterOperand } | { kind: "global" } {
    if (this._locals.has(name)) {
      return { kind: "local", reg: this._locals.get(name)! };
    }
    if (this.parent) return this.parent.resolve(name);
    return { kind: "global" };
  }
}

// FnContext
// Compiler-side state for the function currently being compiled.
// Distinct from the runtime Frame — this is compile-time only.
//
// Virtual-register model (Lua/LLVM style):
//  Every allocReg() / _newReg() call returns a fresh RegisterOperand with a
//  unique (fnId, id) pair.  IDs are never reused — resolveRegisters() does
//  liveness-aware slot assignment and sets desc.regCount at the end of the
//  pipeline, just like resolveLabels() fills in jump targets.
class FnContext {
  // index: RegisterOperand if isLocal (register in parent frame), number if upvalue chain
  upvalues: {
    name: string;
    isLocal: number;
    index: number | b.RegisterOperand;
  }[];
  parentCtx: FnContext | null;
  scope: Scope;
  compiler: Compiler;
  bc: b.Instruction[];

  // Unique ID for this function — matches the index in compiler.fnDescriptors.
  _fnId: number;
  // Monotonically increasing counter; each call to _newReg() bumps it.
  _nextId: number = 0;

  constructor(
    compiler: Compiler,
    parentCtx: FnContext | null = null,
    fnId: number = 0,
  ) {
    this.compiler = compiler;
    this.parentCtx = parentCtx;
    this.scope = new Scope();
    this.bc = [];
    this.upvalues = [];
    this._fnId = fnId;
  }

  /** Create a new virtual register owned by this function. */
  _newReg(): b.RegisterOperand {
    return b.registerOperand(this._nextId++, this._fnId);
  }

  /**
   * Allocate a short-lived temporary register (pool "temp::").
   * resolveRegisters() will reuse its concrete slot once its live range ends.
   * Do NOT use for named locals or upvalue-captured variables — use _newReg()
   * via scope.define() for those, so they stay in the stable "local::" pool.
   */
  allocReg(): b.RegisterOperand {
    return b.registerOperand(this._nextId++, this._fnId, { kind: "temp" });
  }

  /**
   * Emit a freeReg pseudo-instruction to explicitly end a temporary's live range.
   *
   * NOTE: This is extraneous for any programmatically generated IR.
   * resolveRegisters() already computes lastUse as the last instruction index
   * where the register appears as a real operand — which is always the tightest
   * correct bound when you stop emitting a register after its last logical use.
   * freeReg is only needed in the rare case where a register has a late syntactic
   * appearance that does NOT represent its true logical death (e.g. a dummy read
   * emitted for side-effects long after the value is logically dead). No current
   * pass in this codebase uses it; it is kept as an extension point only.
   */
  freeReg(bc: b.Bytecode, reg: b.RegisterOperand): void {
    bc.push([null, b.freeRegOperand(reg)]);
  }

  /** No-op kept for call-site compatibility; liveness is handled by resolveRegisters. */
  resetTemps(): void {}

  addUpvalue(
    name: string,
    isLocal: number,
    index: number | b.RegisterOperand,
  ): number {
    const existing = this.upvalues.findIndex((u) => u.name === name);
    if (existing !== -1) return existing;
    const idx = this.upvalues.length;
    this.upvalues.push({ name, isLocal, index });
    return idx;
  }
}

interface FnDescriptor {
  name?: string;
  entryLabel?: string;
  startLabel?: string;
  bytecode?: b.Bytecode;
  paramCount?: number;
  regCount?: number;
  upvalues?: any[];
  _fnIdx?: number;

  hasRest?: boolean;

  /**
   * Only populated AFTER resolveLabels
   */
  startPc?: number;
  ctx?: FnContext;
}

// Compiler
export class Compiler {
  fnDescriptors: FnDescriptor[];
  bytecode: b.Bytecode;
  mainRegCount: number;
  mainFn: ReturnType<typeof this._compileFunctionDecl>;
  mainStartPc: number;

  _currentCtx: FnContext | null;
  _pendingLabel: string | null;
  _forInCount: number;
  _labelCount: number;
  _loopStack: {
    type: "loop" | "switch" | "block" | "try" | "finally";
    label: string | null;
    breakLabel: string;
    continueLabel: string;
    // Only set on "finally" entries: metadata used to route abrupt completions
    // (return/break/continue) through the finalizer before they take effect.
    finallyLabel?: string;
    contReg?: b.RegisterOperand;
    payloadReg?: b.RegisterOperand;
    pads?: { label: string; emit: () => void }[];
  }[];

  options: Options;
  serializer: Serializer;

  OP: Partial<typeof OP_ORIGINAL>;
  SENTINELS: { CALL_SPREAD: number };
  MACRO_OPS: Record<number, number[]>;
  SPECIALIZED_OPS: Record<
    number,
    {
      originalOp: number;
      operands: b.InstrOperand[];
    }
  >;
  ALIASED_OPS: Record<number, { originalOp: number; order: number[] }>;
  MICRO_OPS: Record<
    number,
    { originalOp: number; stmtIndex: number; irOperandCount: number }
  >;

  OP_NAME: Record<number, string>;
  JUMP_OPS: Set<number>;

  constants: any[];

  log(...messages: any[]) {
    if (this.options.verbose) {
      console.log(...messages);
    }
  }

  _cloneRegisterOperand<T extends b.InstrOperand>(operand: T): T {
    if (!operand || typeof operand !== "object") return operand;
    if ((operand as any).type !== "register") return operand;

    return JSON.parse(JSON.stringify(operand)) as T;
  }

  emit(bc: b.Bytecode, instr: b.Instruction, node: t.Node) {
    for (let i = 1; i < instr.length; i++) {
      instr[i] = this._cloneRegisterOperand(instr[i]);
    }
    bc.push(instr);
    instr[SOURCE_NODE_SYM] = node;
  }

  constructor(options: Options = DEFAULT_OPTIONS) {
    this.options = options;
    this.fnDescriptors = [];
    this.bytecode = [];
    this.mainStartPc = 0;
    this.mainRegCount = 0;
    this._currentCtx = null;
    this._loopStack = [];
    this._pendingLabel = null;
    this._forInCount = 0;
    this._labelCount = 0;

    this.serializer = new Serializer(this);
    this.MACRO_OPS = {};
    this.MICRO_OPS = {};
    this.SPECIALIZED_OPS = {};
    this.ALIASED_OPS = {};

    this.OP = { ...OP_ORIGINAL };

    if (this.options.randomizeOpcodes) {
      let usedNumbers = new Set<number>();
      for (const key in this.OP) {
        let val;
        do {
          val = getRandomInt(0, U16_MAX);
        } while (usedNumbers.has(val));
        usedNumbers.add(val);
        this.OP[key] = val;
      }
    }

    // SENTINELS: magic values placed in argc slots to signal special call modes.
    // Default to U16_MAX (safely above any valid arg count).
    // When randomizeOpcodes is on, pick a random value in [U16_MAX, U32_MAX] so
    // each obfuscated output looks different to a static analyser.
    this.SENTINELS = {
      CALL_SPREAD: this.options.randomizeOpcodes
        ? getRandomInt(U16_MAX, U32_MAX)
        : U16_MAX,
    };

    this.OP_NAME = Object.fromEntries(
      Object.entries(this.OP).map(([k, v]) => [v, k]),
    );

    this.JUMP_OPS = new Set([
      this.OP.JUMP,
      this.OP.JUMP_IF_FALSE,
      this.OP.JUMP_IF_TRUE,
      this.OP.FOR_IN_NEXT,
      this.OP.TRY_SETUP,
      this.OP.FINALLY_SETUP,
    ]);
  }

  _makeLabel(hint = ""): string {
    return `${hint || "L"}_${this._labelCount++}`;
  }

  _resolve(
    name: string,
    ctx: FnContext | null,
  ):
    | { kind: "local"; reg: b.RegisterOperand }
    | { kind: "upvalue"; index: number }
    | { kind: "global" } {
    if (!ctx) return { kind: "global" };

    if (ctx.scope._locals.has(name)) {
      return { kind: "local", reg: ctx.scope._locals.get(name)! };
    }

    if (!ctx.parentCtx) return { kind: "global" };

    const parentResult = this._resolve(name, ctx.parentCtx);
    if (parentResult.kind === "global") return { kind: "global" };

    const isLocal = parentResult.kind === "local";
    const index = isLocal ? parentResult.reg : parentResult.index;
    const uvIdx = ctx.addUpvalue(name, isLocal ? 1 : 0, index);
    return { kind: "upvalue", index: uvIdx };
  }

  // Pre-scan a statement list and reserve virtual registers for every var
  // declaration, function declaration, for-in iterator, and try-catch binding.
  // Must be called before any emit so that locals are allocated before temps.
  _hoistVars(stmts: t.Statement[], scope: Scope, ctx: FnContext): void {
    walkHoistScope(stmts, (stmt) => {
      switch (stmt.type) {
        case "VariableDeclaration":
          for (const decl of stmt.declarations) {
            if (decl.id.type === "Identifier") scope.define(decl.id.name, ctx);
          }
          break;

        case "FunctionDeclaration":
          if (stmt.id) scope.define(stmt.id.name, ctx);
          break;

        case "ForInStatement":
          // Reserve a hidden virtual register for the iterator object.
          (stmt as any)._iterSlot = ctx._newReg();
          break;

        case "TryStatement":
          if (stmt.handler) {
            if (stmt.handler.param?.type === "Identifier") {
              scope.define((stmt.handler.param as t.Identifier).name, ctx);
            } else {
              // No catch binding – reserve a dummy register for the exception value.
              (stmt as any)._exceptionSlot = ctx._newReg();
            }
          }
          if (stmt.finalizer) {
            // Two stable locals survive the finalizer: contReg (resume PC) and
            // payloadReg (pending return value / in-flight exception).
            (stmt as any)._finallyContReg = ctx._newReg();
            (stmt as any)._finallyPayloadReg = ctx._newReg();
          }
          break;
      }
    });
  }

  // Collect all FunctionDeclaration nodes reachable in the current function
  // scope (does not cross into nested function bodies).
  _collectHoistedFunctions(stmts: t.Statement[]): t.FunctionDeclaration[] {
    const result: t.FunctionDeclaration[] = [];
    walkHoistScope(stmts, (stmt) => {
      if (stmt.type === "FunctionDeclaration") result.push(stmt);
    });
    return result;
  }

  profileData?: Partial<b.ObfuscationResult["profileData"]> = {
    transforms: {},
  };

  // Entry point
  compile(source: string) {
    let startedAt = now();

    const ast = parse(source, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });

    this.profileData.parseTime = now() - startedAt;

    return this.compileAST(ast);
  }

  compileAST(ast: t.File) {
    let startedAt = now();

    this._compileMain(ast.program.body);

    this.profileData.compileTime = now() - startedAt;

    return this.bytecode;
  }

  // Function compilation
  _compileFunctionDecl(node: t.FunctionDeclaration | t.FunctionExpression) {
    ok(!node.generator, "Generator functions are not supported");
    ok(!node.async, "Async functions are not supported");

    var fnIdx = this.fnDescriptors.length;
    const entryLabel = this._makeLabel(`fn_${fnIdx}`);
    var desc: FnDescriptor = {};
    this.fnDescriptors.push(desc);

    const ctx = new FnContext(this, this._currentCtx, fnIdx);
    const savedCtx = this._currentCtx;
    this._currentCtx = ctx;

    const savedLoopStack = this._loopStack;
    this._loopStack = [];

    // 1. Define parameters as virtual registers (occupy the first IDs in order).
    let hasRest = false;
    for (const param of node.params) {
      if (param.type === "RestElement") {
        ok(
          param.argument.type === "Identifier",
          "Rest element must be a simple identifier",
        );
        hasRest = true;
        ctx.scope.define((param.argument as t.Identifier).name, ctx);
      } else {
        let identifier =
          param.type === "AssignmentPattern" ? param.left : param;
        ok(
          identifier.type === "Identifier",
          "Only simple identifiers allowed as parameters",
        );
        ctx.scope.define((identifier as t.Identifier).name, ctx);
      }
    }

    // 2. Reserve the `arguments` virtual register (immediately after params).
    ctx.scope.define("arguments", ctx);

    // 3. Hoist all var declarations so locals are allocated before any temps.
    this._hoistVars(node.body.body, ctx.scope, ctx);

    // 4. Hoist function declarations: compile and emit MAKE_CLOSURE at function
    // entry so they are available before any code in the body runs.
    const hoistedFnDecls = this._collectHoistedFunctions(node.body.body);
    for (const fnDecl of hoistedFnDecls) {
      const fnDesc = this._compileFunctionDecl(fnDecl);
      (fnDecl as any)._hoistedDesc = fnDesc;
      const closureReg = this._emitMakeClosure(fnDesc, fnDecl, ctx.bc);
      const slot = ctx.scope._locals.get(fnDecl.id!.name)!;
      if (closureReg !== slot) {
        this.emit(ctx.bc, [this.OP.MOVE, slot, closureReg], fnDecl);
      }
    }

    // 5. Emit default-value guards.
    for (const param of node.params) {
      if (param.type !== "AssignmentPattern") continue;

      const slot = ctx.scope._locals.get((param.left as t.Identifier).name)!;
      const skipLabel = this._makeLabel("param_skip");

      // if (param === undefined) param = <default>
      const reg_undef = ctx.allocReg();
      this.emit(
        ctx.bc,
        [this.OP.LOAD_CONST, reg_undef, b.constantOperand(undefined)],
        param,
      );
      const reg_cmp = ctx.allocReg();
      this.emit(ctx.bc, [this.OP.EQ, reg_cmp, slot, reg_undef], param);
      this.emit(
        ctx.bc,
        [this.OP.JUMP_IF_FALSE, reg_cmp, { type: "label", label: skipLabel }],
        param,
      );
      ctx.resetTemps();

      const srcReg = this._compileExpr(param.right, ctx.scope, ctx.bc);
      if (srcReg !== slot) {
        this.emit(ctx.bc, [this.OP.MOVE, slot, srcReg], param);
      }
      ctx.resetTemps();

      this.emit(
        ctx.bc,
        [null, { type: "defineLabel", label: skipLabel }],
        param,
      );
    }

    // 6. Compile body.
    for (const stmt of node.body.body) {
      this._compileStatement(stmt, ctx.scope, ctx.bc);
    }

    // Implicit return undefined at end of function.
    const reg_undef = ctx.allocReg();
    this.emit(
      ctx.bc,
      [this.OP.LOAD_CONST, reg_undef, b.constantOperand(undefined)],
      node,
    );
    this.emit(ctx.bc, [this.OP.RETURN, reg_undef], node);

    this._currentCtx = savedCtx;
    this._loopStack = savedLoopStack;

    (node as any)._fnIdx = fnIdx;

    desc.name = (node as any).id?.name || "<anonymous>";
    desc.entryLabel = entryLabel;
    desc.bytecode = ctx.bc as b.Bytecode;
    desc._fnIdx = fnIdx;
    desc.paramCount = node.params.length;
    desc.hasRest = hasRest;
    // regCount is NOT set here — resolveRegisters() fills it after liveness analysis.
    desc.upvalues = ctx.upvalues.slice();
    desc.ctx = ctx;

    return desc;
  }

  // Emit MAKE_CLOSURE with all metadata as inline operands.
  // Layout: dst, startPc, paramCount, regCount, uvCount, [isLocal, idx, …]
  // regCount is emitted as a fnRegCount IR operand; resolveRegisters() fills it.
  _emitMakeClosure(desc: any, node: t.Node, bc: b.Bytecode) {
    const ctx = this._currentCtx!;
    const dst = ctx.allocReg();
    const uvOperands: b.InstrOperand[] = [];
    for (const uv of desc.upvalues) {
      uvOperands.push(uv.isLocal ? 1 : 0);
      uvOperands.push(uv.index); // RegisterOperand if isLocal, number if upvalue chain
    }
    this.emit(
      bc,
      [
        this.OP.MAKE_CLOSURE,
        dst,
        { type: "label", label: desc.entryLabel },
        desc.paramCount,
        b.fnRegCountOperand(desc._fnIdx), // resolved by resolveRegisters()
        desc.upvalues.length,
        desc.hasRest ? 1 : 0, // 1 = last param is a rest element
        ...uvOperands,
      ] as b.Instruction,
      node,
    );
    return dst;
  }

  // Load a label's resolved PC into a register (resolveLabels fills the value).
  // Used to seed a finalizer's continuation register with a resume target.
  _emitLoadLabel(
    bc: b.Bytecode,
    reg: b.RegisterOperand,
    label: string,
    node: t.Node,
  ) {
    this.emit(bc, [this.OP.LOAD_INT, reg, { type: "label", label }], node);
  }

  // Abrupt-completion unwinding
  // Emits the bytecode that carries an abrupt completion (return / break /
  // continue) out through every enclosing handler on the loop stack:
  //  • a "try" (catch-only) region is disarmed with TRY_END and we keep going;
  //  • a "finally" region is *routed through* — control is sent to the
  //    finalizer first and the remainder of the unwind resumes from the
  //    finalizer's continuation pad (see _routeThroughFinally);
  //  • loop/switch/block frames are skipped until we reach the break/continue
  //    target, where we emit the final JUMP.
  // For a return with no enclosing finalizer this degenerates to the original
  // "TRY_END per crossed try, then RETURN" behavior.
  //
  // action:
  //  { kind: "return", valueReg }
  //  { kind: "break" | "continue", targetEntry }   (targetEntry is the loop-
  //    stack record to jump to; identified by object identity so it stays
  //    valid even when re-walked from a finalizer pad after the stack shrank)
  _emitUnwind(
    bc: b.Bytecode,
    node: t.Node,
    action:
      | { kind: "return"; valueReg: b.RegisterOperand }
      | { kind: "break" | "continue"; targetEntry: Compiler["_loopStack"][0] },
  ) {
    const stack = this._loopStack;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];

      if (action.kind !== "return" && entry === action.targetEntry) {
        const label =
          action.kind === "break" ? entry.breakLabel : entry.continueLabel;
        this.emit(bc, [this.OP.JUMP, { type: "label", label }], node);
        return;
      }

      if (entry.type === "finally") {
        this._routeThroughFinally(bc, node, entry, action);
        return; // the finalizer's pad continues the unwind
      }

      if (entry.type === "try") {
        this.emit(bc, [this.OP.TRY_END], node);
      }
      // loop / switch / block frames that aren't the target are just skipped.
    }

    if (action.kind === "return") {
      this.emit(bc, [this.OP.RETURN, action.valueReg], node);
    }
  }

  // Divert an abrupt completion into a finalizer.  Schedules a continuation pad
  // (emitted after the finalizer body) that re-issues the completion from the
  // enclosing context, then sets the resume target + pending value and jumps to
  // the finalizer.  TRY_END disarms the finalizer's runtime record so an
  // exception raised inside it doesn't loop back to itself.
  _routeThroughFinally(
    bc: b.Bytecode,
    node: t.Node,
    entry: Compiler["_loopStack"][0],
    action:
      | { kind: "return"; valueReg: b.RegisterOperand }
      | { kind: "break" | "continue"; targetEntry: Compiler["_loopStack"][0] },
  ) {
    const padLabel = this._makeLabel("finally_cont");

    let contAction: typeof action;
    if (action.kind === "return") {
      // Park the return value in the finalizer's payload register so it
      // survives the finalizer body; the pad resumes the return from there.
      if (action.valueReg !== entry.payloadReg!) {
        this.emit(bc, [this.OP.MOVE, entry.payloadReg!, action.valueReg], node);
      }
      contAction = { kind: "return", valueReg: entry.payloadReg! };
    } else {
      contAction = action;
    }

    entry.pads!.push({
      label: padLabel,
      emit: () => this._emitUnwind(bc, node, contAction),
    });

    this._emitLoadLabel(bc, entry.contReg!, padLabel, node);
    this.emit(bc, [this.OP.TRY_END], node); // disarm this finalizer's record
    this.emit(
      bc,
      [this.OP.JUMP, { type: "label", label: entry.finallyLabel! }],
      node,
    );
  }

  // Main (top-level)
  _compileMain(body: t.Statement[]) {
    const mainCtx = new FnContext(this, null);
    const savedCtx = this._currentCtx;
    this._currentCtx = mainCtx;

    var desc = this._compileFunctionDecl({
      type: "FunctionDeclaration",
      async: false,
      generator: false,
      params: [],
      id: t.identifier("main"),
      body: t.blockStatement([...body]),
    });

    for (const descriptor of this.fnDescriptors) {
      this.bytecode.push([
        null,
        { type: "defineLabel", label: descriptor.entryLabel },
      ]);
      for (const instr of descriptor.bytecode) {
        this.bytecode.push(instr);
      }
    }

    // mainRegCount is set by resolveRegisters() after the pipeline runs.
    this.mainFn = desc;
    this._currentCtx = savedCtx;
  }

  // Statements
  // Wrapper that resets temps after every statement so that short-lived
  // expression temps don't accumulate across statements.
  _compileStatement(node: t.Statement, scope: Scope | null, bc: b.Bytecode) {
    this._compileStatementImpl(node, scope, bc);
    this._currentCtx?.resetTemps();
  }

  _compileStatementImpl(
    node: t.Statement,
    scope: Scope | null,
    bc: b.Bytecode,
  ) {
    const ctx = this._currentCtx!;

    switch (node.type) {
      case "EmptyStatement":
        break;

      case "DebuggerStatement":
        this.emit(bc, [this.OP.DEBUGGER], node);
        break;

      case "BlockStatement":
        for (const stmt of node.body) {
          this._compileStatement(stmt, scope, bc);
        }
        break;

      case "FunctionDeclaration": {
        // Already hoisted and emitted at function entry — skip.
        if ((node as any)._hoistedDesc) break;
        const desc = this._compileFunctionDecl(node);
        const closureReg = this._emitMakeClosure(desc, node, bc);
        if (scope) {
          const slot = scope._locals.get(node.id!.name)!;
          if (closureReg !== slot) {
            this.emit(bc, [this.OP.MOVE, slot, closureReg], node);
          }
        } else {
          this.emit(
            bc,
            [
              this.OP.STORE_GLOBAL,
              b.constantOperand(node.id!.name),
              closureReg,
            ],
            node,
          );
        }
        break;
      }

      case "ThrowStatement": {
        const reg = this._compileExpr(node.argument, scope, bc);
        this.emit(bc, [this.OP.THROW, reg], node);
        break;
      }

      case "ReturnStatement": {
        let reg: b.RegisterOperand;
        if (node.argument) {
          reg = this._compileExpr(node.argument, scope, bc);
        } else {
          reg = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.LOAD_CONST, reg, b.constantOperand(undefined)],
            node,
          );
        }
        // Unwind through enclosing try/finally regions: disarm catch handlers
        // and route through any finalizer before the value is actually returned.
        this._emitUnwind(bc, node, { kind: "return", valueReg: reg });
        break;
      }

      case "ExpressionStatement":
        this._compileExpr(node.expression, scope, bc);
        // Result is discarded; resetTemps in the wrapper handles cleanup.
        break;

      case "VariableDeclaration": {
        for (const decl of node.declarations) {
          ok(
            decl.id.type === "Identifier",
            "Only simple identifiers can be declared",
          );
          const name = (decl.id as t.Identifier).name;

          if (scope) {
            const slot = scope._locals.get(name)!; // already defined by _hoistVars
            if (decl.init) {
              const srcReg = this._compileExpr(decl.init, scope, bc);
              if (srcReg !== slot) {
                this.emit(bc, [this.OP.MOVE, slot, srcReg], node);
              }
            } else {
              // No initializer: var x; → load undefined directly into the local's register.
              this.emit(
                bc,
                [this.OP.LOAD_CONST, slot, b.constantOperand(undefined)],
                node,
              );
            }
          } else {
            if (decl.init) {
              const srcReg = this._compileExpr(decl.init, scope, bc);
              this.emit(
                bc,
                [this.OP.STORE_GLOBAL, b.constantOperand(name), srcReg],
                node,
              );
            } else {
              const tmp = ctx.allocReg();
              this.emit(
                bc,
                [this.OP.LOAD_CONST, tmp, b.constantOperand(undefined)],
                node,
              );
              this.emit(
                bc,
                [this.OP.STORE_GLOBAL, b.constantOperand(name), tmp],
                node,
              );
            }
          }
        }
        break;
      }

      case "IfStatement": {
        const elseOrEndLabel = this._makeLabel("if_else");

        const testReg = this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [
            this.OP.JUMP_IF_FALSE,
            testReg,
            { type: "label", label: elseOrEndLabel },
          ],
          node,
        );

        const consequentBody =
          node.consequent.type === "BlockStatement"
            ? node.consequent.body
            : [node.consequent];
        for (const stmt of consequentBody) {
          this._compileStatement(stmt, scope, bc);
        }

        if (node.alternate) {
          const endLabel = this._makeLabel("if_end");
          this.emit(
            bc,
            [this.OP.JUMP, { type: "label", label: endLabel }],
            node,
          );
          this.emit(
            bc,
            [null, { type: "defineLabel", label: elseOrEndLabel }],
            node,
          );
          const altBody =
            node.alternate.type === "BlockStatement"
              ? node.alternate.body
              : [node.alternate];
          for (const stmt of altBody) {
            this._compileStatement(stmt, scope, bc);
          }
          this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        } else {
          this.emit(
            bc,
            [null, { type: "defineLabel", label: elseOrEndLabel }],
            node,
          );
        }
        break;
      }

      case "WhileStatement": {
        const _wLabel = this._pendingLabel;
        this._pendingLabel = null;

        const loopTopLabel = this._makeLabel("while_top");
        const exitLabel = this._makeLabel("while_exit");

        this._loopStack.push({
          type: "loop",
          label: _wLabel,
          breakLabel: exitLabel,
          continueLabel: loopTopLabel,
        });

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );

        const testReg = this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, testReg, { type: "label", label: exitLabel }],
          node,
        );

        const whileBody =
          node.body.type === "BlockStatement" ? node.body.body : [node.body];
        for (const stmt of whileBody) {
          this._compileStatement(stmt, scope, bc);
        }

        this.emit(
          bc,
          [this.OP.JUMP, { type: "label", label: loopTopLabel }],
          node,
        );
        this.emit(bc, [null, { type: "defineLabel", label: exitLabel }], node);

        this._loopStack.pop();
        break;
      }

      case "DoWhileStatement": {
        const _dwLabel = this._pendingLabel;
        this._pendingLabel = null;

        const loopTopLabel = this._makeLabel("dowhile_top");
        const continueLabel = this._makeLabel("dowhile_cont");
        const exitLabel = this._makeLabel("dowhile_exit");

        this._loopStack.push({
          type: "loop",
          label: _dwLabel,
          breakLabel: exitLabel,
          continueLabel: continueLabel,
        });

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );

        const doWhileBody =
          node.body.type === "BlockStatement" ? node.body.body : [node.body];
        for (const stmt of doWhileBody) {
          this._compileStatement(stmt, scope, bc);
        }

        this.emit(
          bc,
          [null, { type: "defineLabel", label: continueLabel }],
          node,
        );

        const testReg = this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, testReg, { type: "label", label: exitLabel }],
          node,
        );

        this.emit(
          bc,
          [this.OP.JUMP, { type: "label", label: loopTopLabel }],
          node,
        );

        this.emit(bc, [null, { type: "defineLabel", label: exitLabel }], node);
        this._loopStack.pop();
        break;
      }

      case "ForStatement": {
        const _fLabel = this._pendingLabel;
        this._pendingLabel = null;

        const loopTopLabel = this._makeLabel("for_top");
        const exitLabel = this._makeLabel("for_exit");
        const updateLabel = node.update
          ? this._makeLabel("for_update")
          : loopTopLabel;

        this._loopStack.push({
          type: "loop",
          label: _fLabel,
          breakLabel: exitLabel,
          continueLabel: updateLabel,
        });

        if (node.init) {
          if (node.init.type === "VariableDeclaration") {
            this._compileStatement(node.init, scope, bc);
          } else {
            this._compileExpr(node.init as t.Expression, scope, bc);
            // result discarded; resetTemps in next iteration
          }
        }

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );

        if (node.test) {
          const testReg = this._compileExpr(node.test, scope, bc);
          this.emit(
            bc,
            [
              this.OP.JUMP_IF_FALSE,
              testReg,
              { type: "label", label: exitLabel },
            ],
            node,
          );
        }

        const forBody =
          node.body.type === "BlockStatement" ? node.body.body : [node.body];
        for (const stmt of forBody) {
          this._compileStatement(stmt, scope, bc);
        }

        if (node.update) {
          this.emit(
            bc,
            [null, { type: "defineLabel", label: updateLabel }],
            node,
          );
          this._compileExpr(node.update, scope, bc);
          ctx.resetTemps(); // discard update expression result
        }

        this.emit(
          bc,
          [this.OP.JUMP, { type: "label", label: loopTopLabel }],
          node,
        );
        this.emit(bc, [null, { type: "defineLabel", label: exitLabel }], node);

        this._loopStack.pop();
        break;
      }

      case "BreakStatement": {
        let _bTargetIdx = -1;
        if (node.label) {
          const _bLabelName = node.label.name;
          for (let _bi = this._loopStack.length - 1; _bi >= 0; _bi--) {
            if (this._loopStack[_bi].label === _bLabelName) {
              _bTargetIdx = _bi;
              break;
            }
          }
          if (_bTargetIdx === -1)
            throw new Error(`Label '${node.label.name}' not found`);
        } else {
          for (let _bi = this._loopStack.length - 1; _bi >= 0; _bi--) {
            const _t = this._loopStack[_bi].type as any;
            if (_t !== "try" && _t !== "finally") {
              _bTargetIdx = _bi;
              break;
            }
          }
          if (_bTargetIdx === -1) throw new Error("break outside loop");
        }
        // Disarm catch handlers and route through finalizers on the way out.
        this._emitUnwind(bc, node, {
          kind: "break",
          targetEntry: this._loopStack[_bTargetIdx],
        });
        break;
      }

      case "ContinueStatement": {
        let _cTargetIdx = -1;
        if (node.label) {
          const _cLabelName = node.label.name;
          for (let _ci = this._loopStack.length - 1; _ci >= 0; _ci--) {
            if (
              this._loopStack[_ci].label === _cLabelName &&
              this._loopStack[_ci].type === "loop"
            ) {
              _cTargetIdx = _ci;
              break;
            }
          }
          if (_cTargetIdx === -1)
            throw new Error(
              `Label '${node.label.name}' not found for continue`,
            );
        } else {
          for (let _ci = this._loopStack.length - 1; _ci >= 0; _ci--) {
            if (this._loopStack[_ci].type === "loop") {
              _cTargetIdx = _ci;
              break;
            }
          }
          if (_cTargetIdx === -1) throw new Error("continue outside loop");
        }
        // Disarm catch handlers and route through finalizers on the way out.
        this._emitUnwind(bc, node, {
          kind: "continue",
          targetEntry: this._loopStack[_cTargetIdx],
        });
        break;
      }

      case "SwitchStatement": {
        const _swLabel = this._pendingLabel;
        this._pendingLabel = null;

        const switchBreakLabel = this._makeLabel("sw_break");

        this._loopStack.push({
          type: "switch",
          label: _swLabel,
          breakLabel: switchBreakLabel,
          continueLabel: switchBreakLabel,
        });

        // Compile discriminant into a register that lives for the whole switch.
        const discReg = this._compileExpr(node.discriminant, scope, bc);

        const cases = node.cases;
        const defaultIdx = cases.findIndex((c) => c.test === null);
        const caseLabels = cases.map((_, i) => this._makeLabel(`sw_case_${i}`));

        // Dispatch: for each non-default case, test and jump.
        for (let i = 0; i < cases.length; i++) {
          const cas = cases[i];
          if (cas.test === null) continue;

          const nextCheckLabel = this._makeLabel("sw_next");
          const caseValReg = this._compileExpr(cas.test, scope, bc);
          const cmpReg = ctx.allocReg();
          this.emit(bc, [this.OP.EQ, cmpReg, discReg, caseValReg], node);
          this.emit(
            bc,
            [
              this.OP.JUMP_IF_FALSE,
              cmpReg,
              { type: "label", label: nextCheckLabel },
            ],
            node,
          );

          this.emit(
            bc,
            [this.OP.JUMP, { type: "label", label: caseLabels[i] }],
            node,
          );
          this.emit(
            bc,
            [null, { type: "defineLabel", label: nextCheckLabel }],
            node,
          );
        }

        this.emit(
          bc,
          [
            this.OP.JUMP,
            {
              type: "label",
              label:
                defaultIdx !== -1 ? caseLabels[defaultIdx] : switchBreakLabel,
            },
          ],
          node,
        );

        for (let i = 0; i < cases.length; i++) {
          this.emit(
            bc,
            [null, { type: "defineLabel", label: caseLabels[i] }],
            node,
          );
          for (const stmt of cases[i].consequent) {
            this._compileStatement(stmt, scope, bc);
          }
        }

        // Break lands here – discriminant register is simply abandoned.
        this.emit(
          bc,
          [null, { type: "defineLabel", label: switchBreakLabel }],
          node,
        );

        this._loopStack.pop();
        break;
      }

      case "LabeledStatement": {
        const _lName = node.label.name;
        const _lBody = node.body;
        const _lIsLoop =
          _lBody.type === "ForStatement" ||
          _lBody.type === "WhileStatement" ||
          _lBody.type === "DoWhileStatement" ||
          _lBody.type === "ForInStatement";
        const _lIsSwitch = _lBody.type === "SwitchStatement";

        if (_lIsLoop || _lIsSwitch) {
          this._pendingLabel = _lName;
          this._compileStatement(_lBody, scope, bc);
          this._pendingLabel = null;
        } else {
          const blockBreakLabel = this._makeLabel("block_break");
          this._loopStack.push({
            type: "block",
            label: _lName,
            breakLabel: blockBreakLabel,
            continueLabel: blockBreakLabel,
          });
          this._compileStatement(_lBody, scope, bc);
          this._loopStack.pop();
          this.emit(
            bc,
            [null, { type: "defineLabel", label: blockBreakLabel }],
            node,
          );
        }
        break;
      }

      case "ForInStatement": {
        const _fiLabel = this._pendingLabel;
        this._pendingLabel = null;

        // Iterator register was reserved by _hoistVars.
        const iterSlot: b.RegisterOperand = (node as any)._iterSlot;

        // FOR_IN_SETUP dst, src
        const objReg = this._compileExpr(node.right, scope, bc);
        this.emit(bc, [this.OP.FOR_IN_SETUP, iterSlot, objReg], node);

        const loopTopLabel = this._makeLabel("forin_top");
        const exitLabel = this._makeLabel("forin_exit");

        this._loopStack.push({
          type: "loop",
          label: _fiLabel,
          breakLabel: exitLabel,
          continueLabel: loopTopLabel,
        });

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );

        // FOR_IN_NEXT keyDst, iter, exitTarget
        const keyReg = ctx.allocReg();
        this.emit(
          bc,
          [
            this.OP.FOR_IN_NEXT,
            keyReg,
            iterSlot,
            { type: "label", label: exitLabel },
          ],
          node,
        );

        // Assign the key to the loop variable.
        if (node.left.type === "VariableDeclaration") {
          const identifier = node.left.declarations[0].id;
          ok(
            identifier.type === "Identifier",
            "Only simple identifiers can be declared in for-in loops",
          );
          const name = (identifier as t.Identifier).name;
          if (scope) {
            const slot = scope._locals.get(name)!;
            if (keyReg !== slot)
              this.emit(bc, [this.OP.MOVE, slot, keyReg], node);
          } else {
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(name), keyReg],
              node,
            );
          }
        } else if (node.left.type === "Identifier") {
          const res = this._resolve(node.left.name, this._currentCtx);
          if (res.kind === "local") {
            if (keyReg !== res.reg)
              this.emit(bc, [this.OP.MOVE, res.reg, keyReg], node);
          } else if (res.kind === "upvalue") {
            this.emit(bc, [this.OP.STORE_UPVALUE, res.index, keyReg], node);
          } else {
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(node.left.name), keyReg],
              node,
            );
          }
        } else {
          const src = generate(node.left).code;
          throw new Error(
            `Unsupported for-in left-hand side: ${node.left.type}\n  -> ${src}`,
          );
        }

        const fiBody =
          node.body.type === "BlockStatement" ? node.body.body : [node.body];
        for (const stmt of fiBody) {
          this._compileStatement(stmt, scope, bc);
        }

        this.emit(
          bc,
          [this.OP.JUMP, { type: "label", label: loopTopLabel }],
          node,
        );
        this.emit(bc, [null, { type: "defineLabel", label: exitLabel }], node);

        this._loopStack.pop();
        break;
      }

      case "TryStatement": {
        if (!node.handler && !node.finalizer) {
          throw new Error("try without catch or finally is not supported");
        }

        // Emits the inner try[/catch] region.  When there is a finalizer this is
        // nested *inside* the finally region (CPython-style desugaring of
        // try/catch/finally into try { try/catch } finally), so each runtime
        // handler record is purely a catch or purely a finally — never both.
        const emitTryCatch = () => {
          if (!node.handler) {
            // try { … } finally { … } — no catch, just run the protected body.
            for (const stmt of node.block.body) {
              this._compileStatement(stmt, scope, bc);
            }
            return;
          }

          const catchLabel = this._makeLabel("catch");
          const afterCatchLabel = this._makeLabel("after_catch");

          // Determine where the caught exception is written.
          const exceptionReg =
            node.handler.param?.type === "Identifier"
              ? (scope?._locals.get(
                  (node.handler.param as t.Identifier).name,
                ) ?? ctx.allocReg()) // shouldn't normally reach here
              : (node as any)._exceptionSlot;

          this.emit(
            bc,
            [
              this.OP.TRY_SETUP,
              { type: "label", label: catchLabel },
              exceptionReg,
            ],
            node,
          );

          this._loopStack.push({
            type: "try",
            label: null,
            breakLabel: "",
            continueLabel: "",
          });

          for (const stmt of node.block.body) {
            this._compileStatement(stmt, scope, bc);
          }

          this._loopStack.pop();

          this.emit(bc, [this.OP.TRY_END], node);
          this.emit(
            bc,
            [this.OP.JUMP, { type: "label", label: afterCatchLabel }],
            node,
          );

          // Catch block: exceptionReg already holds the caught value.
          this.emit(
            bc,
            [null, { type: "defineLabel", label: catchLabel }],
            node,
          );

          // If no param binding, just ignore the exception (it's in the dummy slot).
          for (const stmt of node.handler.body.body) {
            this._compileStatement(stmt, scope, bc);
          }

          this.emit(
            bc,
            [null, { type: "defineLabel", label: afterCatchLabel }],
            node,
          );
        };

        if (!node.finalizer) {
          emitTryCatch();
          break;
        }

        // try [catch] finally
        const finallyLabel = this._makeLabel("finally");
        const afterFinallyLabel = this._makeLabel("after_finally");
        const throwPadLabel = this._makeLabel("finally_throw");
        const contReg: b.RegisterOperand = (node as any)._finallyContReg;
        const payloadReg: b.RegisterOperand = (node as any)._finallyPayloadReg;

        // Arm the finalizer for the whole protected region (try + catch).
        this.emit(
          bc,
          [
            this.OP.FINALLY_SETUP,
            { type: "label", label: finallyLabel },
            contReg,
            payloadReg,
            { type: "label", label: throwPadLabel },
          ],
          node,
        );

        const finallyEntry: Compiler["_loopStack"][0] = {
          type: "finally",
          label: null,
          breakLabel: "",
          continueLabel: "",
          finallyLabel,
          contReg,
          payloadReg,
          pads: [],
        };
        this._loopStack.push(finallyEntry);

        emitTryCatch();

        this._loopStack.pop(); // leaving the protected region

        // Normal completion: disarm the finalizer, set resume = after the whole
        // statement, then fall into the finalizer body.
        this.emit(bc, [this.OP.TRY_END], node);
        this._emitLoadLabel(bc, contReg, afterFinallyLabel, node);
        this.emit(
          bc,
          [this.OP.JUMP, { type: "label", label: finallyLabel }],
          node,
        );

        // Finalizer body (compiled once).  Runs with the enclosing context on
        // the loop stack, so an abrupt completion inside it routes outward
        // (overriding any pending completion — correct JS semantics).
        this.emit(
          bc,
          [null, { type: "defineLabel", label: finallyLabel }],
          node,
        );
        for (const stmt of node.finalizer.body) {
          this._compileStatement(stmt, scope, bc);
        }
        // END_FINALLY: resume at whatever the continuation register points to.
        this.emit(bc, [this.OP.JUMP_REG, contReg], node);

        // Throw pad: re-raise the in-flight exception after the finalizer.
        this.emit(
          bc,
          [null, { type: "defineLabel", label: throwPadLabel }],
          node,
        );
        this.emit(bc, [this.OP.THROW, payloadReg], node);

        // Continuation pads for return/break/continue that crossed this
        // finalizer (collected during body compilation, emitted now that the
        // enclosing loop-stack context is restored).
        for (const pad of finallyEntry.pads!) {
          this.emit(
            bc,
            [null, { type: "defineLabel", label: pad.label }],
            node,
          );
          pad.emit();
        }

        this.emit(
          bc,
          [null, { type: "defineLabel", label: afterFinallyLabel }],
          node,
        );
        break;
      }

      default: {
        const src = generate(node).code;
        throw new Error(`Unsupported statement: ${node.type}\n  -> ${src}`);
      }
    }
  }

  // Returns true if any element in an argument/element list is a SpreadElement.
  _hasSpread(
    args: (
      | t.Expression
      | t.SpreadElement
      | t.JSXNamespacedName
      | t.ArgumentPlaceholder
      | null
    )[],
  ): boolean {
    return args.some((a) => a != null && (a as any).type === "SpreadElement");
  }

  // Build a flat argument array at runtime when the call contains spread elements.
  // Returns a register holding an Array with all arguments flattened.
  // Strategy: build a prefix array from leading non-spread elements, then
  // repeatedly call Array.prototype.concat — spread elements are concat'd directly
  // (concat spreads array args one level), non-spread elements are wrapped in a
  // single-element array before concat so they aren't spread.
  _buildSpreadArgs(
    args: (
      | t.Expression
      | t.SpreadElement
      | t.JSXNamespacedName
      | t.ArgumentPlaceholder
      | null
    )[],
    scope: Scope | null,
    bc: b.Bytecode,
    node: t.Node,
  ): b.RegisterOperand {
    const ctx = this._currentCtx!;

    const firstSpreadIdx = args.findIndex(
      (a) => a != null && (a as any).type === "SpreadElement",
    );

    // Build initial array from non-spread prefix (may be empty).
    const prefix = args.slice(0, firstSpreadIdx);
    const prefixRegs = prefix.map((a) => {
      if (a === null) {
        const r = ctx.allocReg();
        this.emit(bc, [this.OP.LOAD_CONST, r, b.constantOperand(undefined)], node);
        return r;
      }
      return this._compileExpr(a as t.Expression, scope, bc);
    });
    let accReg = ctx.allocReg();
    this.emit(
      bc,
      [this.OP.BUILD_ARRAY, accReg, prefix.length, ...prefixRegs],
      node,
    );

    // Process each remaining arg via Array.prototype.concat.
    for (let i = firstSpreadIdx; i < args.length; i++) {
      const arg = args[i];

      const concatKeyReg = ctx.allocReg();
      this.emit(
        bc,
        [this.OP.LOAD_CONST, concatKeyReg, b.constantOperand("concat")],
        node,
      );
      const concatFnReg = ctx.allocReg();
      this.emit(bc, [this.OP.GET_PROP, concatFnReg, accReg, concatKeyReg], node);

      let argArrReg: b.RegisterOperand;
      if (arg === null) {
        // Array hole — treat as undefined wrapped in [undefined]
        const elemReg = ctx.allocReg();
        this.emit(bc, [this.OP.LOAD_CONST, elemReg, b.constantOperand(undefined)], node);
        argArrReg = ctx.allocReg();
        this.emit(bc, [this.OP.BUILD_ARRAY, argArrReg, 1, elemReg], node);
      } else if ((arg as any).type === "SpreadElement") {
        // Spread: concat the iterable directly (concat flattens one level).
        argArrReg = this._compileExpr(
          (arg as t.SpreadElement).argument,
          scope,
          bc,
        );
      } else {
        // Non-spread: wrap in [elem] so concat doesn't flatten the value.
        const elemReg = this._compileExpr(arg as t.Expression, scope, bc);
        argArrReg = ctx.allocReg();
        this.emit(bc, [this.OP.BUILD_ARRAY, argArrReg, 1, elemReg], node);
      }

      const newAccReg = ctx.allocReg();
      this.emit(
        bc,
        [this.OP.CALL_METHOD, newAccReg, accReg, concatFnReg, 1, argArrReg],
        node,
      );
      accReg = newAccReg;
    }

    return accReg;
  }

  // Expressions
  // Returns the virtual RegisterOperand that holds the result.
  // For local variables: returns their RegisterOperand directly (no instruction emitted).
  // For all others: allocates a fresh virtual register, emits the instruction(s),
  // and returns the allocated register.
  _compileExpr(
    node: t.Expression | t.Node,
    scope: Scope | null,
    bc: b.Bytecode,
  ): b.RegisterOperand {
    const ctx = this._currentCtx!;

    // Intrinsic for emitting raw bytecode, useful for emitting register address
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "_VM_"
    ) {
      const argJSONStrng = (node.arguments[0] as t.StringLiteral).value;
      console.log("Emitting raw bytecode from _VM_ call:", argJSONStrng);
      const arg = JSON.parse(argJSONStrng);
      console.log("Parsed bytecode:", arg);

      const dst = ctx.allocReg();

      let operand = arg[0];

      this.emit(bc, [this.OP.MOVE, dst, operand], node); // emit a breakpoint for easy inspection

      return dst;
    }

    // _VM_JUMP_("labelName") — emits JUMP with a label operand.
    // Used by bytecode transforms (e.g. CFF) via Template to express jumps
    // to labels that exist in the parent compiler's bytecode stream.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "_VM_JUMP_"
    ) {
      const label = (node.arguments[0] as t.StringLiteral).value;
      bc.push([this.OP.JUMP!, { type: "label", label }]);
      // Return a dummy register — caller (ExpressionStatement) discards it.
      return ctx.allocReg();
    }

    switch ((node as any).type) {
      case "NumericLiteral":
      case "StringLiteral":
      case "BooleanLiteral": {
        const dst = ctx.allocReg();
        this.emit(
          bc,
          [this.OP.LOAD_CONST, dst, b.constantOperand((node as any).value)],
          node,
        );
        return dst;
      }

      case "NullLiteral": {
        const dst = ctx.allocReg();
        this.emit(bc, [this.OP.LOAD_CONST, dst, b.constantOperand(null)], node);
        return dst;
      }

      case "Identifier": {
        const res = this._resolve(
          (node as t.Identifier).name,
          this._currentCtx,
        );
        if (res.kind === "local") return res.reg; // register IS the local
        if (res.kind === "upvalue") {
          const dst = ctx.allocReg();
          this.emit(bc, [this.OP.LOAD_UPVALUE, dst, res.index], node);
          return dst;
        }
        // global
        const dst = ctx.allocReg();
        this.emit(
          bc,
          [
            this.OP.LOAD_GLOBAL,
            dst,
            b.constantOperand((node as t.Identifier).name),
          ],
          node,
        );
        return dst;
      }

      case "ThisExpression": {
        const dst = ctx.allocReg();
        this.emit(bc, [this.OP.LOAD_THIS, dst], node);
        return dst;
      }

      case "NewExpression": {
        const n = node as t.NewExpression;
        ok(n.arguments.length < U16_MAX, `Too many arguments (max ${U16_MAX - 1})`);
        const calleeReg = this._compileExpr(n.callee, scope, bc);
        const dst = ctx.allocReg();
        if (this._hasSpread(n.arguments)) {
          const argsArrayReg = this._buildSpreadArgs(n.arguments, scope, bc, node);
          this.emit(bc, [this.OP.NEW, dst, calleeReg, this.SENTINELS.CALL_SPREAD, argsArrayReg], node);
        } else {
          const argRegs = n.arguments.map((a) =>
            this._compileExpr(a as t.Expression, scope, bc),
          );
          this.emit(bc, [this.OP.NEW, dst, calleeReg, n.arguments.length, ...argRegs], node);
        }
        return dst;
      }

      case "SequenceExpression": {
        const exprs = (node as t.SequenceExpression).expressions;
        for (let i = 0; i < exprs.length - 1; i++) {
          this._compileExpr(exprs[i], scope, bc); // result discarded; virtual reg is unused
        }
        return this._compileExpr(exprs[exprs.length - 1], scope, bc);
      }

      case "ConditionalExpression": {
        const n = node as t.ConditionalExpression;
        const elseLabel = this._makeLabel("ternary_else");
        const endLabel = this._makeLabel("ternary_end");

        const testReg = this._compileExpr(n.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, testReg, { type: "label", label: elseLabel }],
          node,
        );

        // reg_result is a stable virtual register both branches write into.
        const reg_result = ctx.allocReg();

        // Consequent branch.
        const consReg = this._compileExpr(n.consequent, scope, bc);
        if (consReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, consReg], node);
        this.emit(bc, [this.OP.JUMP, { type: "label", label: endLabel }], node);

        // Alternate branch — each allocReg() gets a unique virtual ID so no
        // slot collision is possible; no need to "re-occupy" reg_result.
        this.emit(bc, [null, { type: "defineLabel", label: elseLabel }], node);
        const altReg = this._compileExpr(n.alternate, scope, bc);
        if (altReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, altReg], node);

        this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        return reg_result;
      }

      case "LogicalExpression": {
        const n = node as t.LogicalExpression;
        const endLabel = this._makeLabel("logical_end");
        const isOr = n.operator === "||";
        if (!isOr && n.operator !== "&&")
          throw new Error(`Unsupported logical operator: ${n.operator}`);

        const lhsReg = this._compileExpr(n.left, scope, bc);
        const reg_result = ctx.allocReg();
        if (lhsReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, lhsReg], node);

        // For ||: if truthy keep LHS, jump past RHS.
        // For &&: if falsy keep LHS, jump past RHS.
        this.emit(
          bc,
          [
            isOr ? this.OP.JUMP_IF_TRUE : this.OP.JUMP_IF_FALSE,
            reg_result,
            { type: "label", label: endLabel },
          ],
          node,
        );

        // Compile RHS into reg_result.
        const rhsReg = this._compileExpr(n.right, scope, bc);
        if (rhsReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, rhsReg], node);

        this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        return reg_result;
      }

      case "TemplateLiteral": {
        const n = node as t.TemplateLiteral;
        // Fold: quasi[0] + expr[0] + quasi[1] + ... + quasi[last]
        let acc = ctx.allocReg();
        this.emit(
          bc,
          [
            this.OP.LOAD_CONST,
            acc,
            b.constantOperand(n.quasis[0].value.cooked ?? ""),
          ],
          node,
        );
        for (let i = 0; i < n.expressions.length; i++) {
          const exprReg = this._compileExpr(
            n.expressions[i] as t.Expression,
            scope,
            bc,
          );
          const t1 = ctx.allocReg();
          this.emit(bc, [this.OP.ADD, t1, acc, exprReg], node);
          acc = t1;
          const quasiReg = ctx.allocReg();
          this.emit(
            bc,
            [
              this.OP.LOAD_CONST,
              quasiReg,
              b.constantOperand(n.quasis[i + 1].value.cooked ?? ""),
            ],
            node,
          );
          const t2 = ctx.allocReg();
          this.emit(bc, [this.OP.ADD, t2, acc, quasiReg], node);
          acc = t2;
        }
        return acc;
      }

      case "BinaryExpression": {
        const n = node as t.BinaryExpression;
        const lhsReg = this._compileExpr(n.left as t.Expression, scope, bc);
        const rhsReg = this._compileExpr(n.right as t.Expression, scope, bc);
        const dst = ctx.allocReg();

        const op = (
          {
            "+": this.OP.ADD,
            "-": this.OP.SUB,
            "*": this.OP.MUL,
            "/": this.OP.DIV,
            "%": this.OP.MOD,
            "&": this.OP.BAND,
            "|": this.OP.BOR,
            "^": this.OP.BXOR,
            "<<": this.OP.SHL,
            ">>": this.OP.SHR,
            ">>>": this.OP.USHR,
            "<": this.OP.LT,
            ">": this.OP.GT,
            "===": this.OP.EQ,
            "==": this.OP.LOOSE_EQ,
            "<=": this.OP.LTE,
            ">=": this.OP.GTE,
            "!==": this.OP.NEQ,
            "!=": this.OP.LOOSE_NEQ,
            in: this.OP.IN,
            instanceof: this.OP.INSTANCEOF,
          } as Record<string, number | undefined>
        )[n.operator];

        if (op === undefined)
          throw new Error(`Unsupported operator: ${n.operator}`);

        this.emit(bc, [op, dst, lhsReg, rhsReg], node);
        return dst;
      }

      case "UpdateExpression": {
        const n = node as t.UpdateExpression;
        const bumpOp = n.operator === "++" ? this.OP.ADD : this.OP.SUB;

        // Shared: compute curReg +/- 1 into newReg, return [postfixResult, newReg]
        const applyBump = (
          curReg: b.RegisterOperand,
        ): [b.RegisterOperand, b.RegisterOperand] => {
          const postfixReg = n.prefix
            ? curReg // prefix: postfix copy unused; caller returns newReg instead
            : (() => {
                const r = ctx.allocReg();
                this.emit(bc, [this.OP.MOVE, r, curReg], node as t.Node);
                return r;
              })();
          const oneReg = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.LOAD_CONST, oneReg, b.constantOperand(1)],
            node as t.Node,
          );
          const newReg = ctx.allocReg();
          this.emit(bc, [bumpOp, newReg, curReg, oneReg], node as t.Node);
          return [postfixReg, newReg];
        };

        if (n.argument.type === "MemberExpression") {
          const mem = n.argument as t.MemberExpression;
          const objReg = this._compileExpr(mem.object, scope, bc);
          let keyReg: b.RegisterOperand;
          if (mem.computed) {
            keyReg = this._compileExpr(mem.property as t.Expression, scope, bc);
          } else {
            keyReg = ctx.allocReg();
            this.emit(
              bc,
              [
                this.OP.LOAD_CONST,
                keyReg,
                b.constantOperand((mem.property as t.Identifier).name),
              ],
              node as t.Node,
            );
          }
          const curReg = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.GET_PROP, curReg, objReg, keyReg],
            node as t.Node,
          );
          const [postfixReg, newReg] = applyBump(curReg);
          this.emit(
            bc,
            [this.OP.SET_PROP, objReg, keyReg, newReg],
            node as t.Node,
          );
          return n.prefix ? newReg : postfixReg;
        }

        ok(
          n.argument.type === "Identifier",
          "UpdateExpression requires identifier or member expression",
        );
        const name = (n.argument as t.Identifier).name;
        const res = this._resolve(name, this._currentCtx);

        let curReg: b.RegisterOperand;
        if (res.kind === "local") {
          curReg = res.reg;
        } else if (res.kind === "upvalue") {
          curReg = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.LOAD_UPVALUE, curReg, res.index],
            node as t.Node,
          );
        } else {
          curReg = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.LOAD_GLOBAL, curReg, b.constantOperand(name)],
            node as t.Node,
          );
        }

        const [postfixReg, newReg] = applyBump(curReg);

        if (res.kind === "local") {
          this.emit(bc, [this.OP.MOVE, res.reg, newReg], node as t.Node);
        } else if (res.kind === "upvalue") {
          this.emit(
            bc,
            [this.OP.STORE_UPVALUE, res.index, newReg],
            node as t.Node,
          );
        } else {
          this.emit(
            bc,
            [this.OP.STORE_GLOBAL, b.constantOperand(name), newReg],
            node as t.Node,
          );
        }

        return n.prefix ? newReg : postfixReg;
      }

      case "AssignmentExpression": {
        const n = node as t.AssignmentExpression;
        const compoundOp = (
          {
            "+=": this.OP.ADD,
            "-=": this.OP.SUB,
            "*=": this.OP.MUL,
            "/=": this.OP.DIV,
            "%=": this.OP.MOD,
            "&=": this.OP.BAND,
            "|=": this.OP.BOR,
            "^=": this.OP.BXOR,
            "<<=": this.OP.SHL,
            ">>=": this.OP.SHR,
            ">>>=": this.OP.USHR,
          } as Record<string, number | undefined>
        )[n.operator];
        const isCompound = compoundOp !== undefined;

        if (n.operator !== "=" && !isCompound)
          throw new Error(`Unsupported assignment operator: ${n.operator}`);

        // Member assignment: obj.x = val  or  arr[i] = val
        if (n.left.type === "MemberExpression") {
          const objReg = this._compileExpr(n.left.object, scope, bc);

          let keyReg: b.RegisterOperand;
          if (n.left.computed) {
            keyReg = this._compileExpr(
              n.left.property as t.Expression,
              scope,
              bc,
            );
          } else {
            keyReg = ctx.allocReg();
            this.emit(
              bc,
              [
                this.OP.LOAD_CONST,
                keyReg,
                b.constantOperand((n.left.property as t.Identifier).name),
              ],
              node,
            );
          }

          let valReg: b.RegisterOperand;
          if (isCompound) {
            const curReg = ctx.allocReg();
            this.emit(bc, [this.OP.GET_PROP, curReg, objReg, keyReg], node);
            const rhsReg = this._compileExpr(n.right, scope, bc);
            valReg = ctx.allocReg();
            this.emit(bc, [compoundOp!, valReg, curReg, rhsReg], node);
          } else {
            valReg = this._compileExpr(n.right, scope, bc);
          }

          this.emit(bc, [this.OP.SET_PROP, objReg, keyReg, valReg], node);
          return valReg;
        }

        // Plain identifier assignment.
        const res = this._resolve(
          (n.left as t.Identifier).name,
          this._currentCtx,
        );

        let rhsReg: b.RegisterOperand;
        if (isCompound) {
          // Load current value of the variable.
          let curReg: b.RegisterOperand;
          if (res.kind === "local") {
            curReg = res.reg;
          } else if (res.kind === "upvalue") {
            curReg = ctx.allocReg();
            this.emit(bc, [this.OP.LOAD_UPVALUE, curReg, res.index], node);
          } else {
            curReg = ctx.allocReg();
            this.emit(
              bc,
              [
                this.OP.LOAD_GLOBAL,
                curReg,
                b.constantOperand((n.left as t.Identifier).name),
              ],
              node,
            );
          }
          const rhs2 = this._compileExpr(n.right, scope, bc);
          rhsReg = ctx.allocReg();
          this.emit(bc, [compoundOp!, rhsReg, curReg, rhs2], node);
        } else {
          rhsReg = this._compileExpr(n.right, scope, bc);
        }

        // Store result and return it.
        if (res.kind === "local") {
          if (rhsReg !== res.reg)
            this.emit(bc, [this.OP.MOVE, res.reg, rhsReg], node);
          return res.reg;
        } else if (res.kind === "upvalue") {
          this.emit(bc, [this.OP.STORE_UPVALUE, res.index, rhsReg], node);
          return rhsReg;
        } else {
          const nameIdx = b.constantOperand((n.left as t.Identifier).name);
          this.emit(bc, [this.OP.STORE_GLOBAL, nameIdx, rhsReg], node);
          return rhsReg;
        }
      }

      case "CallExpression": {
        const n = node as t.CallExpression;
        ok(n.arguments.length < U16_MAX, `Too many arguments (max ${U16_MAX - 1})`);

        if (n.callee.type === "MemberExpression") {
          // Method call: receiver.method(args)
          const receiverReg = this._compileExpr(n.callee.object, scope, bc);

          let methodKeyReg: b.RegisterOperand;
          if (n.callee.computed) {
            methodKeyReg = this._compileExpr(
              n.callee.property as t.Expression,
              scope,
              bc,
            );
          } else {
            methodKeyReg = ctx.allocReg();
            this.emit(
              bc,
              [
                this.OP.LOAD_CONST,
                methodKeyReg,
                b.constantOperand((n.callee.property as t.Identifier).name),
              ],
              node,
            );
          }

          const calleeReg = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.GET_PROP, calleeReg, receiverReg, methodKeyReg],
            node,
          );

          const dst = ctx.allocReg();
          if (this._hasSpread(n.arguments)) {
            const argsArrayReg = this._buildSpreadArgs(n.arguments, scope, bc, node);
            this.emit(bc, [this.OP.CALL_METHOD, dst, receiverReg, calleeReg, this.SENTINELS.CALL_SPREAD, argsArrayReg], node);
          } else {
            const argRegs = n.arguments.map((a) =>
              this._compileExpr(a as t.Expression, scope, bc),
            );
            this.emit(
              bc,
              [this.OP.CALL_METHOD, dst, receiverReg, calleeReg, n.arguments.length, ...argRegs],
              node,
            );
          }
          return dst;
        } else {
          // Plain call: fn(args)
          const calleeReg = this._compileExpr(
            n.callee as t.Expression,
            scope,
            bc,
          );
          const dst = ctx.allocReg();
          if (this._hasSpread(n.arguments)) {
            const argsArrayReg = this._buildSpreadArgs(n.arguments, scope, bc, node);
            this.emit(bc, [this.OP.CALL, dst, calleeReg, this.SENTINELS.CALL_SPREAD, argsArrayReg], node);
          } else {
            const argRegs = n.arguments.map((a) =>
              this._compileExpr(a as t.Expression, scope, bc),
            );
            this.emit(bc, [this.OP.CALL, dst, calleeReg, n.arguments.length, ...argRegs], node);
          }
          return dst;
        }
      }

      case "UnaryExpression": {
        const n = node as t.UnaryExpression;

        // typeof on a potentially-undeclared global -- safe guard.
        if (n.operator === "typeof" && n.argument.type === "Identifier") {
          const res = this._resolve(n.argument.name, this._currentCtx);
          if (res.kind === "global") {
            const dst = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.TYPEOF_SAFE, dst, b.constantOperand(n.argument.name)],
              node,
            );
            return dst;
          }
        }

        // delete expression.
        if (n.operator === "delete") {
          const arg = n.argument;
          if (arg.type === "MemberExpression") {
            const objReg = this._compileExpr(arg.object, scope, bc);
            let keyReg: b.RegisterOperand;
            if (arg.computed) {
              keyReg = this._compileExpr(
                arg.property as t.Expression,
                scope,
                bc,
              );
            } else {
              keyReg = ctx.allocReg();
              this.emit(
                bc,
                [
                  this.OP.LOAD_CONST,
                  keyReg,
                  b.constantOperand((arg.property as t.Identifier).name),
                ],
                node,
              );
            }
            const dst = ctx.allocReg();
            this.emit(bc, [this.OP.DELETE_PROP, dst, objReg, keyReg], node);
            return dst;
          } else {
            // delete x or delete 0 -- always true in sloppy mode.
            const dst = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.LOAD_CONST, dst, b.constantOperand(true)],
              node,
            );
            return dst;
          }
        }

        // All other unary operators.
        const srcReg = this._compileExpr(n.argument, scope, bc);
        const dst = ctx.allocReg();
        const unaryOp = (
          {
            "-": this.OP.UNARY_NEG,
            "+": this.OP.UNARY_POS,
            "!": this.OP.UNARY_NOT,
            "~": this.OP.UNARY_BITNOT,
            typeof: this.OP.TYPEOF,
            void: this.OP.VOID,
          } as Record<string, number | undefined>
        )[n.operator];

        if (unaryOp === undefined)
          throw new Error(`Unsupported unary operator: ${n.operator}`);

        this.emit(bc, [unaryOp, dst, srcReg], node);
        return dst;
      }

      case "RegExpLiteral": {
        const n = node as t.RegExpLiteral;
        // new RegExp(pattern, flags)
        const regExpReg = ctx.allocReg();
        this.emit(
          bc,
          [this.OP.LOAD_GLOBAL, regExpReg, b.constantOperand("RegExp")],
          node,
        );
        const patternReg = ctx.allocReg();
        this.emit(
          bc,
          [this.OP.LOAD_CONST, patternReg, b.constantOperand(n.pattern)],
          node,
        );
        const flagsReg = ctx.allocReg();
        this.emit(
          bc,
          [this.OP.LOAD_CONST, flagsReg, b.constantOperand(n.flags)],
          node,
        );
        const dst = ctx.allocReg();
        this.emit(
          bc,
          [this.OP.NEW, dst, regExpReg, 2, patternReg, flagsReg],
          node,
        );
        return dst;
      }

      case "FunctionExpression": {
        const desc = this._compileFunctionDecl(node as t.FunctionExpression);
        return this._emitMakeClosure(desc, node, bc);
      }

      case "MemberExpression": {
        const n = node as t.MemberExpression;
        const objReg = this._compileExpr(n.object, scope, bc);
        let keyReg: b.RegisterOperand;
        if (n.computed) {
          keyReg = this._compileExpr(n.property as t.Expression, scope, bc);
        } else {
          keyReg = ctx.allocReg();
          this.emit(
            bc,
            [
              this.OP.LOAD_CONST,
              keyReg,
              b.constantOperand((n.property as t.Identifier).name),
            ],
            node,
          );
        }
        const dst = ctx.allocReg();
        this.emit(bc, [this.OP.GET_PROP, dst, objReg, keyReg], node);
        return dst;
      }

      case "ArrayExpression": {
        const n = node as t.ArrayExpression;
        if (this._hasSpread(n.elements)) {
          return this._buildSpreadArgs(n.elements, scope, bc, node);
        }
        const elemRegs = n.elements.map((el) => {
          if (el === null) {
            const r = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.LOAD_CONST, r, b.constantOperand(undefined)],
              node,
            );
            return r;
          }
          return this._compileExpr(el as t.Expression, scope, bc);
        });
        const dst = ctx.allocReg();
        this.emit(
          bc,
          [this.OP.BUILD_ARRAY, dst, n.elements.length, ...elemRegs],
          node,
        );
        return dst;
      }

      case "ObjectExpression": {
        const n = node as t.ObjectExpression;

        const hasSpread = n.properties.some((p) => p.type === "SpreadElement");
        const hasComputed = n.properties.some(
          (p) =>
            (p.type === "ObjectProperty" || p.type === "ObjectMethod") &&
            (p as t.ObjectProperty | t.ObjectMethod).computed,
        );
        const hasMethodShorthand = n.properties.some(
          (p) =>
            p.type === "ObjectMethod" &&
            (p as t.ObjectMethod).kind === "method",
        );

        // Fast path: no spread, no computed keys, no method shorthands.
        // Uses BUILD_OBJECT for data properties then DEFINE_GETTER/SETTER for accessors.
        if (!hasSpread && !hasComputed && !hasMethodShorthand) {
          const regularProps: t.ObjectProperty[] = [];
          const accessorProps: t.ObjectMethod[] = [];
          for (const prop of n.properties) {
            if (prop.type === "ObjectMethod") accessorProps.push(prop);
            else regularProps.push(prop as t.ObjectProperty);
          }

          const pairRegs: b.RegisterOperand[] = [];
          for (const prop of regularProps) {
            const key = prop.key;
            let keyStr: string;
            if (key.type === "Identifier") keyStr = key.name;
            else if (
              key.type === "StringLiteral" ||
              key.type === "NumericLiteral"
            )
              keyStr = String(key.value);
            else throw new Error(`Unsupported object key type: ${key.type}`);
            const keyReg = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.LOAD_CONST, keyReg, b.constantOperand(keyStr)],
              node,
            );
            const valReg = this._compileExpr(
              prop.value as t.Expression,
              scope,
              bc,
            );
            pairRegs.push(keyReg, valReg);
          }

          const dst = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.BUILD_OBJECT, dst, regularProps.length, ...pairRegs],
            node,
          );

          for (const prop of accessorProps) {
            const key = prop.key;
            let keyStr: string;
            if (key.type === "Identifier") keyStr = key.name;
            else if (
              key.type === "StringLiteral" ||
              key.type === "NumericLiteral"
            )
              keyStr = String(key.value);
            else throw new Error(`Unsupported object key type: ${key.type}`);
            const keyReg = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.LOAD_CONST, keyReg, b.constantOperand(keyStr)],
              node,
            );
            const fnReg = this._emitMakeClosure(
              this._compileFunctionDecl(prop as any),
              prop as any,
              bc,
            );
            this.emit(
              bc,
              [
                prop.kind === "get"
                  ? this.OP.DEFINE_GETTER
                  : this.OP.DEFINE_SETTER,
                dst,
                keyReg,
                fnReg,
              ],
              node,
            );
          }

          return dst;
        }

        // General path: handles spread elements, computed keys, and method shorthands.
        // Builds an empty object then sets each property in source order.
        const dst = ctx.allocReg();
        this.emit(bc, [this.OP.BUILD_OBJECT, dst, 0], node);

        for (const prop of n.properties) {
          if (prop.type === "SpreadElement") {
            // {…src} — copies own enumerable properties via Object.assign(dst, src).
            const objGlobalReg = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.LOAD_GLOBAL, objGlobalReg, b.constantOperand("Object")],
              node,
            );
            const assignKeyReg = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.LOAD_CONST, assignKeyReg, b.constantOperand("assign")],
              node,
            );
            const assignFnReg = ctx.allocReg();
            this.emit(
              bc,
              [this.OP.GET_PROP, assignFnReg, objGlobalReg, assignKeyReg],
              node,
            );
            const spreadValReg = this._compileExpr(
              (prop as t.SpreadElement).argument,
              scope,
              bc,
            );
            const _assignResultReg = ctx.allocReg();
            this.emit(
              bc,
              [
                this.OP.CALL_METHOD,
                _assignResultReg,
                objGlobalReg,
                assignFnReg,
                2,
                dst,
                spreadValReg,
              ],
              node,
            );
          } else {
            const p = prop as t.ObjectProperty | t.ObjectMethod;

            // Resolve key: computed → evaluate expression; static → load constant.
            let keyReg: b.RegisterOperand;
            if (p.computed) {
              keyReg = this._compileExpr(p.key as t.Expression, scope, bc);
            } else {
              const key = p.key;
              let keyStr: string;
              if (key.type === "Identifier") keyStr = key.name;
              else if (
                key.type === "StringLiteral" ||
                key.type === "NumericLiteral"
              )
                keyStr = String(key.value);
              else
                throw new Error(`Unsupported object key type: ${key.type}`);
              keyReg = ctx.allocReg();
              this.emit(
                bc,
                [this.OP.LOAD_CONST, keyReg, b.constantOperand(keyStr)],
                node,
              );
            }

            if (p.type === "ObjectMethod") {
              const fnReg = this._emitMakeClosure(
                this._compileFunctionDecl(p as any),
                p as any,
                bc,
              );
              if (p.kind === "get") {
                this.emit(
                  bc,
                  [this.OP.DEFINE_GETTER, dst, keyReg, fnReg],
                  node,
                );
              } else if (p.kind === "set") {
                this.emit(
                  bc,
                  [this.OP.DEFINE_SETTER, dst, keyReg, fnReg],
                  node,
                );
              } else {
                // method shorthand: {foo() {}} ≡ {foo: function() {}}
                this.emit(bc, [this.OP.SET_PROP, dst, keyReg, fnReg], node);
              }
            } else {
              const valReg = this._compileExpr(
                (p as t.ObjectProperty).value as t.Expression,
                scope,
                bc,
              );
              this.emit(bc, [this.OP.SET_PROP, dst, keyReg, valReg], node);
            }
          }
        }

        return dst;
      }

      default: {
        throw new Error(`Unsupported expression: ${(node as any).type}`);
      }
    }
  }
}

// Serializer
class Serializer {
  compiler: Compiler;

  constructor(compiler: Compiler) {
    this.compiler = compiler;
  }

  get options() {
    return this.compiler.options;
  }
  get OP() {
    return this.compiler.OP;
  }
  get OP_NAME() {
    return this.compiler.OP_NAME;
  }
  get JUMP_OPS() {
    return this.compiler.JUMP_OPS;
  }

  _serializeConst(val: any) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    return JSON.stringify(val);
  }

  // Reverse the concealment applied by resolveConstants so disassembly comments
  // always show the plaintext value regardless of the concealConstants option.
  _decryptConst(constants: any[], idx: number, key: number): any {
    const v = constants[idx];
    if (!key) return v;
    if (typeof v === "number") return v ^ key;
    if (typeof v !== "string") return v;
    // String: base64 → u16 LE byte pairs → XOR with (key + i) (mirrors _readConstant)
    const bytes = Buffer.from(v as string, "base64");
    let out = "";
    for (let i = 0; i < bytes.length / 2; i++) {
      const code = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
      out += String.fromCharCode(code ^ ((key + i) & 0xffff));
    }
    return out;
  }

  _generateComment(instr: b.Instruction) {
    const op = instr[0] as number;
    const operands = instr.slice(1) as number[];

    if (op === null && (operands[0] as any)?.type === "defineLabel") {
      const label = (operands[0] as any).label;
      return `${label}:`;
    }

    const constants = this.compiler.constants;

    const emittedOperands = operands.filter(
      (operand) => (operand as any)?.placeholder !== true,
    );

    const resolvedOperands = emittedOperands.map(
      (o) => (o as any)?.resolvedValue ?? o,
    );

    const displayOperands = operands.map((o, i) => {
      const resolvedValue = resolvedOperands[i];
      const label = (o as any)?.label;

      let displayOperand = resolvedValue;
      if (label) {
        return label;
      }

      return displayOperand;
    });

    let name = this.OP_NAME[op];
    if (!name || name.includes("{")) {
      name = `OP_${op}`;
    }

    let comment = name;

    function formatLoc(loc: t.Node["loc"]["start"]) {
      return loc ? `${loc.line}:${loc.column}` : "";
    }

    const sourceNode = instr[SOURCE_NODE_SYM];
    const sourceLocation = sourceNode?.loc
      ? [formatLoc(sourceNode.loc.start), formatLoc(sourceNode.loc.end)]
          .filter(Boolean)
          .join("-")
      : "";

    if (displayOperands.length > 0) {
      // Operand[0] is always `dst` for instruction types that produce a value.
      const dst = displayOperands[0];

      switch (op) {
        case this.OP.LOAD_CONST: {
          // resolvedOperands: [dst, constIdx, concealKey]
          const val = this._decryptConst(
            constants,
            displayOperands[1],
            displayOperands[2],
          );
          comment += `  reg[${dst}] = ${this._serializeConst(val)}`;
          break;
        }

        case this.OP.LOAD_INT: {
          // resolvedOperands: [dst, intValue]
          comment += `  reg[${dst}] = ${displayOperands[1]}`;
          break;
        }

        case this.OP.LOAD_GLOBAL:
          // resolvedOperands: [dst, constIdx, concealKey]
          comment += `  reg[${dst}] = ${this._decryptConst(constants, displayOperands[1], displayOperands[2])}`;
          break;
        case this.OP.STORE_GLOBAL:
          // resolvedOperands: [constIdx, concealKey, srcReg]
          comment += `  ${this._decryptConst(constants, displayOperands[0], displayOperands[1])} = reg[${displayOperands[2]}]`;
          break;
        case this.OP.LOAD_UPVALUE:
          comment += `  reg[${dst}] = upvalue[${displayOperands[1]}]`;
          break;
        case this.OP.STORE_UPVALUE:
          comment += `  upvalue[${displayOperands[0]}] = reg[${displayOperands[1]}]`;
          break;
        case this.OP.MOVE:
          comment += `  reg[${dst}] = reg[${displayOperands[1]}]`;
          break;
        case this.OP.MAKE_CLOSURE:
          comment += `  reg[${dst}] PC=${displayOperands[1]} (params=${displayOperands[2]} regs=${displayOperands[3]} upvalues=${displayOperands[4]})`;
          break;
        case this.OP.CALL:
          comment += `  reg[${dst}] = reg[${displayOperands[1]}](${displayOperands
            .slice(3)
            .map((v) => `reg[${v}]`)
            .join(", ")})`;
          break;
        case this.OP.CALL_METHOD:
          comment += `  reg[${dst}] = reg[${displayOperands[2]}](recv=reg[${displayOperands[1]}], ${displayOperands[3]} args)`;
          break;
        case this.OP.NEW:
          comment += `  reg[${dst}] = new reg[${displayOperands[1]}](${displayOperands[2]} args)`;
          break;
        case this.OP.RETURN:
          comment += `  reg[${displayOperands[0]}]`;
          break;
        case this.OP.BUILD_ARRAY:
          comment += `  reg[${dst}] = [${displayOperands[2]} elems]`;
          break;
        case this.OP.BUILD_OBJECT:
          comment += `  reg[${dst}] = {${displayOperands[1]} pairs}`;
          break;
        case this.OP.GET_PROP:
          comment += `  reg[${dst}] = reg[${displayOperands[1]}][reg[${displayOperands[2]}]]`;
          break;
        case this.OP.SET_PROP:
          comment += `  reg[${displayOperands[0]}][reg[${displayOperands[1]}]] = reg[${displayOperands[2]}]`;
          break;

        case this.OP.JUMP_REG:
          comment += `  PC = reg[${displayOperands[0]}]`;
          break;

        default:
          comment +=
            displayOperands.length === 1
              ? `  ${displayOperands[0]}`
              : `  [${displayOperands.join(", ")}]`;
      }
    }

    comment = comment.padEnd(50) + sourceLocation;

    const values = [op, ...resolvedOperands];
    const instrText = `[${values.join(", ")}]`;
    const text = `${(instrText + ",").padEnd(20)} ${comment}`;

    return text;
  }

  _serializeConstants(constants: any[]) {
    const lines = ["var CONSTANTS = ["];
    constants.forEach((val, idx) => {
      lines.push(`  /* ${idx} */  ${this._serializeConst(val)},`);
    });
    lines.push("];");
    return lines.join("\n");
  }

  _serializeBytecode(
    bytecode: b.Bytecode,
    compiler: Compiler,
  ): { bytecode: b.Bytecode } {
    const serialized = [];
    for (const instr of bytecode) {
      const op = instr[0];
      const operands = instr.slice(1);

      if (instr[0] === null) continue; // null opcodes are not emitted

      const resolvedValues = operands.map(
        (o) => (o as any)?.resolvedValue ?? o,
      );

      const specializedOpInfo = compiler.SPECIALIZED_OPS[instr[0]];
      if (specializedOpInfo) {
        const originalName = compiler.OP_NAME[specializedOpInfo.originalOp];
        compiler.OP_NAME[instr[0]] =
          `${originalName}_${resolvedValues.join("_")}`;
      }

      // Validate no opcode or operand exceeds u16 limit
      for (const o of resolvedValues) {
        ok(typeof o === "number", "Unresolved operand: " + JSON.stringify(o));

        ok(
          o >= 0 && o <= 0xffffffff,
          `Operand overflow (max 0xFFFFFFFF u32): ${o}`,
        );
      }
      ok(
        op >= 0 && op <= 0xffffffff,
        `Opcode overflow (max 0xFFFFFFFF u32): ${op}`,
      );

      serialized.push(instr);
    }
    return { bytecode: serialized };
  }

  _encodeBytecode(flat: number[]) {
    const buf = new Uint8Array(flat.length * 4);
    flat.forEach((w, i) => {
      buf[i * 4] = w & 0xff;
      buf[i * 4 + 1] = (w >>> 8) & 0xff;
      buf[i * 4 + 2] = (w >>> 16) & 0xff;
      buf[i * 4 + 3] = (w >>> 24) & 0xff;
    });
    return Buffer.from(buf).toString("base64");
  }

  serialize(bytecode: b.Bytecode, constants: any[], compiler: Compiler) {
    const mainStartPc = compiler.mainStartPc;
    const mainRegCount = compiler.mainRegCount;
    let sections = [];

    var initBody = [];
    var bytecodeResult = this._serializeBytecode(bytecode, compiler);

    const flat = bytecodeResult.bytecode.flatMap((instr) => {
      let filtered = instr.filter((x) => (x as any)?.placeholder !== true);
      let resolved = filtered.map((x) => (x as any)?.resolvedValue ?? x);
      return resolved as number[];
    });

    if (this.options.encodeBytecode) {
      sections.push(`var BYTECODE = "${this._encodeBytecode(flat)}";`);
    } else {
      sections.push(`var BYTECODE = [${flat.join(",")}]`);
    }

    sections.push(`var MAIN_START_PC = ${mainStartPc};`);
    sections.push(`var MAIN_REG_COUNT = ${mainRegCount};`);
    sections.push(`var ENCODE_BYTECODE = ${!!this.options.encodeBytecode};`);
    sections.push(`var TIMING_CHECKS = ${!!this.options.timingChecks};`);

    const object = t.objectExpression(
      Object.entries(this.OP).map(([name, value]) =>
        t.objectProperty(t.identifier(name), t.numericLiteral(value)),
      ),
    );
    sections.push(`var OP = ${generate(object).code};`);

    const sentinelsObject = t.objectExpression(
      Object.entries(compiler.SENTINELS).map(([name, value]) =>
        t.objectProperty(t.identifier(name), t.numericLiteral(value)),
      ),
    );
    sections.push(`var SENTINELS = ${generate(sentinelsObject).code};`);

    initBody.push(this._serializeConstants(constants));

    sections = [...initBody, ...sections];
    sections.push(VM_RUNTIME);

    return sections.join("\n\n");
  }
}

export async function compileAndSerialize(
  sourceCode: string,
  options: Options,
): Promise<b.ObfuscationResult> {
  let obfuscationStartedAt = now();

  const compiler = new Compiler(options);
  let bytecode = compiler.compile(sourceCode);

  const passes: {
    pass: (
      bytecode: b.Bytecode,
      compiler: Compiler,
    ) => { bytecode: b.Bytecode; constants?: any[] };
    name: string;
  }[] = [];

  if (options.stringConcealing) {
    passes.push({
      pass: stringConcealing,
      name: "stringConcealing",
    });
  }

  // CFF and Dispatcher both run before resolveRegisters and resolveLabels
  if (options.controlFlowFlattening) {
    passes.push({
      pass: controlFlowFlattening,
      name: "controlFlowFlattening",
    });
  }

  if (options.dispatcher) {
    passes.push({
      pass: dispatcher,
      name: "dispatcher",
    });
  }

  passes.push({
    pass: concealConstants,
    name: "concealConstants",
  });

  if (options.specializedOpcodes) {
    passes.push({
      pass: specializedOpcodes,
      name: "specializedOpcodes",
    });
  }

  if (options.macroOpcodes) {
    passes.push({
      pass: macroOpcodes,
      name: "macroOpcodes",
    });
  }

  if (options.aliasedOpcodes) {
    passes.push({
      pass: aliasedOpcodes,
      name: "aliasedOpcodes",
    });
  }

  const timings = {};

  function runAndTime(pass, name) {
    const startedAt = now();

    compiler.log(`Running bytecode pass ${name}...`);

    const passResult = pass(bytecode, compiler);
    bytecode = passResult.bytecode;

    const endedAt = now();
    const elapsedMs = endedAt - startedAt;
    timings[name] = elapsedMs;

    compiler.profileData.transforms[name] = {
      transformTime: elapsedMs,
      bytecodeSize: bytecode.length,
    };

    compiler.log(
      `Bytecode pass ${name} completed in ${Math.floor(elapsedMs)}ms`,
    );

    return passResult;
  }

  for (const pass of passes) {
    runAndTime(pass.pass, pass.name);
  }

  // Resolve virtual registers to concrete slot indices and set regCount per fn.
  // Must run BEFORE selfModifying: that pass moves body instructions to the end
  // of the bytecode while leaving RETURN in place, splitting a function's code
  // into two non-contiguous regions. Linear-scan liveness then sees incorrect
  // firstUse/lastUse for registers that span the gap, causing slot collisions.
  const regsResult = runAndTime(resolveRegisters, "resolveRegisters");
  bytecode = regsResult.bytecode;

  // selfModifying runs after register resolution so concrete slot indices are
  // already in place; only label operands remain unresolved at this stage.
  if (options.selfModifying) {
    const smResult = runAndTime(selfModifying, "selfModifying");
    bytecode = smResult.bytecode;
  }

  // Resolve label references to flat bytecode indices.
  const labelsResult = runAndTime(resolveLabels, "resolveLabels");
  bytecode = labelsResult.bytecode;

  // Set mainStartPc from the first function descriptor (or 0 for top-level start).
  compiler.mainStartPc = compiler.mainFn.startPc;

  // Resolve constant references to pool indices (+ conceal key operand).
  const constResult = runAndTime(resolveConstants, "resolveConstants");
  bytecode = constResult.bytecode;
  compiler.constants = constResult.constants;

  // Build and obfuscate the runtime.
  const runtimeSource = compiler.serializer.serialize(
    bytecode,
    constResult.constants,
    compiler,
  );

  // for (const key of Object.keys(timings)) {
  //  console.log(`  ${key}: ${timings[key]}ms`);
  // }

  // This part was purposefully pulled out Serializer as OP_NAME's get resolved during buildRuntime
  // So for the most useful comments, it's ran absolutely last
  // Tests also rely on correct comments so it's required
  const generateBytecodeComment = () => {
    var lines: string[] = [];
    for (const instr of bytecode) {
      const comment = compiler.serializer._generateComment(instr);
      lines.push("// " + comment);
    }

    return lines.join("\n");
  };

  const code = await buildRuntime(
    runtimeSource,
    bytecode,
    options,
    compiler,
    generateBytecodeComment,
  );

  compiler.profileData.obfuscationTime = now() - obfuscationStartedAt;

  return {
    code,
    profileData: compiler.profileData as b.ObfuscationResult["profileData"],
  };
}
