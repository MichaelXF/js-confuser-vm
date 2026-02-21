import parser from "@babel/parser";
import traverseImport from "@babel/traverse";
import { generate } from "@babel/generator";

import { readFileSync } from "fs";
import { join } from "path";
import { stripTypeScriptTypes } from "module";
import JSON5 from "json5";

const traverse = traverseImport.default;

const SHUFFLE_OPCODES = false;
const PACK = true;

// ── Opcodes ──────────────────────────────────────────────────────
const OP_ORIGINAL = {
  LOAD_CONST: 0,
  LOAD_LOCAL: 1,
  STORE_LOCAL: 2,
  LOAD_GLOBAL: 3,
  STORE_GLOBAL: 4,
  GET_PROP: 5,
  ADD: 6,
  SUB: 7,
  MUL: 8,
  DIV: 9,
  MAKE_CLOSURE: 10,
  CALL: 11,
  CALL_METHOD: 12,
  RETURN: 13,
  POP: 14,
  LT: 15, // pop b, pop a → push (a < b)
  GT: 16,
  EQ: 17,
  JUMP: 18, // unconditional — operand = absolute bytecode index
  JUMP_IF_FALSE: 19, // pop value; jump if falsy
  LTE: 20, // a <= b
  GTE: 21, // a >= b
  NEQ: 22, // a !== b
  LOAD_UPVALUE: 23, // push frame.closure.upvalues[operand].read()
  STORE_UPVALUE: 24, // frame.closure.upvalues[operand].write(pop())

  // ── Unary ──────────────────────────
  UNARY_NEG: 25, // -x
  UNARY_POS: 26, // +x
  UNARY_NOT: 27, // !x
  UNARY_BITNOT: 28, // ~x
  TYPEOF: 29, // typeof x
  VOID: 30, // void x  → always undefined

  TYPEOF_SAFE: 31, // operand = name constIdx — typeof guard for undeclared globals
  BUILD_ARRAY: 32, // operand = element count — pops N values → pushes array
  BUILD_OBJECT: 33, // operand = pair count   — pops N*2 (key,val) → pushes object
  SET_PROP: 34, // pop val, pop key, peek obj → obj[key] = val (obj stays on stack)
  GET_PROP_COMPUTED: 35, // pop key, peek obj → push obj[key]  (computed: nums[i])

  MOD: 36, // a % b
  BAND: 37, // a & b
  BOR: 38, // a | b
  BXOR: 39, // a ^ b
  SHL: 40, // a << b
  SHR: 41, // a >> b
  USHR: 42, // a >>> b

  JUMP_IF_FALSE_OR_POP: 43, // && — if top falsy:  jump (keep), else: pop, eval RHS
  JUMP_IF_TRUE_OR_POP: 44, // || — if top truthy: jump (keep), else: pop, eval RHS

  DELETE_PROP: 45,
  IN: 46, // a in b
  INSTANCEOF: 47, // a instanceof b

  // ── NEW ────────────────────────────────────────────
  LOAD_THIS: 48, // push frame.thisVal
  NEW: 49, // operand = argCount — construct a new object
  DUP: 50, // duplicate top of stack
  THROW: 51, // pop value, throw it
  LOOSE_EQ: 52, // a == b  (abstract equality)
  LOOSE_NEQ: 53, // a != b  (abstract inequality)

  FOR_IN_SETUP: 54, // pop obj → build enumerable-key iterator → push {keys,i}
  FOR_IN_NEXT: 55, // operand=exit_pc; pop iter; if done→jump; else push next key

  // ── Self-modifying bytecode ────────────────────────────────
  PATCH: 56, // pop destPc; constants[operand]=word[]; write words into bytecode[destPc..]
};

export let OP: Partial<typeof OP_ORIGINAL> = {};
// Construct randomized opcode mapping
if (SHUFFLE_OPCODES) {
  let used = new Set();
  for (const key in OP_ORIGINAL) {
    let val;
    do {
      val = Math.floor(Math.random() * 256);
    } while (used.has(val));
    used.add(val);
    OP[key] = val;
  }
} else {
  OP = OP_ORIGINAL;
}

// Reverse map for comment generation
const OP_NAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

const JUMP_OPS = new Set([
  OP.JUMP,
  OP.JUMP_IF_FALSE,
  OP.JUMP_IF_TRUE_OR_POP,
  OP.JUMP_IF_FALSE_OR_POP,
  OP.FOR_IN_NEXT,
]);

// ─────────────────────────────────────────────────────────────────
// Constant Pool
// Primitives (string/number/bool) are interned (deduped).
// Object entries (fn descriptors) are always appended — no dedup.
// ─────────────────────────────────────────────────────────────────
class ConstantPool {
  items: any[];
  _index: Map<string, number>;

  constructor() {
    this.items = []; // ordered pool entries
    this._index = new Map(); // primitive dedup map
  }

  intern(val) {
    // Only intern primitives — objects must use addObject()
    const key = `${typeof val}:${val}`;
    if (this._index.has(key)) return this._index.get(key);
    const idx = this.items.length;
    this.items.push(val);
    this._index.set(key, idx);
    return idx;
  }

  addObject(obj) {
    const idx = this.items.length;
    this.items.push(obj);
    return idx;
  }
}

// ─────────────────────────────────────────────────────────────────
// Scope
// Each function call gets its own Scope. Locals are resolved to
// numeric slots at compile time — zero name lookups at runtime.
// ─────────────────────────────────────────────────────────────────
class Scope {
  parent: Scope | null;
  _locals: Map<string, number>;
  _next: number;

  constructor(parent = null) {
    this.parent = parent;
    this._locals = new Map(); // name → slot index
    this._next = 0;
  }

  define(name) {
    if (!this._locals.has(name)) {
      this._locals.set(name, this._next++);
    }
    return this._locals.get(name);
  }

  // Walk up scope chain. If we fall off the top → global.
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

// ─────────────────────────────────────────────────────────────────
// FnContext
// Compiler-side state for the function currently being compiled.
// Distinct from runtime Frame — this is compile-time only.
// ─────────────────────────────────────────────────────────────────
class FnContext {
  upvalues: { name: string; isLocal: number; index: number }[];
  parentCtx: FnContext | null;
  scope: Scope;
  compiler: Compiler;
  bc: any[];

  constructor(compiler, parentCtx = null) {
    this.compiler = compiler;
    this.parentCtx = parentCtx;
    this.scope = new Scope();

    this.bc = [];
    this.upvalues = []; // { name, isLocal, index }
  }

