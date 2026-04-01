import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { generate } from "@babel/generator";

import { readFileSync } from "fs";
import { join } from "path";
import { stripTypeScriptTypes } from "module";
import * as t from "@babel/types";
import { ok } from "assert";
import { obfuscateRuntime } from "./build-runtime.ts";
import { DEFAULT_OPTIONS, type Options } from "./options.ts";
import { resolveLabels } from "./transforms/bytecode/resolveLabels.ts";
import { resolveConstants } from "./transforms/bytecode/resolveContants.ts";
import { selfModifying } from "./transforms/bytecode/selfModifying.ts";
import { macroOpcodes } from "./transforms/bytecode/macroOpcodes.ts";
import * as b from "./types.ts";
import { specializedOpcodes } from "./transforms/bytecode/specializedOpcodes.ts";
import { getRandomInt } from "./transforms/utils/random-utils.ts";
import { U16_MAX } from "./transforms/utils/op-utils.ts";

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
export const SOURCE_NODE_SYM = Symbol("SOURCE_NODE"); // Attach source node location to pseudo bytecode instructions

// Opcodes
export const OP_ORIGINAL = {
  LOAD_CONST: 0,
  LOAD_LOCAL: 1,
  STORE_LOCAL: 2,
  LOAD_GLOBAL: 3,
  STORE_GLOBAL: 4,
  GET_PROP: 5,
  ADD: 6, // a + b (both are popped)
  SUB: 7, // a - b
  MUL: 8, // a * b
  DIV: 9, // a / b
  MAKE_CLOSURE: 10,
  CALL: 11,
  CALL_METHOD: 12,
  RETURN: 13,
  POP: 14, // discard top of stack
  LT: 15, // pop b, pop a -> push (a < b)
  GT: 16, // pop b, pop a -> push (a > b)
  EQ: 17, // pop b, pop a -> push (a === b)
  JUMP: 18, // unconditional - operand = absolute bytecode index
  JUMP_IF_FALSE: 19, // pop value; jump if falsy
  LTE: 20, // a <= b
  GTE: 21, // a >= b
  NEQ: 22, // a !== b
  LOAD_UPVALUE: 23, // push frame.closure.upvalues[operand].read()
  STORE_UPVALUE: 24, // frame.closure.upvalues[operand].write(pop())

  //  Unary
  UNARY_NEG: 25, // -x
  UNARY_POS: 26, // +x
  UNARY_NOT: 27, // !x
  UNARY_BITNOT: 28, // ~x
  TYPEOF: 29, // typeof x
  VOID: 30, // void x  -> always undefined

  TYPEOF_SAFE: 31, // operand = name constIdx - typeof guard for undeclared globals
  BUILD_ARRAY: 32, // operand = element count - pops N values -> pushes array
  BUILD_OBJECT: 33, // operand = pair count   - pops N*2 (key,val) -> pushes object
  SET_PROP: 34, // pop val, pop key, peek obj -> obj[key] = val (obj stays on stack)
  GET_PROP_COMPUTED: 35, // pop key, peek obj -> push obj[key]  (computed: nums[i])

  MOD: 36, // a % b
  BAND: 37, // a & b
  BOR: 38, // a | b
  BXOR: 39, // a ^ b
  SHL: 40, // a << b
  SHR: 41, // a >> b
  USHR: 42, // a >>> b

  JUMP_IF_FALSE_OR_POP: 43, // && - if top falsy:  jump (keep), else: pop, eval RHS
  JUMP_IF_TRUE_OR_POP: 44, // || - if top truthy: jump (keep), else: pop, eval RHS

  DELETE_PROP: 45,
  IN: 46, // a in b
  INSTANCEOF: 47, // a instanceof b

  // NEW
  LOAD_THIS: 48, // push frame.thisVal
  NEW: 49, // operand = argCount - construct a new object
  DUP: 50, // duplicate top of stack
  THROW: 51, // pop value, throw it
  LOOSE_EQ: 52, // a == b  (abstract equality)
  LOOSE_NEQ: 53, // a != b  (abstract inequality)

  FOR_IN_SETUP: 54, // pop obj -> build enumerable-key iterator -> push {keys,i}
  FOR_IN_NEXT: 55, // operand=exit_pc; pop iter; if done->jump; else push next key

  // Self-modifying bytecode
  PATCH: 56, // pop destPc; constants[operand]=word[]; write words into bytecode[destPc..]

  // Try-Catch
  TRY_SETUP: 57, // operand = catch_pc; push exception handler onto frame._handlerStack
  TRY_END: 58, // pop exception handler (normal exit from try body)

  // Getter / Setter (ES5 object literal accessor syntax)
  DEFINE_GETTER: 59, // pop fn, pop key, pop obj -> Object.defineProperty(obj, key, {get: fn})
  DEFINE_SETTER: 60, // pop fn, pop key, pop obj -> Object.defineProperty(obj, key, {set: fn})

  DEBUGGER: 61, // emits a "debugger" statement

  // Push the raw integer operand directly onto the stack (no constant pool lookup).
  // Identical pipeline to JUMP ops: {type:"label"} pseudo-operands resolve to a
  // raw PC number that becomes the operand, which is pushed as-is at runtime.
  LOAD_INT: 62,
};

// Scope
// Each function call gets its own Scope. Locals are resolved to
// numeric slots at compile time -- zero name lookups at runtime.
class Scope {
  parent: Scope | null;
  _locals: Map<string, number>;
  _next: number;

  constructor(parent = null) {
    this.parent = parent;
    this._locals = new Map(); // name -> slot index
    this._next = 0;
  }

  define(name) {
    if (!this._locals.has(name)) {
      this._locals.set(name, this._next++);
    }
    return this._locals.get(name);
  }

  // Walk up scope chain. If we fall off the top -> global.
  resolve(name) {
    if (this._locals.has(name)) {
      return { kind: "local", slot: this._locals.get(name) };
    }
    if (this.parent) return this.parent.resolve(name);
    return { kind: "global" };
  }

  get localCount() {
    return this._next;
  }
}

// FnContext
// Compiler-side state for the function currently being compiled.
// Distinct from runtime Frame -- this is compile-time only.
class FnContext {
  upvalues: { name: string; isLocal: number; index: number }[];
  parentCtx: FnContext | null;
  scope: Scope;
  compiler: Compiler;
  bc: b.Instruction[];

  constructor(compiler, parentCtx = null) {
    this.compiler = compiler;
    this.parentCtx = parentCtx;
    this.scope = new Scope();

    this.bc = [];
    this.upvalues = []; // { name, isLocal, index }
  }

  // Find or register a captured variable as an upvalue.
  // isLocal=true  -> captured directly from parent's locals[index]
  // isLocal=false -> relayed from parent's own upvalue list[index]
  addUpvalue(name, isLocal, index) {
    const existing = this.upvalues.findIndex((u) => u.name === name);
    if (existing !== -1) return existing;
    const idx = this.upvalues.length;
    this.upvalues.push({ name, isLocal, index: index });
    return idx;
  }
}

// Compiler
export class Compiler {
  fnDescriptors: any[];
  bytecode: b.Bytecode;
  mainStartPc: number;

