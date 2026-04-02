import * as t from "@babel/types";
import * as b from "./types.ts";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { generate } from "@babel/generator";
import { join } from "path";
import { readFileSync } from "fs";
import { stripTypeScriptTypes } from "module";
import { ok } from "assert";
import { obfuscateRuntime } from "./build-runtime.ts";
import { DEFAULT_OPTIONS, type Options } from "./options.ts";
import { resolveLabels } from "./transforms/bytecode/resolveLabels.ts";
import { resolveConstants } from "./transforms/bytecode/resolveContants.ts";
import { selfModifying } from "./transforms/bytecode/selfModifying.ts";
import { macroOpcodes } from "./transforms/bytecode/macroOpcodes.ts";
import { microOpcodes } from "./transforms/bytecode/microOpcodes.ts";
import { specializedOpcodes } from "./transforms/bytecode/specializedOpcodes.ts";
import { aliasedOpcodes } from "./transforms/bytecode/aliasedOpcodes.ts";
import { getRandomInt } from "./utils/random-utils.ts";
import { U16_MAX } from "./utils/op-utils.ts";
import { concealConstants } from "./transforms/bytecode/concealConstants.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

const readVMRuntimeFile = () => {
  let code;
  try {
    code = readFileSync(join(import.meta.dirname, "./runtime.ts"), "utf-8");
  } catch (e) {
    code = readFileSync(join(import.meta.dirname, "./runtime.js"), "utf-8");
  }

  return stripTypeScriptTypes?.(code) || code;
};

export const VM_RUNTIME = readVMRuntimeFile().split("@START")[1];
export const SOURCE_NODE_SYM = Symbol("SOURCE_NODE");

// ── Opcodes ──────────────────────────────────────────────────────────────────
// Register-based encoding.  Operand convention (x86 / CPython style):
//   destination register first, then source registers, then immediates.
//
//   dst      – register index that receives the result
//   src      – register index holding an input value
//   imm/Idx  – immediate integer (constant-pool index, upvalue index, argc …)
//
// Every arithmetic/comparison/unary instruction: [op, dst, src1, src2?]
// Every load:                                    [op, dst, ...]
// Every store:                                   [op, target, src]
// Calls:     CALL  [op, dst, callee, argc, arg0, arg1, …]
//            CALL_METHOD [op, dst, receiver, callee, argc, arg0, …]
export const OP_ORIGINAL = {
  // ── Loads ─────────────────────────────────────────────────────────────────
  LOAD_CONST: 0, // dst, constIdx      regs[dst] = constants[constIdx]
  LOAD_INT: 1, // dst, imm           regs[dst] = imm  (raw u16 literal)
  LOAD_GLOBAL: 2, // dst, nameIdx       regs[dst] = globals[constants[nameIdx]]
  LOAD_UPVALUE: 3, // dst, uvIdx         regs[dst] = upvalues[uvIdx].read()
  LOAD_THIS: 4, // dst                regs[dst] = frame.thisVal
  MOVE: 5, // dst, src           regs[dst] = regs[src]

  // ── Stores ────────────────────────────────────────────────────────────────
  STORE_GLOBAL: 6, // nameIdx, src       globals[constants[nameIdx]] = regs[src]
  STORE_UPVALUE: 7, // uvIdx,   src       upvalues[uvIdx].write(regs[src])

  // ── Property access ───────────────────────────────────────────────────────
  GET_PROP: 8, // dst, obj, key      regs[dst] = regs[obj][regs[key]]
  SET_PROP: 9, // obj, key, val      regs[obj][regs[key]] = regs[val]  (result stays in val reg)
  DELETE_PROP: 10, // dst, obj, key      regs[dst] = delete regs[obj][regs[key]]

  // ── Arithmetic / bitwise  (dst, src1, src2) ───────────────────────────────
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

  // ── Comparison  (dst, src1, src2) ─────────────────────────────────────────
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

  // ── Unary  (dst, src) ─────────────────────────────────────────────────────
  UNARY_NEG: 32,
  UNARY_POS: 33,
  UNARY_NOT: 34,
  UNARY_BITNOT: 35,
  TYPEOF: 36, // dst, src
  VOID: 37, // dst, src   – regs[dst] = undefined (src evaluated for side-effects)
  TYPEOF_SAFE: 38, // dst, nameConstIdx – safe typeof for potentially-undeclared globals

  // ── Control flow ──────────────────────────────────────────────────────────
  JUMP: 39, // target
  JUMP_IF_FALSE: 40, // src, target    if !regs[src] then pc = target
  JUMP_IF_TRUE: 41, // src, target    if  regs[src] then pc = target  (|| short-circuit)

  // ── Calls & constructors ──────────────────────────────────────────────────
  CALL: 42, // dst, callee, argc, [argRegs…]
  CALL_METHOD: 43, // dst, receiver, callee, argc, [argRegs…]
  NEW: 44, // dst, callee, argc, [argRegs…]
  RETURN: 45, // src
  THROW: 46, // src

  // ── Closures ──────────────────────────────────────────────────────────────
  // dst, startPc, paramCount, regCount, uvCount, [isLocal, idx, …]
  MAKE_CLOSURE: 47,

  // ── Collections ───────────────────────────────────────────────────────────
  BUILD_ARRAY: 48, // dst, count,     [elemRegs…]
  BUILD_OBJECT: 49, // dst, pairCount, [keyReg, valReg, …]

  // ── Property definitions (getters / setters) ──────────────────────────────
  DEFINE_GETTER: 50, // obj, key, fn
  DEFINE_SETTER: 51, // obj, key, fn

  // ── For-in iteration ──────────────────────────────────────────────────────
  FOR_IN_SETUP: 52, // dst, src              dst = { _keys: enumKeys(src), i: 0 }
  FOR_IN_NEXT: 53, // dst, iter, exitTarget

  // ── Exception handling ────────────────────────────────────────────────────
  TRY_SETUP: 54, // handlerPc, exceptionReg
  TRY_END: 55,

  // ── Self-modifying bytecode ───────────────────────────────────────────────
  PATCH: 56, // destPc, sliceStart, sliceEnd

  // ── Debug ─────────────────────────────────────────────────────────────────
  DEBUGGER: 57,
};