  // Find or register a captured variable as an upvalue.
  // isLocal=true  → captured directly from parent's locals[index]
  // isLocal=false → relayed from parent's own upvalue list[index]
  addUpvalue(name, isLocal, index) {
    const existing = this.upvalues.findIndex((u) => u.name === name);
    if (existing !== -1) return existing;
    const idx = this.upvalues.length;
    this.upvalues.push({ name, isLocal, index: index });
    return idx;
  }
}

// ─────────────────────────────────────────────────────────────────
// Compiler
// ─────────────────────────────────────────────────────────────────
class Compiler {
  constants: ConstantPool;
  fnDescriptors: any[];
  bytecode: any[];
  mainStartPc: number;

  _currentCtx: FnContext | null;
  _pendingLabel: string | null;
  _forInCount: number;
  _loopStack: {
    type: "loop" | "switch" | "block";
    label: string | null;
    breakJumps: number[];
    continueJumps: number[];
  }[];

  options: Options;
  serializer: Serializer;

  constructor(options: Options) {
    this.options = options;
    this.constants = new ConstantPool();
    this.fnDescriptors = []; // populated in pass 1
    this.bytecode = [];
    this.mainStartPc = 0;
    this._currentCtx = null; // FnContext of the function being compiled, null at top-level
    this._loopStack = []; // { breakJumps: number[], continueJumps: number[] } per active loop
    this._pendingLabel = null;
    this._forInCount = 0; // counter for synthetic for-in iterator global names

    this.serializer = new Serializer(this);
  }

  // ── Variable resolution ──────────────────────────────────────
  // Walks up the FnContext chain. Crossing a context boundary means
  // we're capturing from an outer function — register an upvalue.
  _resolve(name, ctx) {
    if (!ctx) return { kind: "global" };

    // 1. Own locals
    if (ctx.scope._locals.has(name)) {
      return { kind: "local", slot: ctx.scope._locals.get(name) };
    }

    // 2. No parent context → must be global
    if (!ctx.parentCtx) return { kind: "global" };

    // 3. Ask parent — recurse up the chain
    const parentResult = this._resolve(name, ctx.parentCtx);
    if (parentResult.kind === "global") return { kind: "global" };

    // 4. Parent has it (as local or upvalue) — register an upvalue here.
    //    isLocal=true means "take it straight from parent's locals[index]"
    //    isLocal=false means "relay parent's upvalue[index]" (multi-level capture)
    const isLocal = parentResult.kind === "local";
    const index = isLocal ? parentResult.slot : parentResult.index;
    const uvIdx = ctx.addUpvalue(name, isLocal, index);
    return { kind: "upvalue", index: uvIdx };
  }

  // ── Entry point ──────────────────────────────────────────────

  compile(source) {
    const ast = parser.parse(source, { sourceType: "script" });

    return this.compileAST(ast);
  }

  compileAST(ast) {
    // Pass 1 — compile every FunctionDeclaration into a descriptor.
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

    // Pass 2 — compile top-level statements into BYTECODE.
    this._compileMain(ast.program.body);

    return {
      bytecode: this.bytecode,
      mainStartPc: this.mainStartPc,
    };
  }

  // ── Function Declaration ──────────────────────────────────────

  _compileFunctionDecl(node) {
    // Create a context whose parent is whatever we're currently compiling.
    // This is what lets _resolve cross function boundaries correctly.
    const ctx = new FnContext(this, this._currentCtx);
    const savedCtx = this._currentCtx;
    this._currentCtx = ctx;

    // Params occupy the first N local slots (args are copied in on CALL)
    for (const param of node.params) {
      if (param.type === "AssignmentPattern") {
        ctx.scope.define(param.left.name);
      } else {
        ctx.scope.define(param.name);
      }
    }

    // Reserve the next slot for the implicit `arguments` object.
    // Slot index will always equal paramCount (params are 0..paramCount-1).
    ctx.scope.define("arguments");

    // ── Pass 2: emit default-value guards at top of fn body ─────
    // Mirrors what JS engines do: if the caller passed undefined (or
    // nothing), evaluate the default expression and overwrite the slot.
    // Default expressions are full expressions, so f(x = a + b) and
    // f(x = foo()) both work correctly.
    for (const param of node.params) {
      if (param.type !== "AssignmentPattern") continue;

      const slot = ctx.scope._locals.get(param.left.name);

      // if (param === undefined) param = <default expr>
      ctx.bc.push([OP.LOAD_LOCAL, slot]);
      ctx.bc.push([OP.LOAD_CONST, this.constants.intern(undefined)]);
      ctx.bc.push([OP.EQ]);
      ctx.bc.push([OP.JUMP_IF_FALSE, 0]);
      const skipIdx = ctx.bc.length - 1;

      this._compileExpr(param.right, ctx.scope, ctx.bc); // eval default
      ctx.bc.push([OP.STORE_LOCAL, slot]);

      ctx.bc[skipIdx][1] = ctx.bc.length; // patch skip jump
    }

    for (const stmt of node.body.body) {
      this._compileStatement(stmt, ctx.scope, ctx.bc);
    }

    // If we fall off the end of the function, implicitly return undefined.
    ctx.bc.push([OP.LOAD_CONST, this.constants.intern(undefined)]);
    ctx.bc.push([OP.RETURN]);

    this._currentCtx = savedCtx; // restore before touching fnDescriptors

    var fnIdx = this.fnDescriptors.length;
    node._fnIdx = fnIdx; // for error messages

    const desc = {
      name: node.id?.name || "<anonymous>",
      paramCount: node.params.length,
      localCount: ctx.scope.localCount,
      upvalueDescriptors: ctx.upvalues.map((u) => ({
        isLocal: u.isLocal,
        _index: u.index,
      })),
      bytecode: ctx.bc,
      // Indices assigned after pushing into the pool
      _fnIdx: this.fnDescriptors.length,
      _constIdx: null,
    };

    this.fnDescriptors.push(desc);
    desc._constIdx = this.constants.addObject(desc); // object entry, no dedup
    return desc;
  }

  // ── Main (top-level) ─────────────────────────────────────────