  _currentCtx: FnContext | null;
  _pendingLabel: string | null;
  _forInCount: number;
  _labelCount: number;
  _loopStack: {
    type: "loop" | "switch" | "block";
    label: string | null;
    // Label that break statements targeting this entry should jump to.
    breakLabel: string;
    // Label that continue statements targeting this entry should jump to.
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
      operand: b.InstrOperand;
      resolvedOperand?: b.InstrOperand;
    }
  >;

  OP_NAME: Record<number, string>;
  JUMP_OPS: Set<number>;

  emit(bc: b.Bytecode, instr: b.Instruction, node: t.Node) {
    bc.push(instr);

    instr[SOURCE_NODE_SYM] = node;
  }

  // DO NOT USE THIS KEY UNLESS YOU ARE "RESOLVE CONSTANTS"
  // CONSTANTS DURING COMPILATION MUST BE USED BY REFERENCE WITH b.constantOperand("myConstantHere")
  constants: any[];

  constructor(options: Options = DEFAULT_OPTIONS) {
    this.options = options;
    this.fnDescriptors = []; // populated in pass 1
    this.bytecode = [];
    this.mainStartPc = 0;
    this._currentCtx = null; // FnContext of the function being compiled, null at top-level
    this._loopStack = []; // per active loop/switch/block/try
    this._pendingLabel = null;
    this._forInCount = 0; // counter for synthetic for-in iterator global names
    this._labelCount = 0; // monotonically increasing counter for unique label names

    this.serializer = new Serializer(this);
    this.MACRO_OPS = {};
    this.SPECIALIZED_OPS = {};

    this.OP = { ...OP_ORIGINAL };

    // Construct randomized opcode mapping
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

    // Reverse map for comment generation
    this.OP_NAME = Object.fromEntries(
      Object.entries(this.OP).map(([k, v]) => [v, k]),
    );

    this.JUMP_OPS = new Set([
      this.OP.JUMP,
      this.OP.JUMP_IF_FALSE,
      this.OP.JUMP_IF_TRUE_OR_POP,
      this.OP.JUMP_IF_FALSE_OR_POP,
      this.OP.FOR_IN_NEXT,
      this.OP.TRY_SETUP, // catch_pc operand needs offset adjustment like jump targets
    ]);
  }

  // Generate a globally unique label string with an optional hint for readability.
  _makeLabel(hint = ""): string {
    var id = this._labelCount++;
    return `${hint || "L"}_${id}`;
  }

  // Variable resolution
  // Walks up the FnContext chain. Crossing a context boundary means
  // we're capturing from an outer function - register an upvalue.
  _resolve(name, ctx) {
    if (!ctx) return { kind: "global" };

    // 1. Own locals
    if (ctx.scope._locals.has(name)) {
      return { kind: "local", slot: ctx.scope._locals.get(name) };
    }

    // 2. No parent context -> must be global
    if (!ctx.parentCtx) return { kind: "global" };

    // 3. Ask parent -- recurse up the chain
    const parentResult = this._resolve(name, ctx.parentCtx);
    if (parentResult.kind === "global") return { kind: "global" };

    // 4. Parent has it (as local or upvalue) -- register an upvalue here.
    //    isLocal=true means "take it straight from parent's locals[index]"
    //    isLocal=false means "relay parent's upvalue[index]" (multi-level capture)
    const isLocal = parentResult.kind === "local";
    const index = isLocal ? parentResult.slot : parentResult.index;
    const uvIdx = ctx.addUpvalue(name, isLocal, index);
    return { kind: "upvalue", index: uvIdx };
  }

  // Entry point
  compile(source: string) {
    const ast = parse(source, { sourceType: "script" });

    return this.compileAST(ast);
  }

  compileAST(ast: t.File) {
    // Pass 1 - compile every FunctionDeclaration into a descriptor.
    //           Traverse finds them regardless of nesting depth.
    traverse(ast, {
      FunctionDeclaration: (path) => {
        // Only handle top-level functions for this MVP.
        // (Parent is Program node)
        if (path.parent.type !== "Program") return;
        this._compileFunctionDecl(path.node);
        path.skip(); // don't recurse into nested functions
      },
    });

    // Pass 2 -- compile top-level statements into BYTECODE.
    this._compileMain(ast.program.body);

    return this.bytecode;
  }

  // Function Declaration

  _compileFunctionDecl(node: t.FunctionDeclaration | t.FunctionExpression) {
    // Reserve a slot in fnDescriptors NOW, before compiling the body, so that
    // any nested _compileFunctionDecl calls see the correct .length and get a
    // distinct _fnIdx.  The placeholder object is mutated in-place below once
    // the body and header are ready.
    var fnIdx = this.fnDescriptors.length;
    const entryLabel = this._makeLabel(`fn_${fnIdx}`);
    var desc: any = {}; // placeholder — filled in after compilation
    this.fnDescriptors.push(desc);

    // Create a context whose parent is whatever we're currently compiling.
    // This is what lets _resolve cross function boundaries correctly.
    const ctx = new FnContext(this, this._currentCtx);
    const savedCtx = this._currentCtx;
    this._currentCtx = ctx;

    // Isolate the loop stack so that try/loop entries from the outer scope
    // don't cause spurious TRY_END / extra jumps inside this function body.
    const savedLoopStack = this._loopStack;
    this._loopStack = [];

    // Params occupy the first N local slots (args are copied in on CALL)
    for (const param of node.params) {
      let identifier = param.type === "AssignmentPattern" ? param.left : param;
      ok(
        identifier.type === "Identifier",
        "Only simple identifiers allowed as parameters",
      );

      ctx.scope.define(identifier.name);
    }

    // Reserve the next slot for the implicit `arguments` object.
    // Slot index will always equal paramCount (params are 0..paramCount-1).
    ctx.scope.define("arguments");

    // Pass 2: emit default-value guards at top of fn body
    // Mirrors what JS engines do: if the caller passed undefined (or
    // nothing), evaluate the default expression and overwrite the slot.
    for (const param of node.params) {
      if (param.type !== "AssignmentPattern") continue;

      const slot = ctx.scope._locals.get((param.left as t.Identifier).name);
      const skipLabel = this._makeLabel("param_skip");

      // if (param === undefined) param = <default expr>
      this.emit(ctx.bc, [this.OP.LOAD_LOCAL, slot], param);
      this.emit(
        ctx.bc,
        [this.OP.LOAD_CONST, b.constantOperand(undefined)],
        param,
      );
      this.emit(ctx.bc, [this.OP.EQ], param);
      this.emit(
        ctx.bc,
        [this.OP.JUMP_IF_FALSE, { type: "label", label: skipLabel }],
        param,
      );

      this._compileExpr(param.right, ctx.scope, ctx.bc); // eval default
      this.emit(ctx.bc, [this.OP.STORE_LOCAL, slot], param);

      this.emit(
        ctx.bc,
        [null, { type: "defineLabel", label: skipLabel }],
        param,
      );
    }

    for (const stmt of node.body.body) {
      this._compileStatement(stmt, ctx.scope, ctx.bc);
    }

    // If we fall off the end of the function, implicitly return undefined.
    this.emit(ctx.bc, [this.OP.LOAD_CONST, b.constantOperand(undefined)], node);
    this.emit(ctx.bc, [this.OP.RETURN], node);

    this._currentCtx = savedCtx; // restore before touching fnDescriptors
    this._loopStack = savedLoopStack;

    (node as any)._fnIdx = fnIdx;

    // Fill the placeholder that was reserved at the top of this function.
    // Metadata (paramCount, localCount, upvalues) is stored on desc and emitted
    // as inline operands on the MAKE_CLOSURE instruction via _emitMakeClosure.
    desc.name = node.id?.name || "<anonymous>";
    desc.entryLabel = entryLabel;
    desc.bytecode = ctx.bc as b.Bytecode;
    desc._fnIdx = fnIdx;
    desc.paramCount = node.params.length;
    desc.localCount = ctx.scope.localCount;
    desc.upvalues = ctx.upvalues.slice();

    return desc;
  }