// ── Scope ─────────────────────────────────────────────────────────────────────
// Maps variable names to register indices (slot numbers).
// Locals are allocated at compile time; zero name lookups at runtime.
class Scope {
  parent: Scope | null;
  _locals: Map<string, number>;
  _next: number;

  constructor(parent = null) {
    this.parent = parent;
    this._locals = new Map();
    this._next = 0;
  }

  define(name: string): number {
    if (!this._locals.has(name)) {
      this._locals.set(name, this._next++);
    }
    return this._locals.get(name)!;
  }

  resolve(name: string): { kind: "local"; slot: number } | { kind: "global" } {
    if (this._locals.has(name)) {
      return { kind: "local", slot: this._locals.get(name)! };
    }
    if (this.parent) return this.parent.resolve(name);
    return { kind: "global" };
  }

  get localCount() {
    return this._next;
  }
}

// ── FnContext ─────────────────────────────────────────────────────────────────
// Compiler-side state for the function currently being compiled.
// Distinct from the runtime Frame — this is compile-time only.
class FnContext {
  upvalues: { name: string; isLocal: number; index: number }[];
  parentCtx: FnContext | null;
  scope: Scope;
  compiler: Compiler;
  bc: b.Instruction[];

  // Register allocator.  Locals occupy regs[0..scope.localCount-1];
  // temps are allocated above that and freed at statement boundaries.
  regTop: number = 0;
  maxRegTop: number = 0;

  constructor(compiler: Compiler, parentCtx: FnContext | null = null) {
    this.compiler = compiler;
    this.parentCtx = parentCtx;
    this.scope = new Scope();
    this.bc = [];
    this.upvalues = [];
  }

  /** Allocate the next free temp register and return its index. */
  allocReg(): number {
    const r = this.regTop++;
    if (this.regTop > this.maxRegTop) this.maxRegTop = this.regTop;
    return r;
  }

  /** Release all temps above the local region. Called at each statement boundary. */
  resetTemps(): void {
    this.regTop = this.scope.localCount;
  }