  _compileMain(body) {
    this.mainStartPc = 0; // ← record main's entry point
    const bc = this.bytecode;

    // Hoist all FunctionDeclarations: MAKE_CLOSURE → STORE_GLOBAL
    // (mirrors JS hoisting — functions are available before other code)
    for (const node of body) {
      if (node.type !== "FunctionDeclaration") continue;
      const desc = this.fnDescriptors.find((d) => d._fnIdx === node._fnIdx);
      const nameIdx = this.constants.intern(node.id.name);
      bc.push([OP.MAKE_CLOSURE, desc._constIdx]);
      bc.push([OP.STORE_GLOBAL, nameIdx]);
    }

    // Compile everything else in order
    for (const node of body) {
      if (node.type === "FunctionDeclaration") continue;
      this._compileStatement(node, null, bc); // null scope → global context
    }

    bc.push([OP.RETURN]); // end program

    // Now that main is compiled, we can append all the function bodies at the end of the bytecode.
    for (const descriptor of this.fnDescriptors) {
      descriptor.startPc = this.bytecode.length;

      descriptor.bytecode.push([OP.RETURN]); // ensure every function ends with RETURN

      if (this.options.selfModifying) {
        // Preamble is 2 instructions: LOAD_CONST(destPc) + PATCH(bodyConst)
        // Real body starts immediately after the preamble.
        const bodyPc = descriptor.startPc + 2;

        // Build real body with jump targets resolved from bodyPc as the base.
        const realBodyInstrs = descriptor.bytecode.map((instr) =>
          this._offsetJump(instr, bodyPc),
        );

        // Pack each instruction into a 32-bit word and store as a constant.
        // The PATCH handler will write these words directly into this.bytecode.
        const realBodyWords =
          this.serializer._serializeBytecode(realBodyInstrs);
        const bodyConstIdx = this.constants.addObject(realBodyWords);

        // Emit preamble: push destination PC, then PATCH.
        const destPcConstIdx = this.constants.intern(bodyPc);
        this.bytecode.push([OP.LOAD_CONST, destPcConstIdx]);
        this.bytecode.push([OP.PATCH, bodyConstIdx]);

        // Garbage fill — same length as real body, never executed (PATCH fires first).
        for (let i = 0; i < realBodyInstrs.length; i++) {
          this.bytecode.push([OP.LOAD_CONST, 0]);
        }
      } else {
        for (const instr of descriptor.bytecode) {
          this.bytecode.push(this._offsetJump(instr, descriptor.startPc));
        }
      }
    }

    if (this.bytecode.length > 0xffffff)
      throw new Error(
        `Program too large: ${this.bytecode.length} instructions, max 16,777,215`,
      );

    if (this.constants.items.length > 0xffffff)
      throw new Error(
        `Constant pool too large: ${this.constants.items.length} entries, max 16,777,215`,
      );
  }

  _offsetJump(instr, offset) {
    if (JUMP_OPS.has(instr[0]) && instr[1] !== undefined) {
      return [instr[0], instr[1] + offset];
    }
    return instr;
  }

  // ── Statements ───────────────────────────────────────────────