  // Emit a single MAKE_CLOSURE instruction with all closure metadata packed
  // as inline operands.  The runtime reads them via _operand() — no stack
  // shuffling needed.
  //
  // Flat operand layout:  startPc, paramCount, localCount, uvCount,
  //                       [isLocal_0, idx_0, isLocal_1, idx_1, ...]
  _emitMakeClosure(desc: any, node: t.Node, bc: b.Bytecode) {
    const uvOperands: (number | b.InstrOperand)[] = [];
    for (const uv of desc.upvalues) {
      uvOperands.push(uv.isLocal ? 1 : 0);
      uvOperands.push(uv.index);
    }
    this.emit(
      bc,
      [
        this.OP.MAKE_CLOSURE,
        { type: "label", label: desc.entryLabel },
        desc.paramCount,
        desc.localCount,
        desc.upvalues.length,
        ...uvOperands,
      ] as b.Instruction,
      node,
    );
  }

  // Main (top-level)
  _compileMain(body: t.Statement[]) {
    const bc = this.bytecode;

    // Hoist all FunctionDeclarations: MAKE_CLOSURE -> STORE_GLOBAL
    // (mirrors JS hoisting -- functions are available before other code)
    for (const node of body) {
      if (node.type !== "FunctionDeclaration") continue;
      const desc = this.fnDescriptors.find(
        (d) => d._fnIdx === (node as any)._fnIdx,
      );
      const nameRef = b.constantOperand(node.id.name);
      this._emitMakeClosure(desc, node, bc);
      this.emit(bc, [this.OP.STORE_GLOBAL, nameRef], node);
    }

    // Compile everything else in order
    for (const node of body) {
      if (node.type === "FunctionDeclaration") continue;
      this._compileStatement(node, null, bc); // null scope -> global context
    }

    this.emit(bc, [this.OP.RETURN], null); // end program

    // Append all function bodies. Each function's entryLabel (already generated
    // in _compileFunctionDecl) points directly to the first body instruction;
    // metadata is pushed onto the stack at each call site, not stored inline.
    for (const descriptor of this.fnDescriptors) {
      this.bytecode.push([
        null,
        { type: "defineLabel", label: descriptor.entryLabel },
      ]);
      for (const instr of descriptor.bytecode) {
        this.bytecode.push(instr);
      }
    }
  }

  // Statements
  _compileStatement(node: t.Statement, scope: Scope, bc: b.Bytecode) {
    switch (node.type) {
      case "EmptyStatement": {
        // nothing to emit -- bare semicolon is a no-op
        break;
      }

      case "DebuggerStatement":
        this.emit(bc, [this.OP.DEBUGGER], node);
        break;

      case "BlockStatement": {
        for (const stmt of node.body) {
          this._compileStatement(stmt, scope, bc);
        }
        break;
      }

      case "FunctionDeclaration": {
        // Nested function -- compile it into a descriptor, then emit
        // MAKE_CLOSURE so it's captured as a live closure at runtime.
        // (_compileFunctionDecl pushes/pops _currentCtx internally)
        const desc = this._compileFunctionDecl(node);
        this._emitMakeClosure(desc, node, bc);
        if (scope) {
          const slot = scope.define(node.id.name);
          this.emit(bc, [this.OP.STORE_LOCAL, slot], node);
        } else {
          this.emit(
            bc,
            [this.OP.STORE_GLOBAL, b.constantOperand(node.id.name)],
            node,
          );
        }
        break;
      }

      case "ThrowStatement": {
        this._compileExpr(node.argument, scope, bc);
        this.emit(bc, [this.OP.THROW], node);
        break;
      }

      case "ReturnStatement": {
        if (node.argument) {
          this._compileExpr(node.argument, scope, bc);
        } else {
          this.emit(
            bc,
            [this.OP.LOAD_CONST, b.constantOperand(undefined)],
            node,
          );
        }
        // Disarm any open try handlers before leaving the function.
        // TRY_END only touches frame._handlerStack, not the value stack,
        // so the return value sitting on top is safe.
        for (let _ri = this._loopStack.length - 1; _ri >= 0; _ri--) {
          if ((this._loopStack[_ri].type as any) === "try") {
            this.emit(bc, [this.OP.TRY_END], node);
          }
        }
        this.emit(bc, [this.OP.RETURN], node);
        break;
      }

      case "ExpressionStatement": {
        this._compileExpr(node.expression, scope, bc);
        this.emit(bc, [this.OP.POP], node); // discard return value of statement-level expressions
        break;
      }

      case "VariableDeclaration": {
        for (const decl of node.declarations) {
          // Push the initialiser (or undefined if absent)
          if (decl.init) {
            this._compileExpr(decl.init, scope, bc);
          } else {
            this.emit(
              bc,
              [this.OP.LOAD_CONST, b.constantOperand(undefined)],
              node,
            );
          }

          ok(
            decl.id.type === "Identifier",
            "Only simple identifiers can be declared",
          );

          // Store: local slot if inside a function, global name otherwise
          if (scope) {
            const slot = scope.define(decl.id.name);
            this.emit(bc, [this.OP.STORE_LOCAL, slot], node);
          } else {
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(decl.id.name)],
              node,
            );
          }
        }
        break;
      }