  addUpvalue(name: string, isLocal: number, index: number): number {
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

  /**
   * Only populated AFTER resolveLabels
   */
  startPc?: number;
}

// ── Compiler ──────────────────────────────────────────────────────────────────
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
    type: "loop" | "switch" | "block";
    label: string | null;
    breakLabel: string;
    continueLabel: string;
  }[];

  options: Options;
  serializer: Serializer;

  OP: Partial<typeof OP_ORIGINAL>;
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

  /** Internal variable slot registry.
   *  globally: shared name→index pool (written on first sight; reused by non-random mode or by 50% chance in random mode).
   *  opcodes:  per-opcode source-of-truth — all assignment lookups are read/written here. */
  _internals: {
    globally: Map<string, number>;
    opcodes: Map<number, Map<string, number>>;
  };

  OP_NAME: Record<number, string>;
  JUMP_OPS: Set<number>;

  constants: any[];

  emit(bc: b.Bytecode, instr: b.Instruction, node: t.Node) {
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
    this._internals = { globally: new Map(), opcodes: new Map() };

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

    this.OP_NAME = Object.fromEntries(
      Object.entries(this.OP).map(([k, v]) => [v, k]),
    );

    this.JUMP_OPS = new Set([
      this.OP.JUMP,
      this.OP.JUMP_IF_FALSE,
      this.OP.JUMP_IF_TRUE,
      this.OP.FOR_IN_NEXT,
      this.OP.TRY_SETUP,
    ]);
  }

  _makeLabel(hint = ""): string {
    return `${hint || "L"}_${this._labelCount++}`;
  }

  _resolve(
    name: string,
    ctx: FnContext | null,
  ):
    | { kind: "local"; slot: number }
    | { kind: "upvalue"; index: number }
    | { kind: "global" } {
    if (!ctx) return { kind: "global" };

    if (ctx.scope._locals.has(name)) {
      return { kind: "local", slot: ctx.scope._locals.get(name)! };
    }

    if (!ctx.parentCtx) return { kind: "global" };

    const parentResult = this._resolve(name, ctx.parentCtx);
    if (parentResult.kind === "global") return { kind: "global" };

    const isLocal = parentResult.kind === "local";
    const index = isLocal ? parentResult.slot : parentResult.index;
    const uvIdx = ctx.addUpvalue(name, isLocal ? 1 : 0, index);
    return { kind: "upvalue", index: uvIdx };
  }

  // ── Variable hoisting ──────────────────────────────────────────────────────
  // Pre-scan a statement list and reserve scope slots for every var declaration,
  // function declaration, for-in iterator, and try-catch binding.
  // Must be called before compilation begins so that ctx.regTop can be set
  // safely above ALL locals (including those declared late in the body).
  _hoistVars(stmts: t.Statement[], scope: Scope): void {
    for (const stmt of stmts) {
      switch (stmt.type) {
        case "VariableDeclaration":
          for (const decl of stmt.declarations) {
            if (decl.id.type === "Identifier") scope.define(decl.id.name);
          }
          break;

        case "FunctionDeclaration":
          if (stmt.id) scope.define(stmt.id.name);
          break;

        case "BlockStatement":
          this._hoistVars(stmt.body, scope);
          break;

        case "IfStatement": {
          const cons =
            stmt.consequent.type === "BlockStatement"
              ? stmt.consequent.body
              : [stmt.consequent];
          this._hoistVars(cons, scope);
          if (stmt.alternate) {
            const alt =
              stmt.alternate.type === "BlockStatement"
                ? stmt.alternate.body
                : [stmt.alternate];
            this._hoistVars(alt, scope);
          }
          break;
        }

        case "WhileStatement":
        case "DoWhileStatement": {
          const body =
            stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
          this._hoistVars(body, scope);
          break;
        }

        case "ForStatement": {
          if (stmt.init?.type === "VariableDeclaration") {
            for (const decl of stmt.init.declarations) {
              if (decl.id.type === "Identifier") scope.define(decl.id.name);
            }
          }
          const body =
            stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
          this._hoistVars(body, scope);
          break;
        }

        case "ForInStatement": {
          // Reserve a hidden register for the iterator object.
          (stmt as any)._iterSlot = scope._next++;
          if (stmt.left.type === "VariableDeclaration") {
            for (const decl of stmt.left.declarations) {
              if (decl.id.type === "Identifier") scope.define(decl.id.name);
            }
          }
          const body =
            stmt.body.type === "BlockStatement" ? stmt.body.body : [stmt.body];
          this._hoistVars(body, scope);
          break;
        }

        case "SwitchStatement":
          for (const c of stmt.cases) this._hoistVars(c.consequent, scope);
          break;

        case "TryStatement":
          this._hoistVars(stmt.block.body, scope);
          if (stmt.handler) {
            if (stmt.handler.param?.type === "Identifier") {
              // Catch parameter IS the exception register.
              scope.define((stmt.handler.param as t.Identifier).name);
            } else {
              // No catch binding – reserve a dummy slot for the exception value.
              (stmt as any)._exceptionSlot = scope._next++;
            }
            this._hoistVars(stmt.handler.body.body, scope);
          }
          break;

        case "LabeledStatement":
          this._hoistVars([stmt.body], scope);
          break;
      }
    }
  }

  // ── Entry point ───────────────────────────────────────────────────────────
  compile(source: string) {
    const ast = parse(source, { sourceType: "script" });
    return this.compileAST(ast);
  }

  compileAST(ast: t.File) {
    this._compileMain(ast.program.body);
    return this.bytecode;
  }

  // ── Function compilation ───────────────────────────────────────────────────
  _compileFunctionDecl(node: t.FunctionDeclaration | t.FunctionExpression) {
    ok(!node.generator, "Generator functions are not supported");
    ok(!node.async, "Async functions are not supported");

    var fnIdx = this.fnDescriptors.length;
    const entryLabel = this._makeLabel(`fn_${fnIdx}`);
    var desc: FnDescriptor = {};
    this.fnDescriptors.push(desc);

    const ctx = new FnContext(this, this._currentCtx);
    const savedCtx = this._currentCtx;
    this._currentCtx = ctx;

    const savedLoopStack = this._loopStack;
    this._loopStack = [];

    // 1. Define parameters (occupy regs 0..paramCount-1).
    for (const param of node.params) {
      let identifier = param.type === "AssignmentPattern" ? param.left : param;
      ok(
        identifier.type === "Identifier",
        "Only simple identifiers allowed as parameters",
      );
      ctx.scope.define((identifier as t.Identifier).name);
    }

    // 2. Reserve the `arguments` slot (reg index = paramCount).
    ctx.scope.define("arguments");

    // 3. Hoist all var declarations so temps start above every local.
    this._hoistVars(node.body.body, ctx.scope);

    // 4. Temps now start above all locals.
    ctx.regTop = ctx.scope.localCount;
    ctx.maxRegTop = ctx.regTop;

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
    desc.regCount = ctx.maxRegTop; // total registers needed at runtime
    desc.upvalues = ctx.upvalues.slice();

    return desc;
  }

  // Emit MAKE_CLOSURE with all metadata as inline operands.
  // Layout: dst, startPc, paramCount, regCount, uvCount, [isLocal, idx, …]
  _emitMakeClosure(desc: any, node: t.Node, bc: b.Bytecode) {
    const ctx = this._currentCtx!;
    const dst = ctx.allocReg();
    const uvOperands: (number | b.InstrOperand)[] = [];
    for (const uv of desc.upvalues) {
      uvOperands.push(uv.isLocal ? 1 : 0);
      uvOperands.push(uv.index);
    }
    this.emit(
      bc,
      [
        this.OP.MAKE_CLOSURE,
        dst,
        { type: "label", label: desc.entryLabel },
        desc.paramCount,
        desc.regCount,
        desc.upvalues.length,
        ...uvOperands,
      ] as b.Instruction,
      node,
    );
    return dst;
  }

  // ── Main (top-level) ───────────────────────────────────────────────────────
  _compileMain(body: t.Statement[]) {
    const mainCtx = new FnContext(this, null);
    const savedCtx = this._currentCtx;
    this._currentCtx = mainCtx;

    var desc = this._compileFunctionDecl({
      type: "FunctionDeclaration",
      async: false,
      generator: false,
      params: [],
      id: null,
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

    this.mainRegCount = mainCtx.maxRegTop;
    this.mainFn = desc;
    this._currentCtx = savedCtx;
  }

  // ── Statements ────────────────────────────────────────────────────────────
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
        let reg: number;
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
        for (let _ri = this._loopStack.length - 1; _ri >= 0; _ri--) {
          if ((this._loopStack[_ri].type as any) === "try") {
            this.emit(bc, [this.OP.TRY_END], node);
          }
        }
        this.emit(bc, [this.OP.RETURN, reg], node);
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
              this.emit(bc, [this.OP.MOVE, slot, ctx.allocReg()], node);
              // Load undefined into the just-allocated temp, then move.
              // Actually: just emit LOAD_CONST directly into slot.
              // Undo the allocReg – instead emit directly:
              ctx.regTop--; // undo the allocReg above
              const tmp = ctx.allocReg();
              this.emit(
                bc,
                [this.OP.LOAD_CONST, tmp, b.constantOperand(undefined)],
                node,
              );
              if (tmp !== slot) this.emit(bc, [this.OP.MOVE, slot, tmp], node);
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

        const savedTop = ctx.regTop;
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
        ctx.regTop = savedTop; // free test temps

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

        const savedTop = ctx.regTop;
        const testReg = this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, testReg, { type: "label", label: exitLabel }],
          node,
        );
        ctx.regTop = savedTop;

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

        const savedTop = ctx.regTop;
        const testReg = this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, testReg, { type: "label", label: exitLabel }],
          node,
        );
        ctx.regTop = savedTop;
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
          const savedTop = ctx.regTop;
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
          ctx.regTop = savedTop;
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
            if ((this._loopStack[_bi].type as any) !== "try") {
              _bTargetIdx = _bi;
              break;
            }
          }
          if (_bTargetIdx === -1) throw new Error("break outside loop");
        }
        for (let _bi = this._loopStack.length - 1; _bi > _bTargetIdx; _bi--) {
          if ((this._loopStack[_bi].type as any) === "try") {
            this.emit(bc, [this.OP.TRY_END], node);
          }
        }
        this.emit(
          bc,
          [
            this.OP.JUMP,
            { type: "label", label: this._loopStack[_bTargetIdx].breakLabel },
          ],
          node,
        );
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
        for (let _ci = this._loopStack.length - 1; _ci > _cTargetIdx; _ci--) {
          if ((this._loopStack[_ci].type as any) === "try") {
            this.emit(bc, [this.OP.TRY_END], node);
          }
        }
        this.emit(
          bc,
          [
            this.OP.JUMP,
            {
              type: "label",
              label: this._loopStack[_cTargetIdx].continueLabel,
            },
          ],
          node,
        );
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
          const savedTop = ctx.regTop;
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
          ctx.regTop = savedTop;
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
        const iterSlot: number = (node as any)._iterSlot;

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
            if (keyReg !== res.slot)
              this.emit(bc, [this.OP.MOVE, res.slot, keyReg], node);
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
        if (node.finalizer) {
          throw new Error("try..finally is not supported");
        }
        if (!node.handler) {
          throw new Error("try without catch is not supported");
        }

        const catchLabel = this._makeLabel("catch");
        const afterCatchLabel = this._makeLabel("after_catch");

        // Determine where the caught exception is written.
        const exceptionReg =
          node.handler.param?.type === "Identifier"
            ? (scope?._locals.get((node.handler.param as t.Identifier).name) ??
              ctx.allocReg()) // shouldn't normally reach here
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
          type: "try" as any,
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
        this.emit(bc, [null, { type: "defineLabel", label: catchLabel }], node);

        // If no param binding, just ignore the exception (it's in the dummy slot).
        for (const stmt of node.handler!.body.body) {
          this._compileStatement(stmt, scope, bc);
        }

        this.emit(
          bc,
          [null, { type: "defineLabel", label: afterCatchLabel }],
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

  // ── Expressions ───────────────────────────────────────────────────────────
  // Returns the register index that holds the result.
  // For local variables: returns their slot directly (no instruction emitted).
  // For all others: allocates a fresh temp register, emits the instruction(s),
  // and returns the allocated register.
  _compileExpr(
    node: t.Expression | t.Node,
    scope: Scope | null,
    bc: b.Bytecode,
  ): number {
    const ctx = this._currentCtx!;

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
        if (res.kind === "local") return res.slot; // register IS the local
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
        const calleeReg = this._compileExpr(
          (node as t.NewExpression).callee,
          scope,
          bc,
        );
        const argRegs = (node as t.NewExpression).arguments.map((a) =>
          this._compileExpr(a as t.Expression, scope, bc),
        );
        const dst = ctx.allocReg();
        this.emit(
          bc,
          [
            this.OP.NEW,
            dst,
            calleeReg,
            (node as t.NewExpression).arguments.length,
            ...argRegs,
          ],
          node,
        );
        return dst;
      }

      case "SequenceExpression": {
        const exprs = (node as t.SequenceExpression).expressions;
        for (let i = 0; i < exprs.length - 1; i++) {
          const savedTop = ctx.regTop;
          this._compileExpr(exprs[i], scope, bc);
          ctx.regTop = savedTop; // discard intermediate result
        }
        return this._compileExpr(exprs[exprs.length - 1], scope, bc);
      }

      case "ConditionalExpression": {
        const n = node as t.ConditionalExpression;
        const elseLabel = this._makeLabel("ternary_else");
        const endLabel = this._makeLabel("ternary_end");

        // Compile test; free its temps after the jump is emitted.
        const baseTop = ctx.regTop;
        const testReg = this._compileExpr(n.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, testReg, { type: "label", label: elseLabel }],
          node,
        );
        ctx.regTop = baseTop; // free test temps

        // Reserve reg_result at the base of the temp space.
        const reg_result = ctx.allocReg();

        // Consequent branch.
        const consReg = this._compileExpr(n.consequent, scope, bc);
        if (consReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, consReg], node);
        this.emit(bc, [this.OP.JUMP, { type: "label", label: endLabel }], node);

        // Alternate branch: reset to baseTop then re-reserve reg_result.
        this.emit(bc, [null, { type: "defineLabel", label: elseLabel }], node);
        ctx.regTop = baseTop;
        ctx.allocReg(); // re-occupy reg_result slot
        const altReg = this._compileExpr(n.alternate, scope, bc);
        if (altReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, altReg], node);

        this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);

        // Leave reg_result allocated above baseTop.
        ctx.regTop = baseTop + 1;
        return reg_result;
      }

      case "LogicalExpression": {
        const n = node as t.LogicalExpression;
        const endLabel = this._makeLabel("logical_end");
        const isOr = n.operator === "||";
        if (!isOr && n.operator !== "&&")
          throw new Error(`Unsupported logical operator: ${n.operator}`);

        const baseTop = ctx.regTop;
        const lhsReg = this._compileExpr(n.left, scope, bc);
        ctx.regTop = baseTop;
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
        ctx.regTop = baseTop;
        ctx.allocReg(); // re-occupy reg_result
        const rhsReg = this._compileExpr(n.right, scope, bc);
        if (rhsReg !== reg_result)
          this.emit(bc, [this.OP.MOVE, reg_result, rhsReg], node);

        this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);

        ctx.regTop = baseTop + 1;
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
        const applyBump = (curReg: number): [number, number] => {
          const postfixReg = n.prefix
            ? -1
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
          let keyReg: number;
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

        let curReg: number;
        if (res.kind === "local") {
          curReg = res.slot;
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
          this.emit(bc, [this.OP.MOVE, res.slot, newReg], node as t.Node);
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

          let keyReg: number;
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

          let valReg: number;
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

        let rhsReg: number;
        if (isCompound) {
          // Load current value of the variable.
          let curReg: number;
          if (res.kind === "local") {
            curReg = res.slot;
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
          if (rhsReg !== res.slot)
            this.emit(bc, [this.OP.MOVE, res.slot, rhsReg], node);
          return res.slot;
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

        if (n.callee.type === "MemberExpression") {
          // Method call: receiver.method(args)
          const receiverReg = this._compileExpr(n.callee.object, scope, bc);

          let methodKeyReg: number;
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

          const argRegs = n.arguments.map((a) =>
            this._compileExpr(a as t.Expression, scope, bc),
          );
          const dst = ctx.allocReg();
          this.emit(
            bc,
            [
              this.OP.CALL_METHOD,
              dst,
              receiverReg,
              calleeReg,
              n.arguments.length,
              ...argRegs,
            ],
            node,
          );
          return dst;
        } else {
          // Plain call: fn(args)
          const calleeReg = this._compileExpr(
            n.callee as t.Expression,
            scope,
            bc,
          );
          const argRegs = n.arguments.map((a) =>
            this._compileExpr(a as t.Expression, scope, bc),
          );
          const dst = ctx.allocReg();
          this.emit(
            bc,
            [this.OP.CALL, dst, calleeReg, n.arguments.length, ...argRegs],
            node,
          );
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
            let keyReg: number;
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
        let keyReg: number;
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
        const regularProps: t.ObjectProperty[] = [];
        const accessorProps: t.ObjectMethod[] = [];

        for (const prop of n.properties) {
          if (prop.type === "SpreadElement")
            throw new Error("Object spread not supported");
          if (prop.type === "ObjectMethod") {
            if (prop.kind === "get" || prop.kind === "set") {
              if (prop.computed)
                throw new Error(
                  "Computed getter/setter keys are not supported",
                );
              accessorProps.push(prop);
            } else {
              throw new Error("Shorthand method syntax is not supported");
            }
          } else {
            regularProps.push(prop as t.ObjectProperty);
          }
        }

        // Build flat [key, val, key, val, …] register list.
        const pairRegs: number[] = [];
        for (const prop of regularProps) {
          let keyStr: string;
          const key = prop.key;
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

        // Define accessors on the object now sitting in `dst`.
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

      default: {
        throw new Error(`Unsupported expression: ${(node as any).type}`);
      }
    }
  }
}

// ── Serializer ────────────────────────────────────────────────────────────────
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
    // String: base64 → u16 LE byte pairs → XOR with (key + i) (mirrors _readConstant)
    const bytes = Buffer.from(v as string, "base64");
    let out = "";
    for (let i = 0; i < bytes.length / 2; i++) {
      const code = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
      out += String.fromCharCode(code ^ ((key + i) & 0xffff));
    }
    return out;
  }

  _serializeInstr(instr: b.Instruction): { text: string; values: number[] } {
    const op = instr[0] as number;
    const operands = instr.slice(1) as number[];

    const constants = this.compiler.constants;

    const resolvedOperands = operands
      .filter((operand) => (operand as any)?.placeholder !== true)
      .map((o) => (o as any)?.resolvedValue ?? o);

    for (const o of resolvedOperands) {
      ok(typeof o === "number", "Unresolved operand: " + JSON.stringify(o));
      ok(o >= 0 && o <= 0xffff, `Operand overflow (max 0xFFFF u16): ${o}`);
    }
    ok(op >= 0 && op <= 0xffff, `Opcode overflow (max 0xFFFF u16): ${op}`);

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

    if (resolvedOperands.length > 0) {
      // Operand[0] is always `dst` for instruction types that produce a value.
      const dst = resolvedOperands[0];

      switch (op) {
        case this.OP.LOAD_CONST: {
          // resolvedOperands: [dst, constIdx, concealKey]
          const val = this._decryptConst(
            constants,
            resolvedOperands[1],
            resolvedOperands[2],
          );
          comment += `  reg[${dst}] = ${this._serializeConst(val)}`;
          break;
        }
        case this.OP.LOAD_GLOBAL:
          // resolvedOperands: [dst, constIdx, concealKey]
          comment += `  reg[${dst}] = ${this._decryptConst(constants, resolvedOperands[1], resolvedOperands[2])}`;
          break;
        case this.OP.STORE_GLOBAL:
          // resolvedOperands: [constIdx, concealKey, srcReg]
          comment += `  ${this._decryptConst(constants, resolvedOperands[0], resolvedOperands[1])} = reg[${resolvedOperands[2]}]`;
          break;
        case this.OP.LOAD_UPVALUE:
          comment += `  reg[${dst}] = upvalue[${resolvedOperands[1]}]`;
          break;
        case this.OP.STORE_UPVALUE:
          comment += `  upvalue[${resolvedOperands[0]}] = reg[${resolvedOperands[1]}]`;
          break;
        case this.OP.MOVE:
          comment += `  reg[${dst}] = reg[${resolvedOperands[1]}]`;
          break;
        case this.OP.MAKE_CLOSURE:
          comment += `  reg[${dst}] PC=${resolvedOperands[1]} (params=${resolvedOperands[2]} regs=${resolvedOperands[3]} upvalues=${resolvedOperands[4]})`;
          break;
        case this.OP.CALL:
          comment += `  reg[${dst}] = reg[${resolvedOperands[1]}](${resolvedOperands[2]} args)`;
          break;
        case this.OP.CALL_METHOD:
          comment += `  reg[${dst}] = reg[${resolvedOperands[2]}](recv=reg[${resolvedOperands[1]}], ${resolvedOperands[3]} args)`;
          break;
        case this.OP.NEW:
          comment += `  reg[${dst}] = new reg[${resolvedOperands[1]}](${resolvedOperands[2]} args)`;
          break;
        case this.OP.RETURN:
          comment += `  reg[${resolvedOperands[0]}]`;
          break;
        case this.OP.BUILD_ARRAY:
          comment += `  reg[${dst}] = [${resolvedOperands[2]} elems]`;
          break;
        case this.OP.BUILD_OBJECT:
          comment += `  reg[${dst}] = {${resolvedOperands[1]} pairs}`;
          break;
        case this.OP.GET_PROP:
          comment += `  reg[${dst}] = reg[${resolvedOperands[1]}][reg[${resolvedOperands[2]}]]`;
          break;
        case this.OP.SET_PROP:
          comment += `  reg[${resolvedOperands[0]}][reg[${resolvedOperands[1]}]] = reg[${resolvedOperands[2]}]`;
          break;

        default:
          comment +=
            resolvedOperands.length === 1
              ? `  ${resolvedOperands[0]}`
              : `  [${resolvedOperands.join(", ")}]`;
      }
    }

    comment = comment.padEnd(50) + sourceLocation;

    const values = [op, ...resolvedOperands];
    const instrText = `[${values.join(", ")}]`;
    const text = `${(instrText + ",").padEnd(20)} ${comment}`;

    return { text, values };
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
      if (instr[0] === null) continue;

      const specializedOpInfo = compiler.SPECIALIZED_OPS[instr[0]];
      if (specializedOpInfo) {
        const operands = instr.slice(1);

        const resolvedValues = operands.map(
          (o) => (o as any)?.resolvedValue ?? o,
        );
        const originalName = compiler.OP_NAME[specializedOpInfo.originalOp];
        compiler.OP_NAME[instr[0]] =
          `${originalName}_${resolvedValues.join("_")}`;
      }

      serialized.push(instr);
    }
    return { bytecode: serialized };
  }

  _encodeBytecode(flat: number[]) {
    const buf = new Uint8Array(flat.length * 2);
    flat.forEach((w, i) => {
      buf[i * 2] = w & 0xff;
      buf[i * 2 + 1] = (w >>> 8) & 0xff;
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

    initBody.push(this._serializeConstants(constants));

    sections = [...initBody, ...sections];
    sections.push(VM_RUNTIME);

    return sections.join("\n\n");
  }
}

export async function compileAndSerialize(
  sourceCode: string,
  options: Options,
) {
  const compiler = new Compiler(options);
  let bytecode = compiler.compile(sourceCode);

  const passes = [];

  passes.push(concealConstants);

  if (options.specializedOpcodes) {
    passes.push(specializedOpcodes);
  }

  if (options.microOpcodes) {
    passes.push(microOpcodes);
  }

  if (options.macroOpcodes) {
    passes.push(macroOpcodes);
  }

  if (options.selfModifying) {
    passes.push(selfModifying);
  }

  if (options.aliasedOpcodes) {
    passes.push(aliasedOpcodes);
  }

  for (const pass of passes) {
    const passResult = pass(bytecode, compiler);
    bytecode = passResult.bytecode;
  }

  // Resolve label references to flat bytecode indices.
  const labelsResult = resolveLabels(bytecode, compiler);
  bytecode = labelsResult.bytecode;

  // Set mainStartPc from the first function descriptor (or 0 for top-level start).
  compiler.mainStartPc = compiler.mainFn.startPc;

  // Resolve constant references to pool indices (+ conceal key operand).
  const constResult = resolveConstants(bytecode, compiler);
  bytecode = constResult.bytecode;
  compiler.constants = constResult.constants;

  // Build and obfuscate the runtime.
  const runtimeSource = compiler.serializer.serialize(
    bytecode,
    constResult.constants,
    compiler,
  );

  // This part was purposefully pulled out Serializer as OP_NAME's get resolved during obfuscateRuntime
  // So for the most useful comments, it's ran absolutely last
  // Tests also rely on correct comments so it's required
  const generateBytecodeComment = () => {
    var lines = [];
    for (const instr of bytecode) {
      const serialized = compiler.serializer._serializeInstr(instr);
      lines.push("// " + serialized.text);
    }

    return lines.join("\n");
  };

  const code = await obfuscateRuntime(
    runtimeSource,
    bytecode,
    options,
    compiler,
    generateBytecodeComment,
  );

  return { code };
}