  _compileStatement(node, scope, bc) {
    switch (node.type) {
      case "BlockStatement": {
        for (const stmt of node.body) {
          this._compileStatement(stmt, scope, bc);
        }
        break;
      }

      case "FunctionDeclaration": {
        // Nested function — compile it into a descriptor, then emit
        // MAKE_CLOSURE so it's captured as a live closure at runtime.
        // (_compileFunctionDecl pushes/pops _currentCtx internally)
        const desc = this._compileFunctionDecl(node);
        bc.push([OP.MAKE_CLOSURE, desc._constIdx]);
        if (scope) {
          const slot = scope.define(node.id.name);
          bc.push([OP.STORE_LOCAL, slot]);
        } else {
          bc.push([OP.STORE_GLOBAL, this.constants.intern(node.id.name)]);
        }
        break;
      }

      case "ThrowStatement": {
        this._compileExpr(node.argument, scope, bc);
        bc.push([OP.THROW]);
        break;
      }

      case "ReturnStatement": {
        if (node.argument) {
          this._compileExpr(node.argument, scope, bc);
        } else {
          bc.push([OP.LOAD_CONST, this.constants.intern(undefined)]);
        }
        bc.push([OP.RETURN]);
        break;
      }

      case "ExpressionStatement": {
        this._compileExpr(node.expression, scope, bc);
        bc.push([OP.POP]); // discard return value of statement-level expressions
        break;
      }

      case "VariableDeclaration": {
        for (const decl of node.declarations) {
          // Push the initialiser (or undefined if absent)
          if (decl.init) {
            this._compileExpr(decl.init, scope, bc);
          } else {
            bc.push([OP.LOAD_CONST, this.constants.intern(undefined)]);
          }
          // Store: local slot if inside a function, global name otherwise
          if (scope) {
            const slot = scope.define(decl.id.name);
            bc.push([OP.STORE_LOCAL, slot]);
          } else {
            bc.push([OP.STORE_GLOBAL, this.constants.intern(decl.id.name)]);
          }
        }
        break;
      }

      case "IfStatement": {
        // 1. Compile the test expression → leaves a value on the stack
        this._compileExpr(node.test, scope, bc);
        // 2. Emit JUMP_IF_FALSE with placeholder target
        bc.push([OP.JUMP_IF_FALSE, 0]);
        const jumpIfFalseIdx = bc.length - 1;
        // 3. Compile the consequent block (the "then" branch)
        // Consequent may be a BlockStatement or a bare statement (no braces)
        const consequentBody =
          node.consequent.type === "BlockStatement"
            ? node.consequent.body
            : [node.consequent];
        for (const stmt of consequentBody) {
          this._compileStatement(stmt, scope, bc);
        }
        if (node.alternate) {
          // 4a. Consequent needs to jump OVER the else block when done
          bc.push([OP.JUMP, 0]);
          const jumpOverElseIdx = bc.length - 1;
          // Patch JUMP_IF_FALSE to land here (start of else)
          bc[jumpIfFalseIdx][1] = bc.length;
          // 5. Compile the alternate (else) block
          const altBody =
            node.alternate.type === "BlockStatement"
              ? node.alternate.body
              : [node.alternate]; // handles `else if` — it's just a nested IfStatement
          for (const stmt of altBody) {
            this._compileStatement(stmt, scope, bc);
          }
          // Patch the JUMP to land after the else block
          bc[jumpOverElseIdx][1] = bc.length;
        } else {
          // 4b. No else — patch JUMP_IF_FALSE to land right after the then block
          bc[jumpIfFalseIdx][1] = bc.length;
        }
        break;
      }

      case "WhileStatement": {
        const _wLabel = this._pendingLabel;
        this._pendingLabel = null;
        this._loopStack.push({
          type: "loop",
          label: _wLabel,
          breakJumps: [],
          continueJumps: [],
        });
        const loopCtxW = this._loopStack[this._loopStack.length - 1];

        const loopTop = bc.length;
        this._compileExpr(node.test, scope, bc);
        bc.push([OP.JUMP_IF_FALSE, 0]);
        const exitJumpIdx = bc.length - 1;

        for (const stmt of node.body.body) {
          this._compileStatement(stmt, scope, bc);
        }

        // continue → re-evaluate the test
        for (const idx of loopCtxW.continueJumps) bc[idx][1] = loopTop;
        bc.push([OP.JUMP, loopTop]);

        const exitTargetW = bc.length;
        bc[exitJumpIdx][1] = exitTargetW;
        for (const idx of loopCtxW.breakJumps) bc[idx][1] = exitTargetW;

        this._loopStack.pop();
        break;
      }

      case "DoWhileStatement": {
        const _dwLabel = this._pendingLabel;
        this._pendingLabel = null;
        this._loopStack.push({
          type: "loop",
          label: _dwLabel,
          breakJumps: [],
          continueJumps: [],
        });
        const loopCtxDW = this._loopStack[this._loopStack.length - 1];

        const loopTopDW = bc.length;

        for (const stmt of node.body.body) {
          this._compileStatement(stmt, scope, bc);
        }

        // continue → skip rest of body, fall through to test
        const continueTargetDW = bc.length;
        for (const idx of loopCtxDW.continueJumps)
          bc[idx][1] = continueTargetDW;

        this._compileExpr(node.test, scope, bc);
        bc.push([OP.JUMP_IF_FALSE, 0]);
        const exitJumpIdxDW = bc.length - 1;
        bc.push([OP.JUMP, loopTopDW]);

        const exitTargetDW = bc.length;
        bc[exitJumpIdxDW][1] = exitTargetDW;
        for (const idx of loopCtxDW.breakJumps) bc[idx][1] = exitTargetDW;

        this._loopStack.pop();
        break;
      }

      case "ForStatement": {
        const _fLabel = this._pendingLabel;
        this._pendingLabel = null;
        this._loopStack.push({
          type: "loop",
          label: _fLabel,
          breakJumps: [],
          continueJumps: [],
        });
        const loopCtxF = this._loopStack[this._loopStack.length - 1];

        if (node.init) {
          if (node.init.type === "VariableDeclaration") {
            this._compileStatement(node.init, scope, bc);
          } else {
            this._compileExpr(node.init, scope, bc);
            bc.push([OP.POP]);
          }
        }

        const loopTopF = bc.length;
        if (node.test) {
          this._compileExpr(node.test, scope, bc);
          bc.push([OP.JUMP_IF_FALSE, 0]);
        }
        const exitJumpIdxF = node.test ? bc.length - 1 : null;

        for (const stmt of node.body.body) {
          this._compileStatement(stmt, scope, bc);
        }

        // continue → run update (if any) then back to test
        if (node.update) {
          const continueTargetF = bc.length;
          for (const idx of loopCtxF.continueJumps)
            bc[idx][1] = continueTargetF;
          this._compileExpr(node.update, scope, bc);
          bc.push([OP.POP]);
        } else {
          // No update — continue goes straight to the test
          for (const idx of loopCtxF.continueJumps) bc[idx][1] = loopTopF;
        }

        bc.push([OP.JUMP, loopTopF]);

        const exitTargetF = bc.length;
        if (exitJumpIdxF !== null) bc[exitJumpIdxF][1] = exitTargetF;
        for (const idx of loopCtxF.breakJumps) bc[idx][1] = exitTargetF;

        this._loopStack.pop();
        break;
      }

      case "BreakStatement": {
        bc.push([OP.JUMP, 0]);
        const _bJumpIdx = bc.length - 1;
        if (node.label) {
          const _bLabelName = node.label.name;
          let _bFound = -1;
          for (let _bi = this._loopStack.length - 1; _bi >= 0; _bi--) {
            if (this._loopStack[_bi].label === _bLabelName) {
              _bFound = _bi;
              break;
            }
          }
          if (_bFound === -1)
            throw new Error(`Label '${_bLabelName}' not found`);
          this._loopStack[_bFound].breakJumps.push(_bJumpIdx);
        } else {
          if (this._loopStack.length === 0)
            throw new Error("break outside loop");
          this._loopStack[this._loopStack.length - 1].breakJumps.push(
            _bJumpIdx,
          );
        }
        break;
      }

      case "ContinueStatement": {
        bc.push([OP.JUMP, 0]);
        const _cJumpIdx = bc.length - 1;
        if (node.label) {
          const _cLabelName = node.label.name;
          let _cFound = -1;
          for (let _ci = this._loopStack.length - 1; _ci >= 0; _ci--) {
            if (
              this._loopStack[_ci].label === _cLabelName &&
              this._loopStack[_ci].type === "loop"
            ) {
              _cFound = _ci;
              break;
            }
          }
          if (_cFound === -1)
            throw new Error(`Label '${_cLabelName}' not found for continue`);
          this._loopStack[_cFound].continueJumps.push(_cJumpIdx);
        } else {
          if (this._loopStack.length === 0)
            throw new Error("continue outside loop");
          // Find the innermost loop (skip switch and block contexts)
          let loopIdx = -1;
          for (let i = this._loopStack.length - 1; i >= 0; i--) {
            if (this._loopStack[i].type === "loop") {
              loopIdx = i;
              break;
            }
          }
          if (loopIdx === -1) throw new Error("continue outside loop");
          this._loopStack[loopIdx].continueJumps.push(_cJumpIdx);
        }
        break;
      }

      case "SwitchStatement": {
        const _swLabel = this._pendingLabel;
        this._pendingLabel = null;
        this._loopStack.push({
          type: "switch",
          label: _swLabel,
          breakJumps: [],
          continueJumps: [],
        });
        const switchCtx = this._loopStack[this._loopStack.length - 1];

        // Compile the discriminant and leave it on the stack
        this._compileExpr(node.discriminant, scope, bc);

        const cases = node.cases;
        const defaultIdx = cases.findIndex((c) => c.test === null);

        // Dispatch section: emit case checks
        const bodyJumps = []; // { cas, jumpIdx }

        for (const cas of cases) {
          if (cas.test === null) continue; // Skip default in dispatch

          // Check this case: DUP; LOAD_CONST; EQ; JUMP_IF_FALSE
          bc.push([OP.DUP]);
          this._compileExpr(cas.test, scope, bc);
          bc.push([OP.EQ]);
          bc.push([OP.JUMP_IF_FALSE, 0]); // Jump to next check (patched later)
          const skipIdx = bc.length - 1;

          // If matched, jump to this case's body
          bc.push([OP.JUMP, 0]); // Jump to body (patched later)
          bodyJumps.push({ cas, jumpIdx: bc.length - 1 });

          // Patch the JUMP_IF_FALSE to the next check
          bc[skipIdx][1] = bc.length;
        }

        // No match found: jump to default (or exit if no default)
        bc.push([OP.JUMP, 0]);
        const noMatchJumpIdx = bc.length - 1;

        // Body section: compile all case bodies in source order
        const bodyStart = new Map();
        for (const cas of cases) {
          bodyStart.set(cas, bc.length);
          for (const stmt of cas.consequent) {
            this._compileStatement(stmt, scope, bc);
          }
        }

        // Patch the no-match jump to default or exit
        const exitTarget = bc.length;
        if (defaultIdx !== -1) {
          bc[noMatchJumpIdx][1] = bodyStart.get(cases[defaultIdx]);
        } else {
          bc[noMatchJumpIdx][1] = exitTarget;
        }

        // Patch all body jumps
        for (const { cas, jumpIdx } of bodyJumps) {
          bc[jumpIdx][1] = bodyStart.get(cas);
        }

        // Exit: pop the discriminant and patch break jumps
        bc.push([OP.POP]);
        for (const idx of switchCtx.breakJumps) {
          bc[idx][1] = bc.length - 1; // Point to the POP instruction
        }

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
          // Non-loop labeled statement (e.g. labeled block) — only break is valid
          this._loopStack.push({
            type: "block",
            label: _lName,
            breakJumps: [],
            continueJumps: [],
          });
          this._compileStatement(_lBody, scope, bc);
          const _lEntry = this._loopStack.pop()!;
          const _lExit = bc.length;
          for (const _lIdx of _lEntry.breakJumps) bc[_lIdx][1] = _lExit;
        }
        break;
      }

      case "ForInStatement": {
        const _fiLabel = this._pendingLabel;
        this._pendingLabel = null;

        // Evaluate the object expression → on stack
        this._compileExpr(node.right, scope, bc);
        // FOR_IN_SETUP: pops obj, pushes iterator {keys, i}
        bc.push([OP.FOR_IN_SETUP]);

        // Store iterator in a hidden slot so break/continue need no cleanup
        let emitLoadIter: () => void;
        let emitStoreIter: () => void;
        if (scope) {
          // Reserve a hidden local slot (no name mapping needed)
          const iterSlot = scope._next++;
          emitLoadIter = () => bc.push([OP.LOAD_LOCAL, iterSlot]);
          emitStoreIter = () => bc.push([OP.STORE_LOCAL, iterSlot]);
        } else {
          // Top level — use a synthetic global that won't collide with user code
          const iterNameIdx = this.constants.intern(
            "__fi" + this._forInCount++,
          );
          emitLoadIter = () => bc.push([OP.LOAD_GLOBAL, iterNameIdx]);
          emitStoreIter = () => bc.push([OP.STORE_GLOBAL, iterNameIdx]);
        }
        emitStoreIter();

        this._loopStack.push({
          type: "loop",
          label: _fiLabel,
          breakJumps: [],
          continueJumps: [],
        });
        const loopCtxFI = this._loopStack[this._loopStack.length - 1];

        const loopTopFI = bc.length;

        // Load iterator, attempt to get next key
        emitLoadIter();
        bc.push([OP.FOR_IN_NEXT, 0]); // exit target patched below
        const forInNextPatch = bc.length - 1;

        // Assign the key (now on top of stack) to the loop variable
        if (node.left.type === "VariableDeclaration") {
          const name = node.left.declarations[0].id.name;
          if (scope) {
            const slot = scope.define(name);
            bc.push([OP.STORE_LOCAL, slot]);
          } else {
            bc.push([OP.STORE_GLOBAL, this.constants.intern(name)]);
          }
        } else if (node.left.type === "Identifier") {
          const res = this._resolve(node.left.name, this._currentCtx);
          if (res.kind === "local") {
            bc.push([OP.STORE_LOCAL, res.slot]);
          } else if (res.kind === "upvalue") {
            bc.push([OP.STORE_UPVALUE, res.index]);
          } else {
            bc.push([OP.STORE_GLOBAL, this.constants.intern(node.left.name)]);
          }
        } else {
          const src = generate(node.left).code;
          throw new Error(
            `Unsupported for-in left-hand side: ${node.left.type}\n  → ${src}`,
          );
        }

        // Compile the loop body
        const fiBody =
          node.body.type === "BlockStatement" ? node.body.body : [node.body];
        for (const stmt of fiBody) {
          this._compileStatement(stmt, scope, bc);
        }

        // continue → re-load iterator and check next key
        for (const idx of loopCtxFI.continueJumps) bc[idx][1] = loopTopFI;
        bc.push([OP.JUMP, loopTopFI]);

        const exitTargetFI = bc.length;
        bc[forInNextPatch][1] = exitTargetFI;
        for (const idx of loopCtxFI.breakJumps) bc[idx][1] = exitTargetFI;

        this._loopStack.pop();
        break;
      }

      default: {
        // Use @babel/generator to reproduce the source of unsupported nodes
        // so we can emit a clear error with context.
        const src = generate(node).code;
        throw new Error(`Unsupported statement: ${node.type}\n  → ${src}`);
      }
    }
  }