      case "IfStatement": {
        const elseOrEndLabel = this._makeLabel("if_else");
        // 1. Compile the test expression -> leaves a value on the stack
        this._compileExpr(node.test, scope, bc);
        // 2. Emit JUMP_IF_FALSE to the else branch (or end if no else)
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, { type: "label", label: elseOrEndLabel }],
          node,
        );
        // 3. Compile the consequent block (the "then" branch)
        const consequentBody =
          node.consequent.type === "BlockStatement"
            ? node.consequent.body
            : [node.consequent];
        for (const stmt of consequentBody) {
          this._compileStatement(stmt, scope, bc);
        }
        if (node.alternate) {
          // 4a. Consequent needs to jump OVER the else block when done
          const endLabel = this._makeLabel("if_end");
          this.emit(
            bc,
            [this.OP.JUMP, { type: "label", label: endLabel }],
            node,
          );
          // Mark start of else
          this.emit(
            bc,
            [null, { type: "defineLabel", label: elseOrEndLabel }],
            node,
          );
          // 5. Compile the alternate (else) block
          const altBody =
            node.alternate.type === "BlockStatement"
              ? node.alternate.body
              : [node.alternate]; // handles `else if` -- it's just a nested IfStatement
          for (const stmt of altBody) {
            this._compileStatement(stmt, scope, bc);
          }
          // Mark end (consequent's jump lands here)
          this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        } else {
          // 4b. No else -- label lands right after the then block
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
          continueLabel: loopTopLabel, // continue re-evaluates the test
        });

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );
        this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, { type: "label", label: exitLabel }],
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
          continueLabel: continueLabel, // continue falls to the test
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

        // continue -> skip rest of body, fall through to test
        this.emit(
          bc,
          [null, { type: "defineLabel", label: continueLabel }],
          node,
        );
        this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, { type: "label", label: exitLabel }],
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
        // continue jumps to the update clause if present, else straight to test
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
            this._compileExpr(node.init, scope, bc);
            this.emit(bc, [this.OP.POP], node);
          }
        }

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );
        if (node.test) {
          this._compileExpr(node.test, scope, bc);
          this.emit(
            bc,
            [this.OP.JUMP_IF_FALSE, { type: "label", label: exitLabel }],
            node,
          );
        }

        const forBody =
          node.body.type === "BlockStatement" ? node.body.body : [node.body];
        for (const stmt of forBody) {
          this._compileStatement(stmt, scope, bc);
        }

        // continue -> run update (if any) then back to test
        if (node.update) {
          this.emit(
            bc,
            [null, { type: "defineLabel", label: updateLabel }],
            node,
          );
          this._compileExpr(node.update, scope, bc);
          this.emit(bc, [this.OP.POP], node);
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
        // Find the jump target in the loop stack.
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
          // Find innermost loop/switch/block (skip "try" entries)
          for (let _bi = this._loopStack.length - 1; _bi >= 0; _bi--) {
            if ((this._loopStack[_bi].type as any) !== "try") {
              _bTargetIdx = _bi;
              break;
            }
          }
          if (_bTargetIdx === -1) throw new Error("break outside loop");
        }
        // Emit TRY_END for every open try block between here and the target.
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
        // Find the target loop in the loop stack.
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
          // Find the innermost loop (skip switch, block, and try contexts)
          for (let _ci = this._loopStack.length - 1; _ci >= 0; _ci--) {
            if (this._loopStack[_ci].type === "loop") {
              _cTargetIdx = _ci;
              break;
            }
          }
          if (_cTargetIdx === -1) throw new Error("continue outside loop");
        }
        // Emit TRY_END for every open try block between here and the target loop.
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
          continueLabel: switchBreakLabel, // not used for switch
        });

        // Compile the discriminant and leave it on the stack
        this._compileExpr(node.discriminant, scope, bc);

        const cases = node.cases;
        const defaultIdx = cases.findIndex((c) => c.test === null);

        // Pre-allocate a label for each case body so dispatch can reference them
        const caseLabels = cases.map((_, i) => this._makeLabel(`sw_case_${i}`));

        // Dispatch section: for each non-default case, check and jump to its body
        for (let i = 0; i < cases.length; i++) {
          const cas = cases[i];
          if (cas.test === null) continue; // skip default in dispatch

          const nextCheckLabel = this._makeLabel("sw_next");
          this.emit(bc, [this.OP.DUP], node);
          this._compileExpr(cas.test, scope, bc);
          this.emit(bc, [this.OP.EQ], node);
          // If not matched, fall through to the next check
          this.emit(
            bc,
            [this.OP.JUMP_IF_FALSE, { type: "label", label: nextCheckLabel }],
            node,
          );
          // If matched, jump directly to this case's body
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

        // No case matched: jump to default body or exit (which pops discriminant)
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

        // Body section: compile all case bodies in source order (fallthrough intact)
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

        // break label lands here; pop the discriminant and continue after switch
        this.emit(
          bc,
          [null, { type: "defineLabel", label: switchBreakLabel }],
          node,
        );
        this.emit(bc, [this.OP.POP], node);

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
          // Pass label down to the loop/switch handler via _pendingLabel
          this._pendingLabel = _lName;
          this._compileStatement(_lBody, scope, bc);
          this._pendingLabel = null; // safety clear if handler didn't consume it
        } else {
          // Non-loop labeled statement (e.g. labeled block) -- only break is valid
          const blockBreakLabel = this._makeLabel("block_break");
          this._loopStack.push({
            type: "block",
            label: _lName,
            breakLabel: blockBreakLabel,
            continueLabel: blockBreakLabel, // unused
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

        // Evaluate the object expression -> on stack
        this._compileExpr(node.right, scope, bc);
        // FOR_IN_SETUP: pops obj, pushes iterator {keys, i}
        this.emit(bc, [this.OP.FOR_IN_SETUP], node);

        // Store iterator in a hidden slot so break/continue need no cleanup
        let emitLoadIter: () => void;
        let emitStoreIter: () => void;
        if (scope) {
          // Reserve a hidden local slot (no name mapping needed)
          const iterSlot = scope._next++;
          emitLoadIter = () =>
            this.emit(bc, [this.OP.LOAD_LOCAL, iterSlot], node);
          emitStoreIter = () =>
            this.emit(bc, [this.OP.STORE_LOCAL, iterSlot], node);
        } else {
          // Top level -- use a synthetic global that won't collide with user code
          const iterNameIdx = b.constantOperand("__fi" + this._forInCount++);
          emitLoadIter = () =>
            this.emit(bc, [this.OP.LOAD_GLOBAL, iterNameIdx], node);
          emitStoreIter = () =>
            this.emit(bc, [this.OP.STORE_GLOBAL, iterNameIdx], node);
        }
        emitStoreIter();

        const loopTopLabel = this._makeLabel("forin_top");
        const exitLabel = this._makeLabel("forin_exit");

        this._loopStack.push({
          type: "loop",
          label: _fiLabel,
          breakLabel: exitLabel,
          continueLabel: loopTopLabel, // continue re-checks the iterator
        });

        this.emit(
          bc,
          [null, { type: "defineLabel", label: loopTopLabel }],
          node,
        );

        // Load iterator, attempt to get next key
        emitLoadIter();
        this.emit(
          bc,
          [this.OP.FOR_IN_NEXT, { type: "label", label: exitLabel }],
          node,
        );

        // Assign the key (now on top of stack) to the loop variable
        if (node.left.type === "VariableDeclaration") {
          const identifier = node.left.declarations[0].id;
          ok(
            identifier.type === "Identifier",
            "Only simple identifiers can be declared in for-in loops",
          );
          const name = identifier.name;
          if (scope) {
            const slot = scope.define(name);
            this.emit(bc, [this.OP.STORE_LOCAL, slot], node);
          } else {
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(name)],
              node,
            );
          }
        } else if (node.left.type === "Identifier") {
          const res = this._resolve(node.left.name, this._currentCtx);
          if (res.kind === "local") {
            this.emit(bc, [this.OP.STORE_LOCAL, res.slot], node);
          } else if (res.kind === "upvalue") {
            this.emit(bc, [this.OP.STORE_UPVALUE, res.index], node);
          } else {
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(node.left.name)],
              node,
            );
          }
        } else {
          const src = generate(node.left).code;
          throw new Error(
            `Unsupported for-in left-hand side: ${node.left.type}\n  -> ${src}`,
          );
        }

        // Compile the loop body
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
          throw new Error(
            "try..finally is not supported. Use a helper function instead",
          );
        }
        if (!node.handler) {
          // try without catch requires finally — not supported
          throw new Error(
            "try without catch is not supported (requires finally).",
          );
        }

        const catchLabel = this._makeLabel("catch");
        const afterCatchLabel = this._makeLabel("after_catch");

        // Emit TRY_SETUP with the catch block's label as the handler PC.
        // At runtime: saves stack depth + frame stack depth, pushes handler.
        this.emit(
          bc,
          [this.OP.TRY_SETUP, { type: "label", label: catchLabel }],
          node,
        );

        // Track the open try block so that break/continue/return inside the
        // try body can emit the matching TRY_END before their jump.
        this._loopStack.push({
          type: "try" as any,
          label: null,
          breakLabel: "", // unused
          continueLabel: "", // unused
        });

        // Compile try body
        for (const stmt of node.block.body) {
          this._compileStatement(stmt, scope, bc);
        }

        // Done compiling the try body — pop the tracking entry.
        this._loopStack.pop();

        // Normal exit: disarm the exception handler.
        this.emit(bc, [this.OP.TRY_END], node);

        // Jump over the catch block on normal path.
        this.emit(
          bc,
          [this.OP.JUMP, { type: "label", label: afterCatchLabel }],
          node,
        );

        // Catch block: exception is on top of the stack (pushed by the VM).
        this.emit(bc, [null, { type: "defineLabel", label: catchLabel }], node);

        const handler = node.handler;
        if (handler.param) {
          // Bind the exception value to the catch variable.
          const name = (handler.param as t.Identifier).name;
          if (scope) {
            const slot = scope.define(name);
            this.emit(bc, [this.OP.STORE_LOCAL, slot], node);
          } else {
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(name)],
              node,
            );
          }
        } else {
          // Optional catch binding (catch without a variable — ES2019+)
          this.emit(bc, [this.OP.POP], node);
        }

        // Compile catch body
        for (const stmt of handler.body.body) {
          this._compileStatement(stmt, scope, bc);
        }

        // Normal-path jump lands here (after the catch block).
        this.emit(
          bc,
          [null, { type: "defineLabel", label: afterCatchLabel }],
          node,
        );
        break;
      }

      default: {
        // Use @babel/generator to reproduce the source of unsupported nodes
        // so we can emit a clear error with context.
        const src = generate(node).code;
        throw new Error(`Unsupported statement: ${node.type}\n  -> ${src}`);
      }
    }
  }

  // Expressions
  _compileExpr(node, scope, bc) {
    switch (node.type) {
      case "NumericLiteral":
      case "StringLiteral": {
        this.emit(
          bc,
          [this.OP.LOAD_CONST, b.constantOperand(node.value)],
          node,
        );
        break;
      }

      case "BooleanLiteral": {
        this.emit(
          bc,
          [this.OP.LOAD_CONST, b.constantOperand(node.value)],
          node,
        );
        break;
      }

      case "NullLiteral": {
        this.emit(bc, [this.OP.LOAD_CONST, b.constantOperand(null)], node);
        break;
      }

      case "Identifier": {
        // scope=null means we're at the top-level -> always global
        const res = this._resolve(node.name, this._currentCtx);
        if (res.kind === "local") {
          this.emit(bc, [this.OP.LOAD_LOCAL, res.slot], node);
        } else if (res.kind === "upvalue") {
          this.emit(bc, [this.OP.LOAD_UPVALUE, res.index], node);
        } else {
          this.emit(
            bc,
            [this.OP.LOAD_GLOBAL, b.constantOperand(node.name)],
            node,
          );
        }
        break;
      }

      case "ThisExpression": {
        this.emit(bc, [this.OP.LOAD_THIS], node);
        break;
      }

      case "NewExpression": {
        // Push callee, then args -- identical layout to CALL but uses NEW opcode
        this._compileExpr(node.callee, scope, bc);
        for (const arg of node.arguments) this._compileExpr(arg, scope, bc);
        this.emit(bc, [this.OP.NEW, node.arguments.length], node);
        break;
      }

      case "SequenceExpression": {
        // (a, b, c)  ->  eval a -> POP, eval b -> POP, eval c -> leave on stack
        for (let i = 0; i < node.expressions.length - 1; i++) {
          this._compileExpr(node.expressions[i], scope, bc);
          this.emit(bc, [this.OP.POP], node); // discard intermediate result
        }
        // Last expression -- its value is the result of the whole sequence
        this._compileExpr(
          node.expressions[node.expressions.length - 1],
          scope,
          bc,
        );
        break;
      }

      case "ConditionalExpression": {
        // test ? consequent : alternate
        const elseLabel = this._makeLabel("ternary_else");
        const endLabel = this._makeLabel("ternary_end");

        this._compileExpr(node.test, scope, bc);
        this.emit(
          bc,
          [this.OP.JUMP_IF_FALSE, { type: "label", label: elseLabel }],
          node,
        );

        this._compileExpr(node.consequent, scope, bc);
        this.emit(bc, [this.OP.JUMP, { type: "label", label: endLabel }], node);

        this.emit(bc, [null, { type: "defineLabel", label: elseLabel }], node);
        this._compileExpr(node.alternate, scope, bc);

        this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        break;
      }

      case "LogicalExpression": {
        // Pattern (CPython-style):
        //   eval LHS
        //   JUMP_IF_*_OR_POP  -> target (past RHS)
        //   eval RHS          ← only reached if LHS didn't short-circuit
        //   [target lands here, stack top is the result either way]

        this._compileExpr(node.left, scope, bc);

        if (node.operator === "||") {
          // Short-circuit if LHS is TRUTHY -- keep it, skip RHS
          const endLabel = this._makeLabel("or_end");
          this.emit(
            bc,
            [this.OP.JUMP_IF_TRUE_OR_POP, { type: "label", label: endLabel }],
            node,
          );
          this._compileExpr(node.right, scope, bc);
          this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        } else if (node.operator === "&&") {
          // Short-circuit if LHS is FALSY -- keep it, skip RHS
          const endLabel = this._makeLabel("and_end");
          this.emit(
            bc,
            [this.OP.JUMP_IF_FALSE_OR_POP, { type: "label", label: endLabel }],
            node,
          );
          this._compileExpr(node.right, scope, bc);
          this.emit(bc, [null, { type: "defineLabel", label: endLabel }], node);
        } else {
          throw new Error(`Unsupported logical operator: ${node.operator}`);
        }
        break;
      }

      case "BinaryExpression": {
        this._compileExpr(node.left, scope, bc);
        this._compileExpr(node.right, scope, bc);
        const arithOp = {
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
        }[node.operator];

        const cmpOp = {
          "<": this.OP.LT,
          ">": this.OP.GT,
          "===": this.OP.EQ,
          "==": this.OP.LOOSE_EQ,
          "<=": this.OP.LTE,
          ">=": this.OP.GTE,
          "!==": this.OP.NEQ,
          "!=": this.OP.LOOSE_NEQ,
          in: this.OP.IN, // ← add
          instanceof: this.OP.INSTANCEOF, // ← add
        }[node.operator];
        const resolvedOp = arithOp ?? cmpOp;
        if (resolvedOp === undefined)
          throw new Error(`Unsupported operator: ${node.operator}`);
        this.emit(bc, [resolvedOp], node);

        break;
      }

      case "UpdateExpression": {
        const res = this._resolve(node.argument.name, this._currentCtx);
        const bumpOp = node.operator === "++" ? this.OP.ADD : this.OP.SUB;
        const one = b.constantOperand(1);

        // Helper closures: emit load / store for whichever resolution kind we have
        const emitLoad = () => {
          if (res.kind === "local")
            this.emit(bc, [this.OP.LOAD_LOCAL, res.slot], node);
          else if (res.kind === "upvalue")
            this.emit(bc, [this.OP.LOAD_UPVALUE, res.index], node);
          else
            this.emit(
              bc,
              [this.OP.LOAD_GLOBAL, b.constantOperand(node.argument.name)],
              node,
            );
        };
        const emitStore = () => {
          if (res.kind === "local")
            this.emit(bc, [this.OP.STORE_LOCAL, res.slot], node);
          else if (res.kind === "upvalue")
            this.emit(bc, [this.OP.STORE_UPVALUE, res.index], node);
          else
            this.emit(
              bc,
              [this.OP.STORE_GLOBAL, b.constantOperand(node.argument.name)],
              node,
            );
        };

        emitLoad();
        if (!node.prefix) this.emit(bc, [this.OP.DUP], node); // post: save old value before mutating
        this.emit(bc, [this.OP.LOAD_CONST, one], node);
        this.emit(bc, [bumpOp], node);
        emitStore();
        if (node.prefix) emitLoad(); // pre: reload new value as result

        break;
      }

      case "AssignmentExpression": {
        const compoundOp = {
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
        }[node.operator];

        const isCompound = compoundOp !== undefined;

        if (node.operator !== "=" && !isCompound) {
          throw new Error(`Unsupported assignment operator: ${node.operator}`);
        }

        // Member assignment: obj.x = val  or  arr[i] = val
        if (node.left.type === "MemberExpression") {
          this._compileExpr(node.left.object, scope, bc); // push obj

          if (node.left.computed) {
            this._compileExpr(node.left.property, scope, bc); // push key (runtime)
          } else {
            this.emit(
              bc,
              [this.OP.LOAD_CONST, b.constantOperand(node.left.property.name)],
              node,
            );
          }

          if (isCompound) {
            // Duplicate obj+key on the stack so we can read before we write.
            // Stack before DUP2: [..., obj, key]
            // We need: [..., obj, key, obj, key] -> GET_PROP_COMPUTED -> [..., obj, key, currentVal]
            // Cheapest approach without a DUP opcode: re-compile the member read.
            // (emits obj + key again; a future peephole pass could DUP instead)
            this._compileExpr(node.left.object, scope, bc);
            if (node.left.computed) {
              this._compileExpr(node.left.property, scope, bc);
            } else {
              this.emit(
                bc,
                [
                  this.OP.LOAD_CONST,
                  b.constantOperand(node.left.property.name),
                ],
                node,
              );
            }
            this.emit(bc, [this.OP.GET_PROP_COMPUTED], node); // [..., obj, key, currentVal]
            this._compileExpr(node.right, scope, bc); // [..., obj, key, currentVal, rhs]
            this.emit(bc, [compoundOp], node); // [..., obj, key, newVal]
          } else {
            this._compileExpr(node.right, scope, bc); // [..., obj, key, val]
          }

          this.emit(bc, [this.OP.SET_PROP], node); // obj[key] = val, leaves val on stack
          break;
        }

        // Plain identifier assignment
        const res = this._resolve(node.left.name, this._currentCtx);

        if (isCompound) {
          // Load the current value of the target first
          if (res.kind === "local") {
            this.emit(bc, [this.OP.LOAD_LOCAL, res.slot], node);
          } else if (res.kind === "upvalue") {
            this.emit(bc, [this.OP.LOAD_UPVALUE, res.index], node);
          } else {
            this.emit(
              bc,
              [this.OP.LOAD_GLOBAL, b.constantOperand(node.left.name)],
              node,
            );
          }
        }

        this._compileExpr(node.right, scope, bc); // push RHS

        if (isCompound) {
          this.emit(bc, [compoundOp], node); // apply binary op -> leaves newVal on stack
        }

        // Store & leave value on stack (assignment is an expression)
        if (res.kind === "local") {
          this.emit(bc, [this.OP.STORE_LOCAL, res.slot], node);
          this.emit(bc, [this.OP.LOAD_LOCAL, res.slot], node);
        } else if (res.kind === "upvalue") {
          this.emit(bc, [this.OP.STORE_UPVALUE, res.index], node);
          this.emit(bc, [this.OP.LOAD_UPVALUE, res.index], node);
        } else {
          const nameIdx = b.constantOperand(node.left.name);
          this.emit(bc, [this.OP.STORE_GLOBAL, nameIdx], node);
          this.emit(bc, [this.OP.LOAD_GLOBAL, nameIdx], node);
        }
        break;
      }

      case "CallExpression": {
        if (node.callee.type === "MemberExpression") {
          // ── Method call: console.log(...)
          // Push receiver first (GET_PROP leaves it; CALL_METHOD pops it as `this`)
          this._compileExpr(node.callee.object, scope, bc);
          const prop = node.callee.property.name;
          const propIdx = b.constantOperand(prop);
          this.emit(bc, [this.OP.LOAD_CONST, propIdx], node);
          this.emit(bc, [this.OP.GET_PROP], node);
          for (const arg of node.arguments) this._compileExpr(arg, scope, bc);
          this.emit(bc, [this.OP.CALL_METHOD, node.arguments.length], node);
        } else {
          // ── Plain call: add(5, 10)
          this._compileExpr(node.callee, scope, bc);
          for (const arg of node.arguments) this._compileExpr(arg, scope, bc);
          this.emit(bc, [this.OP.CALL, node.arguments.length], node);
        }
        break;
      }

      case "UnaryExpression": {
        // Special case: typeof on a bare identifier must not throw if undeclared.
        // We emit TYPEOF_SAFE (operand = name constant index) instead of
        // compiling the argument first. The VM does the guard itself.
        if (node.operator === "typeof" && node.argument.type === "Identifier") {
          const res = this._resolve(node.argument.name, this._currentCtx);
          if (res.kind === "global") {
            // Potentially undeclared -- let VM guard it
            this.emit(
              bc,
              [this.OP.LOAD_CONST, b.constantOperand(node.argument.name)],
              node,
            );
            this.emit(bc, [this.OP.TYPEOF_SAFE], node);
            break;
          }
          // Known local or upvalue -- safe to load first, then typeof
        }

        // Special case: delete -- argument must NOT be pre-evaluated.
        if (node.operator === "delete") {
          const arg = node.argument;
          if (arg.type === "MemberExpression") {
            this._compileExpr(arg.object, scope, bc);
            if (arg.computed) {
              this._compileExpr(arg.property, scope, bc);
            } else {
              this.emit(
                bc,
                [this.OP.LOAD_CONST, b.constantOperand(arg.property.name)],
                node,
              );
            }
            this.emit(bc, [this.OP.DELETE_PROP], node);
          } else {
            // delete x, delete 0, etc. -- always true in non-strict, just push true
            this.emit(bc, [this.OP.LOAD_CONST, b.constantOperand(true)], node);
          }
          break;
        }

        // All other unary ops: compile argument first, then apply operator
        this._compileExpr(node.argument, scope, bc);
        switch (node.operator) {
          case "-":
            this.emit(bc, [this.OP.UNARY_NEG], node);
            break;
          case "+":
            this.emit(bc, [this.OP.UNARY_POS], node);
            break;
          case "!":
            this.emit(bc, [this.OP.UNARY_NOT], node);
            break;
          case "~":
            this.emit(bc, [this.OP.UNARY_BITNOT], node);
            break;
          case "typeof":
            this.emit(bc, [this.OP.TYPEOF], node);
            break;
          case "void":
            this.emit(bc, [this.OP.VOID], node);
            break;

          default:
            throw new Error(`Unsupported unary operator: ${node.operator}`);
        }
        break;
      }

      case "RegExpLiteral": {
        // Emit: new RegExp(pattern, flags)
        // Fresh object per evaluation -- correct for stateful g/y flags.
        this.emit(bc, [this.OP.LOAD_GLOBAL, b.constantOperand("RegExp")], node);
        this.emit(
          bc,
          [this.OP.LOAD_CONST, b.constantOperand(node.pattern)],
          node,
        );
        this.emit(
          bc,
          [this.OP.LOAD_CONST, b.constantOperand(node.flags)],
          node,
        );
        this.emit(bc, [this.OP.NEW, 2], node);
        break;
      }

      case "FunctionExpression": {
        // Compile into a descriptor exactly like a declaration,
        // but leave the resulting closure ON THE STACK -- no store.
        // The surrounding expression (assignment, call arg, return) consumes it.
        const desc = this._compileFunctionDecl(node);
        this._emitMakeClosure(desc, node, bc);
        break;
      }

      case "MemberExpression": {
        this._compileExpr(node.object, scope, bc);
        if (node.computed) {
          // nums[i] -- key is runtime value
          this._compileExpr(node.property, scope, bc);
        } else {
          // point.x -- push key as string, same opcode handles both
          this.emit(
            bc,
            [this.OP.LOAD_CONST, b.constantOperand(node.property.name)],
            node,
          );
        }

        // GET_PROP_COMPUTED pops the object -- correct for value access.
        // GET_PROP (peek) is only used in CallExpression's method call path
        // where the receiver must survive on the stack for CALL_METHOD.
        this.emit(bc, [this.OP.GET_PROP_COMPUTED], node);
        break;
      }

      case "ArrayExpression": {
        // Compile each element left->right, then BUILD_ARRAY collapses them.
        // Sparse arrays (holes) get explicit undefined per slot.
        for (const el of node.elements) {
          if (el === null) {
            // hole: e.g. [1,,3]
            this.emit(
              bc,
              [this.OP.LOAD_CONST, b.constantOperand(undefined)],
              node,
            );
          } else {
            this._compileExpr(el, scope, bc);
          }
        }
        this.emit(bc, [this.OP.BUILD_ARRAY, node.elements.length], node);
        break;
      }
      case "ObjectExpression": {
        // Separate regular data properties from ES5 accessor methods (get/set).
        const regularProps: t.ObjectProperty[] = [];
        const accessorProps: t.ObjectMethod[] = [];

        for (const prop of node.properties) {
          if (prop.type === "SpreadElement") {
            throw new Error("Object spread not supported");
          }
          if (prop.type === "ObjectMethod") {
            if (prop.kind === "get" || prop.kind === "set") {
              if (prop.computed) {
                throw new Error(
                  "Computed getter/setter keys are not supported",
                );
              }
              accessorProps.push(prop);
            } else {
              throw new Error(`Shorthand method syntax is not supported`);
            }
          } else {
            regularProps.push(prop as t.ObjectProperty);
          }
        }

        // Build the base object from data properties.
        for (const prop of regularProps) {
          const key = prop.key;
          let keyStr: string;
          if (key.type === "Identifier") {
            keyStr = key.name;
          } else if (
            key.type === "StringLiteral" ||
            key.type === "NumericLiteral"
          ) {
            keyStr = String(key.value);
          } else {
            throw new Error(`Unsupported object key type: ${key.type}`);
          }
          this.emit(bc, [this.OP.LOAD_CONST, b.constantOperand(keyStr)], node);
          this._compileExpr(prop.value, scope, bc);
        }
        this.emit(bc, [this.OP.BUILD_OBJECT, regularProps.length], node);

        // Define each accessor on the object that is now on top of the stack.
        // Stack after BUILD_OBJECT: [..., obj]
        // For each accessor: DUP obj, push key, compile fn, DEFINE_GETTER/DEFINE_SETTER
        // DEFINE_GETTER/DEFINE_SETTER pops fn+key+obj, leaving the original obj.
        for (const prop of accessorProps) {
          const key = prop.key;
          let keyStr: string;
          if (key.type === "Identifier") {
            keyStr = key.name;
          } else if (
            key.type === "StringLiteral" ||
            key.type === "NumericLiteral"
          ) {
            keyStr = String(key.value);
          } else {
            throw new Error(`Unsupported object key type: ${key.type}`);
          }

          this.emit(bc, [this.OP.DUP], node); // dup so the original obj stays after the define
          this.emit(bc, [this.OP.LOAD_CONST, b.constantOperand(keyStr)], node);

          // Compile the accessor body as an anonymous function descriptor.
          const desc = this._compileFunctionDecl(prop as any);
          this._emitMakeClosure(desc, prop as any, bc);

          this.emit(
            bc,
            [
              prop.kind === "get"
                ? this.OP.DEFINE_GETTER
                : this.OP.DEFINE_SETTER,
            ],
            node,
          );
        }

        break;
      }

      default: {
        throw new Error(`Unsupported expression: ${node.type}`);
      }
    }
  }
}