  // ── Expressions ──────────────────────────────────────────────

  _compileExpr(node, scope, bc) {
    switch (node.type) {
      case "NumericLiteral":
      case "StringLiteral": {
        bc.push([OP.LOAD_CONST, this.constants.intern(node.value)]);
        break;
      }

      case "BooleanLiteral": {
        bc.push([OP.LOAD_CONST, this.constants.intern(node.value)]);
        break;
      }

      case "NullLiteral": {
        bc.push([OP.LOAD_CONST, this.constants.intern(null)]);
        break;
      }

      case "Identifier": {
        // scope=null means we're at the top-level → always global
        const res = this._resolve(node.name, this._currentCtx);
        if (res.kind === "local") {
          bc.push([OP.LOAD_LOCAL, res.slot]);
        } else if (res.kind === "upvalue") {
          bc.push([OP.LOAD_UPVALUE, res.index]);
        } else {
          bc.push([OP.LOAD_GLOBAL, this.constants.intern(node.name)]);
        }
        break;
      }

      case "ThisExpression": {
        bc.push([OP.LOAD_THIS]);
        break;
      }

      case "NewExpression": {
        // Push callee, then args — identical layout to CALL but uses NEW opcode
        this._compileExpr(node.callee, scope, bc);
        for (const arg of node.arguments) this._compileExpr(arg, scope, bc);
        bc.push([OP.NEW, node.arguments.length]);
        break;
      }

      case "SequenceExpression": {
        // (a, b, c)  →  eval a → POP, eval b → POP, eval c → leave on stack
        // Matches CPython's BINARY_OP / POP_TOP pattern for comma expressions.
        for (let i = 0; i < node.expressions.length - 1; i++) {
          this._compileExpr(node.expressions[i], scope, bc);
          bc.push([OP.POP]); // discard intermediate result
        }
        // Last expression — its value is the result of the whole sequence
        this._compileExpr(
          node.expressions[node.expressions.length - 1],
          scope,
          bc,
        );
        break;
      }

      case "ConditionalExpression": {
        // test ? consequent : alternate
        // Identical to IfStatement codegen, just lives in expression context.
        this._compileExpr(node.test, scope, bc);

        bc.push([OP.JUMP_IF_FALSE, 0]);
        const jumpToElse = bc.length - 1;

        this._compileExpr(node.consequent, scope, bc);

        bc.push([OP.JUMP, 0]);
        const jumpToEnd = bc.length - 1;

        bc[jumpToElse][1] = bc.length; // patch: false → alternate
        this._compileExpr(node.alternate, scope, bc);

        bc[jumpToEnd][1] = bc.length; // patch: after consequent → end
        break;
      }

      case "LogicalExpression": {
        // Pattern (CPython-style):
        //   eval LHS
        //   JUMP_IF_*_OR_POP  → target (past RHS)
        //   eval RHS          ← only reached if LHS didn't short-circuit
        //   [target lands here, stack top is the result either way]

        this._compileExpr(node.left, scope, bc);

        if (node.operator === "||") {
          // Short-circuit if LHS is TRUTHY — keep it, skip RHS
          bc.push([OP.JUMP_IF_TRUE_OR_POP, 0]);
          const jumpIdx = bc.length - 1;
          this._compileExpr(node.right, scope, bc);
          bc[jumpIdx][1] = bc.length; // patch target to after RHS
        } else if (node.operator === "&&") {
          // Short-circuit if LHS is FALSY — keep it, skip RHS
          bc.push([OP.JUMP_IF_FALSE_OR_POP, 0]);
          const jumpIdx = bc.length - 1;
          this._compileExpr(node.right, scope, bc);
          bc[jumpIdx][1] = bc.length; // patch target to after RHS
        } else {
          throw new Error(`Unsupported logical operator: ${node.operator}`);
        }
        break;
      }

      case "BinaryExpression": {
        this._compileExpr(node.left, scope, bc);
        this._compileExpr(node.right, scope, bc);
        const arithOp = {
          "+": OP.ADD,
          "-": OP.SUB,
          "*": OP.MUL,
          "/": OP.DIV,
          "%": OP.MOD,
          "&": OP.BAND,
          "|": OP.BOR,
          "^": OP.BXOR,
          "<<": OP.SHL,
          ">>": OP.SHR,
          ">>>": OP.USHR,
        }[node.operator];

        const cmpOp = {
          "<": OP.LT,
          ">": OP.GT,
          "===": OP.EQ,
          "==": OP.LOOSE_EQ,
          "<=": OP.LTE,
          ">=": OP.GTE,
          "!==": OP.NEQ,
          "!=": OP.LOOSE_NEQ,
          in: OP.IN, // ← add
          instanceof: OP.INSTANCEOF, // ← add
        }[node.operator];
        const resolvedOp = arithOp ?? cmpOp;
        if (resolvedOp === undefined)
          throw new Error(`Unsupported operator: ${node.operator}`);
        bc.push([resolvedOp]);

        break;
      }

      case "UpdateExpression": {
        const res = this._resolve(node.argument.name, this._currentCtx);
        const bumpOp = node.operator === "++" ? OP.ADD : OP.SUB;
        const one = this.constants.intern(1);

        // Helper closures: emit load / store for whichever resolution kind we have
        const emitLoad = () => {
          if (res.kind === "local") bc.push([OP.LOAD_LOCAL, res.slot]);
          else if (res.kind === "upvalue")
            bc.push([OP.LOAD_UPVALUE, res.index]);
          else
            bc.push([
              OP.LOAD_GLOBAL,
              this.constants.intern(node.argument.name),
            ]);
        };
        const emitStore = () => {
          if (res.kind === "local") bc.push([OP.STORE_LOCAL, res.slot]);
          else if (res.kind === "upvalue")
            bc.push([OP.STORE_UPVALUE, res.index]);
          else
            bc.push([
              OP.STORE_GLOBAL,
              this.constants.intern(node.argument.name),
            ]);
        };

        emitLoad();
        if (!node.prefix) bc.push([OP.DUP]); // post: save old value before mutating
        bc.push([OP.LOAD_CONST, one]);
        bc.push([bumpOp]);
        emitStore();
        if (node.prefix) emitLoad(); // pre: reload new value as result

        break;
      }

      case "AssignmentExpression": {
        const compoundOp = {
          "+=": OP.ADD,
          "-=": OP.SUB,
          "*=": OP.MUL,
          "/=": OP.DIV,
          "%=": OP.MOD,
          "&=": OP.BAND,
          "|=": OP.BOR,
          "^=": OP.BXOR,
          "<<=": OP.SHL,
          ">>=": OP.SHR,
          ">>>=": OP.USHR,
        }[node.operator];

        const isCompound = compoundOp !== undefined;

        if (node.operator !== "=" && !isCompound) {
          throw new Error(`Unsupported assignment operator: ${node.operator}`);
        }

        // ── Member assignment: obj.x = val  or  arr[i] = val ──────
        if (node.left.type === "MemberExpression") {
          this._compileExpr(node.left.object, scope, bc); // push obj

          if (node.left.computed) {
            this._compileExpr(node.left.property, scope, bc); // push key (runtime)
          } else {
            bc.push([
              OP.LOAD_CONST,
              this.constants.intern(node.left.property.name),
            ]);
          }

          if (isCompound) {
            // Duplicate obj+key on the stack so we can read before we write.
            // Stack before DUP2: [..., obj, key]
            // We need: [..., obj, key, obj, key] → GET_PROP_COMPUTED → [..., obj, key, currentVal]
            // Cheapest approach without a DUP opcode: re-compile the member read.
            // (emits obj + key again; a future peephole pass could DUP instead)
            this._compileExpr(node.left.object, scope, bc);
            if (node.left.computed) {
              this._compileExpr(node.left.property, scope, bc);
            } else {
              bc.push([
                OP.LOAD_CONST,
                this.constants.intern(node.left.property.name),
              ]);
            }
            bc.push([OP.GET_PROP_COMPUTED]); // [..., obj, key, currentVal]
            this._compileExpr(node.right, scope, bc); // [..., obj, key, currentVal, rhs]
            bc.push([compoundOp]); // [..., obj, key, newVal]
          } else {
            this._compileExpr(node.right, scope, bc); // [..., obj, key, val]
          }

          bc.push([OP.SET_PROP]); // obj[key] = val, leaves val on stack
          break;
        }

        // ── Plain identifier assignment ────────────────────────────
        const res = this._resolve(node.left.name, this._currentCtx);

        if (isCompound) {
          // Load the current value of the target first
          if (res.kind === "local") {
            bc.push([OP.LOAD_LOCAL, res.slot]);
          } else if (res.kind === "upvalue") {
            bc.push([OP.LOAD_UPVALUE, res.index]);
          } else {
            bc.push([OP.LOAD_GLOBAL, this.constants.intern(node.left.name)]);
          }
        }

        this._compileExpr(node.right, scope, bc); // push RHS

        if (isCompound) {
          bc.push([compoundOp]); // apply binary op → leaves newVal on stack
        }

        // Store & leave value on stack (assignment is an expression)
        if (res.kind === "local") {
          bc.push([OP.STORE_LOCAL, res.slot]);
          bc.push([OP.LOAD_LOCAL, res.slot]);
        } else if (res.kind === "upvalue") {
          bc.push([OP.STORE_UPVALUE, res.index]);
          bc.push([OP.LOAD_UPVALUE, res.index]);
        } else {
          const nameIdx = this.constants.intern(node.left.name);
          bc.push([OP.STORE_GLOBAL, nameIdx]);
          bc.push([OP.LOAD_GLOBAL, nameIdx]);
        }
        break;
      }

      case "CallExpression": {
        if (node.callee.type === "MemberExpression") {
          // ── Method call: console.log(...)
          // Push receiver first (GET_PROP leaves it; CALL_METHOD pops it as `this`)
          this._compileExpr(node.callee.object, scope, bc);
          const prop = node.callee.property.name;
          const propIdx = this.constants.intern(prop);
          bc.push([OP.LOAD_CONST, propIdx]);
          bc.push([OP.GET_PROP]);
          for (const arg of node.arguments) this._compileExpr(arg, scope, bc);
          bc.push([OP.CALL_METHOD, node.arguments.length]);
        } else {
          // ── Plain call: add(5, 10)
          this._compileExpr(node.callee, scope, bc);
          for (const arg of node.arguments) this._compileExpr(arg, scope, bc);
          bc.push([OP.CALL, node.arguments.length]);
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
            // Potentially undeclared — let VM guard it
            bc.push([OP.LOAD_CONST, this.constants.intern(node.argument.name)]);
            bc.push([OP.TYPEOF_SAFE]);
            break;
          }
          // Known local or upvalue — safe to load first, then typeof
        }
        // All other unary ops: compile argument first, then apply operator
        this._compileExpr(node.argument, scope, bc);
        switch (node.operator) {
          case "-":
            bc.push([OP.UNARY_NEG]);
            break;
          case "+":
            bc.push([OP.UNARY_POS]);
            break;
          case "!":
            bc.push([OP.UNARY_NOT]);
            break;
          case "~":
            bc.push([OP.UNARY_BITNOT]);
            break;
          case "typeof":
            bc.push([OP.TYPEOF]);
            break;
          case "void":
            bc.push([OP.VOID]);
            break;

          case "delete": {
            const arg = node.argument;
            if (arg.type === "MemberExpression") {
              this._compileExpr(arg.object, scope, bc);
              if (arg.computed) {
                this._compileExpr(arg.property, scope, bc);
              } else {
                bc.push([
                  OP.LOAD_CONST,
                  this.constants.intern(arg.property.name),
                ]);
              }
              bc.push([OP.DELETE_PROP]);
            } else {
              // delete x, delete 0, etc. — always true in non-strict, just push true
              bc.push([OP.LOAD_CONST, this.constants.intern(true)]);
            }
            break;
          }

          default:
            throw new Error(`Unsupported unary operator: ${node.operator}`);
        }
        break;
      }

      case "FunctionExpression": {
        // Compile into a descriptor exactly like a declaration,
        // but leave the resulting closure ON THE STACK — no store.
        // The surrounding expression (assignment, call arg, return) consumes it.
        const desc = this._compileFunctionDecl(node);
        bc.push([OP.MAKE_CLOSURE, desc._constIdx]);
        break;
      }

      case "MemberExpression": {
        this._compileExpr(node.object, scope, bc);
        if (node.computed) {
          // nums[i] — key is runtime value
          this._compileExpr(node.property, scope, bc);
        } else {
          // point.x — push key as string, same opcode handles both
          bc.push([OP.LOAD_CONST, this.constants.intern(node.property.name)]);
        }

        // GET_PROP_COMPUTED pops the object — correct for value access.
        // GET_PROP (peek) is only used in CallExpression's method call path
        // where the receiver must survive on the stack for CALL_METHOD.
        bc.push([OP.GET_PROP_COMPUTED]);
        break;
      }

      case "ArrayExpression": {
        // Compile each element left→right, then BUILD_ARRAY collapses them.
        // Sparse arrays (holes) get explicit undefined per slot.
        for (const el of node.elements) {
          if (el === null) {
            // hole: e.g. [1,,3]
            bc.push([OP.LOAD_CONST, this.constants.intern(undefined)]);
          } else {
            this._compileExpr(el, scope, bc);
          }
        }
        bc.push([OP.BUILD_ARRAY, node.elements.length]);
        break;
      }
      case "ObjectExpression": {
        // For each property: push key (always as string), push value.
        // BUILD_OBJECT pops pairs right→left and assembles the object.
        for (const prop of node.properties) {
          if (prop.type === "SpreadElement") {
            throw new Error("Object spread not supported");
          }
          // Key — identifier shorthand (`{x:1}`) or string/number literal
          const key = prop.key;
          let keyStr;
          if (key.type === "Identifier") {
            keyStr = key.name; // {x: 1} → key is "x"
          } else if (
            key.type === "StringLiteral" ||
            key.type === "NumericLiteral"
          ) {
            keyStr = String(key.value); // {"x": 1} or {0: 1}
          } else {
            throw new Error(`Unsupported object key type: ${key.type}`);
          }
          bc.push([OP.LOAD_CONST, this.constants.intern(keyStr)]);
          // Value — any expression, including FunctionExpression
          this._compileExpr(prop.value, scope, bc);
        }
        bc.push([OP.BUILD_OBJECT, node.properties.length]);
        break;
      }

      default: {
        const src = generate(node).code;
        throw new Error(`Unsupported expression: ${node.type}\n  → ${src}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Serializer
// Turns the compiled output into a commented JS source string.
// ─────────────────────────────────────────────────────────────────
class Serializer {
  compiler: Compiler;

  constructor(compiler: Compiler) {
    this.compiler = compiler;
  }

  get constants() {
    return this.compiler.constants.items;
  }

  get fnDescriptors() {
    return this.compiler.fnDescriptors;
  }

  // Produce a JS literal for a constant pool entry
  _serializeConst(val) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    if (typeof val === "object" && val._fnIdx !== undefined) {
      return `FN[${val._fnIdx}]`; // fn descriptor → reference by FN index
    }
    return JSON.stringify(val); // number / string / bool
  }

  // One instruction → "[op, operand]  // MNEMONIC description"
  _serializeInstr(instr) {
    const constants = this.constants;

    const [op, operand] = instr;
    const name = OP_NAME[op] || `OP_${op}`;
    let comment = name;

    // Annotate operand with its meaning
    if (operand !== undefined) {
      switch (op) {
        case OP.LOAD_CONST:
        case OP.MAKE_CLOSURE: {
          const val = constants[operand];
          if (val && typeof val === "object" && val.name) {
            comment += `  FN[${val._fnIdx}] → fn:${val.name}`;
          } else {
            comment += `  ${JSON.stringify(val)}`;
          }
          break;
        }
        case OP.LOAD_LOCAL:
        case OP.STORE_LOCAL:
          comment += `  slot[${operand}]`;
          break;
        case OP.LOAD_UPVALUE:
        case OP.STORE_UPVALUE:
          comment += `  upvalue[${operand}]`;
          break;
        case OP.LOAD_GLOBAL:
        case OP.STORE_GLOBAL:
          comment += `  "${constants[operand]}"`;
          break;
        case OP.CALL:
        case OP.CALL_METHOD:
          comment += `  (${operand} args)`;
          break;

        case OP.BUILD_ARRAY:
          comment += `  (${operand} elements)`;
          break;
        case OP.BUILD_OBJECT:
          comment += `  (${operand} pairs)`;
          break;

        case OP.NEW:
          comment += `  (${operand} args)`;
          break;

        default:
          comment += `  ${operand}`;
      }
    }

    // Pack a [op, operand?] instruction pair into a single 32-bit word.
    // Shared between the Serializer and the obfuscation path in _compileMain.

    if (!PACK) {
      const instrText =
        operand !== undefined ? `[${op}, ${operand}]` : `[${op}]`;

      return {
        text: `      ${instrText.padEnd(12)}, // ${comment}`,
        value: operand !== undefined ? [op, operand] : [op],
      };
    }

    function packInstr(instr) {
      const [op, operand] = instr;
      if (operand !== undefined && !Number.isInteger(operand))
        throw new Error(`Non-integer operand: ${operand}`);
      if (operand !== undefined && operand < 0)
        throw new Error(`Negative operand: ${operand}`);
      if (operand !== undefined && operand > 0xffffff)
        throw new Error(`Operand overflow (max 0xFFFFFF): ${operand}`);
      return operand !== undefined ? (operand << 8) | op : op;
    }

    return {
      text: "",
      value: packInstr(instr),
    };
  }

  // Serialize one fn descriptor into its FN[n] block
  _serializeFn(desc) {
    const lines = [
      `  {                       // FN[${desc._fnIdx}] — ${desc.name}`,
      `    paramCount: ${desc.paramCount},`,
      `    localCount: ${desc.localCount},`,
      `    upvalueDescriptors: ${JSON5.stringify(desc.upvalueDescriptors)},`,
      `    startPc: ${desc.startPc},`,
      `  },`,
    ];
    return lines.join("\n");
  }

  // Serialize the CONSTANTS array, showing FN[n] references
  _serializeConstants() {
    const lines = ["var CONSTANTS = ["];
    this.constants.forEach((val, idx) => {
      lines.push(`  /* ${idx} */  ${this._serializeConst(val)},`);
    });
    lines.push("];");
    return lines.join("\n");
  }

  _serializeBytecode(bytecode) {
    if (!PACK) {
      return bytecode.map((instr) => this._serializeInstr(instr).value);
    }

    let words = [];

    // ── BYTECODE
    for (const instr of bytecode) {
      words.push(this._serializeInstr(instr).value);
    }

    // Convert packed words → raw 4-byte little-endian binary → base64
    const buf = new Uint8Array(words.length * 4);
    words.forEach((w, i) => {
      buf[i * 4] = w & 0xff;
      buf[i * 4 + 1] = (w >>> 8) & 0xff;
      buf[i * 4 + 2] = (w >>> 16) & 0xff;
      buf[i * 4 + 3] = (w >>> 24) & 0xff;
    });
    const b64 = Buffer.from(buf).toString("base64");

    return b64;
  }