// Serializer
// Turns the compiled output into a commented JS source string.
// Expects fully-resolved bytecode (all label refs and constant refs already
// converted to plain integers by resolveLabels + resolveConstants passes).
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

  // Produce a JS literal for a constant pool entry
  _serializeConst(val) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    return JSON.stringify(val); // number / string / bool
  }

  // One instruction -> "[op, op1, op2, ...]  // MNEMONIC description"
  // Expects a fully-resolved instruction: all operands are plain numbers.
  // Returns { text, values } where values is the flat u16 slots for this
  // instruction (opcode first, then one entry per operand).
  _serializeInstr(
    instr: b.Instruction,
    constants: any[],
  ): { text: string; values: number[] } {
    const op = instr[0] as number;
    const operands = instr.slice(1) as number[];

    const resolvedOperands = operands
      .filter((operand) => (operand as any)?.placeholder !== true)
      .map((o) => (o as any)?.resolvedValue ?? o);

    for (const o of resolvedOperands) {
      ok(typeof o === "number", "Unresolved operand: " + JSON.stringify(o));
      ok(o >= 0 && o <= 0xffff, `Operand overflow (max 0xFFFF u16): ${o}`);
    }
    ok(op >= 0 && op <= 0xffff, `Opcode overflow (max 0xFFFF u16): ${op}`);

    const operand = resolvedOperands[0]; // first operand for single-operand comment cases
    const name = this.OP_NAME[op] || `OP_${op}`;
    let comment = name;

    const sourceNode = instr[SOURCE_NODE_SYM];
    const sourceLocation = sourceNode
      ? sourceNode.loc.start?.line +
        ":" +
        sourceNode.loc.start?.column +
        "-" +
        (sourceNode.loc.end?.line + ":" + sourceNode.loc.end?.column)
      : "";

    // Annotate with human-readable operand meaning
    if (resolvedOperands.length > 0) {
      switch (op) {
        case this.OP.LOAD_CONST: {
          const val = constants[operand];
          comment += `  ${this._serializeConst(val)}`;
          break;
        }
        case this.OP.MAKE_CLOSURE: {
          comment += `  PC ${operand} (params=${resolvedOperands[1]} locals=${resolvedOperands[2]} upvalues=${resolvedOperands[3]})`;
          break;
        }
        case this.OP.LOAD_LOCAL:
        case this.OP.STORE_LOCAL:
          comment += `  slot[${operand}]`;
          break;
        case this.OP.LOAD_UPVALUE:
        case this.OP.STORE_UPVALUE:
          comment += `  upvalue[${operand}]`;
          break;
        case this.OP.LOAD_GLOBAL:
        case this.OP.STORE_GLOBAL:
          comment += `  "${constants[operand]}"`;
          break;
        case this.OP.CALL:
        case this.OP.CALL_METHOD:
          comment += `  (${operand} args)`;
          break;
        case this.OP.BUILD_ARRAY:
          comment += `  (${operand} elements)`;
          break;
        case this.OP.BUILD_OBJECT:
          comment += `  (${operand} pairs)`;
          break;
        case this.OP.NEW:
          comment += `  (${operand} args)`;
          break;
        default:
          comment +=
            resolvedOperands.length === 1
              ? `  ${operand}`
              : `  [${resolvedOperands.join(", ")}]`;
      }
    }

    comment = comment.padEnd(40) + sourceLocation;

    const values = [op, ...resolvedOperands];
    const instrText = `[${values.join(", ")}]`;
    const text = `${(instrText + ",").padEnd(12)} ${comment}`;

    return { text, values };
  }

  // Serialize the CONSTANTS array
  _serializeConstants(constants: any[]) {
    const lines = ["var CONSTANTS = ["];
    constants.forEach((val, idx) => {
      lines.push(`  /* ${idx} */  ${this._serializeConst(val)},`);
    });
    lines.push("];");
    return lines.join("\n");
  }

  // Filter out any remaining null-opcode pseudo-instructions.
  // (defineLabel pseudo-ops are already stripped by resolveLabels.)
  _serializeBytecode(
    bytecode: b.Bytecode,
    compiler: Compiler,
  ): { bytecode: b.Bytecode } {
    const serialized = [];
    for (const instr of bytecode) {
      if (instr[0] === null) continue;

      const specializedOpInfo = compiler.SPECIALIZED_OPS[instr[0]];
      if (specializedOpInfo) {
        const resolvedValue = (instr[1] as any)?.resolvedValue ?? instr[1];
        const originalName = compiler.OP_NAME[specializedOpInfo.originalOp];

        compiler.OP_NAME[instr[0]] = `${originalName}_${resolvedValue}`;
        specializedOpInfo.resolvedOperand = instr[1];
      }

      serialized.push(instr);
    }

    return {
      bytecode: serialized,
    };
  }

  _encodeBytecode(flat: number[]) {
    // Encode as little-endian Uint16Array -> base64.
    const buf = new Uint8Array(flat.length * 2);
    flat.forEach((w, i) => {
      buf[i * 2] = w & 0xff;
      buf[i * 2 + 1] = (w >>> 8) & 0xff;
    });
    return Buffer.from(buf).toString("base64");
  }

  serialize(bytecode: b.Bytecode, constants: any[], compiler: Compiler) {
    const mainStartPc = compiler.mainStartPc;
    let sections = [];

    var textForm = [];
    var initBody = [];

    var bytecodeResult = this._serializeBytecode(bytecode, compiler);

    for (const instr of bytecodeResult.bytecode) {
      const serialized = this._serializeInstr(instr, constants);
      textForm.push(serialized.text);
    }

    initBody.push(textForm.map((line) => `// ${line}`).join("\n"));

    const flat = bytecodeResult.bytecode.flatMap((instr) => {
      let filtered = instr.filter((x) => (x as any)?.placeholder !== true);
      let resolved = filtered.map((x) => (x as any)?.resolvedValue ?? x);

      return resolved as number[];
    });

    if (this.options.encodeBytecode) {
      sections.push(`var BYTECODE = "${this._encodeBytecode(flat)}";`);
    } else {
      // Flatten each [op, ...operands] instruction into individual u16 slots.

      sections.push(`var BYTECODE = [${flat.join(",")}]`);
    }

    // MAIN_START_PC
    sections.push(`var MAIN_START_PC = ${mainStartPc};`);
    sections.push(`var ENCODE_BYTECODE = ${!!this.options.encodeBytecode};`);
    sections.push(`var TIMING_CHECKS = ${!!this.options.timingChecks};`);
    // Opcodes
    const object = t.objectExpression(
      Object.entries(this.OP).map(([name, value]) =>
        t.objectProperty(t.identifier(name), t.numericLiteral(value)),
      ),
    );
    sections.push(`var OP = ${generate(object).code};`);

    // Constants must be defined before the bytecode
    initBody.push(this._serializeConstants(constants));

    sections = [...initBody, ...sections];

    // VM runtime
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

  // User transform passes (operate on unresolved IR with label/constant refs)
  // macroOpcodes must run after selfModifying (so PATCH-stub bodies are in place)
  const passes = [];

  // Due to current implementation, specialized must run BEFORE macroOpcodes
  if (options.specializedOpcodes) {
    passes.push(specializedOpcodes);
  }

  if (options.macroOpcodes) {
    passes.push(macroOpcodes);
  }

  if (options.selfModifying) {
    passes.push(selfModifying);
  }

  for (const pass of passes) {
    const passResult = pass(bytecode, compiler);
    bytecode = passResult.bytecode;
  }

  // Assembler phases: resolve IR operands to plain integers before printing
  const { bytecode: labelResolved } = resolveLabels(bytecode, compiler);
  let { bytecode: finalBytecode, constants } = resolveConstants(labelResolved);

  const output = compiler.serializer.serialize(
    finalBytecode,
    constants,
    compiler,
  );

  const finalOutput = await obfuscateRuntime(
    output,
    finalBytecode,
    options,
    compiler,
  );

  return {
    code: finalOutput,
  };
}