  serialize(bytecode, mainStartPc) {
    const sections = [];

    // ── FN array
    const fnLines = ["var FN = ["];
    for (const desc of this.fnDescriptors) {
      fnLines.push(this._serializeFn(desc));
    }
    fnLines.push("];");
    sections.push(fnLines.join("\n"));

    // ── CONSTANTS
    sections.push(this._serializeConstants());

    if (PACK) {
      sections.push(`var BYTECODE = "${this._serializeBytecode(bytecode)}";`);
    } else {
      sections.push(
        `var BYTECODE = [\n  ${bytecode.map((instr) => this._serializeInstr(instr).text).join(",\n  ")}\n];`,
      );
    }

    // ── MAIN_START_PC
    sections.push(`var MAIN_START_PC = ${mainStartPc};`);

    sections.push(`var PACK = ${PACK};`);

    // ── VM runtime
    sections.push(VM_RUNTIME);

    return sections.join("\n\n");
  }
}

// ─────────────────────────────────────────────────────────────────
// VM Runtime (emitted verbatim into the output file)
// ─────────────────────────────────────────────────────────────────
const VM_RUNTIME = `
// ── Opcodes ──────────────────────────────────────────────────────
var OP = ${JSON5.stringify(OP)};
${stripTypeScriptTypes(
  readFileSync(join(import.meta.dirname, "./runtime.ts"), "utf-8").split(
    "@START",
  )[1],
)}
`;

interface Options {
  sourceMap?: boolean;
  selfModifying?: boolean;
}

export function compileAndSerialize(
  sourceCode: string,
  options: Options = {
    selfModifying: true,
  },
) {
  const compiler = new Compiler(options);
  const result = compiler.compile(sourceCode);
  const output = compiler.serializer.serialize(
    result.bytecode,
    result.mainStartPc,
  );

  const finalOutput = output;

  return {
    code: finalOutput,
  };
}
