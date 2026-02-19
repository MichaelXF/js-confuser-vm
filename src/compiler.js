// transform.js
// Usage: node transform.js
// Requires: npm install @babel/parser @babel/traverse @babel/generator

import parser from "@babel/parser";
import traverseImport from "@babel/traverse";
import generateImport from "@babel/generator";

const traverse = traverseImport.default;
const generate = generateImport;

// ── Opcodes ──────────────────────────────────────────────────────
const OP = {
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
};
// Reverse map for comment generation
const OP_NAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

// ─────────────────────────────────────────────────────────────────
// Constant Pool
// Primitives (string/number/bool) are interned (deduped).
// Object entries (fn descriptors) are always appended — no dedup.
// ─────────────────────────────────────────────────────────────────
class ConstantPool {
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
  constructor(parentCtx = null) {
    this.parentCtx = parentCtx;
    this.scope = new Scope();
    this.upvalues = []; // { name, isLocal, index }
    this.bc = [];
  }

  // Find or register a captured variable as an upvalue.
  // isLocal=true  → captured directly from parent's locals[index]
  // isLocal=false → relayed from parent's own upvalue list[index]
  addUpvalue(name, isLocal, index) {
    const existing = this.upvalues.findIndex((u) => u.name === name);
    if (existing !== -1) return existing;
    const idx = this.upvalues.length;
    this.upvalues.push({ name, isLocal, index });
    return idx;
  }
}

// ─────────────────────────────────────────────────────────────────
// Compiler
// ─────────────────────────────────────────────────────────────────
class Compiler {
  constructor() {
    this.constants = new ConstantPool();
    this.fnDescriptors = []; // populated in pass 1
    this.mainBytecode = [];
    this._currentCtx = null; // FnContext of the function being compiled, null at top-level
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

    // Pass 2 — compile top-level statements into MAIN_BYTECODE.
    this._compileMain(ast.program.body);

    return {
      constants: this.constants.items,
      fnDescriptors: this.fnDescriptors,
      mainBytecode: this.mainBytecode,
    };
  }

  // ── Function Declaration ──────────────────────────────────────

  _compileFunctionDecl(node) {
    // Create a context whose parent is whatever we're currently compiling.
    // This is what lets _resolve cross function boundaries correctly.
    const ctx = new FnContext(this._currentCtx);
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

    const desc = {
      name: node.id ? node.id.name : "<anonymous>",
      paramCount: node.params.length,
      localCount: ctx.scope.localCount,
      upvalueDescriptors: ctx.upvalues.map((u) => ({
        isLocal: u.isLocal,
        index: u.index,
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
    const bc = this.mainBytecode;

    // Hoist all FunctionDeclarations: MAKE_CLOSURE → STORE_GLOBAL
    // (mirrors JS hoisting — functions are available before other code)
    for (const node of body) {
      if (node.type !== "FunctionDeclaration") continue;
      const desc = this.fnDescriptors.find((d) => d.name === node.id.name);
      const nameIdx = this.constants.intern(node.id.name);
      bc.push([OP.MAKE_CLOSURE, desc._constIdx]);
      bc.push([OP.STORE_GLOBAL, nameIdx]);
    }

    // Compile everything else in order
    for (const node of body) {
      if (node.type === "FunctionDeclaration") continue;
      this._compileStatement(node, null, bc); // null scope → global context
    }
  }

  // ── Statements ───────────────────────────────────────────────

  _compileStatement(node, scope, bc) {
    switch (node.type) {
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
        for (const stmt of node.consequent.body) {
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
        // ┌─ loop header ──────────────────────────────────────────┐
        // │  Save the address of the test — the back-edge JUMP     │
        // │  will return here every iteration.                     │
        // └────────────────────────────────────────────────────────┘
        const loopTop = bc.length;
        // 1. Compile test → leaves boolean on stack
        this._compileExpr(node.test, scope, bc);
        // 2. If test is false, jump out — target patched after body
        bc.push([OP.JUMP_IF_FALSE, 0]);
        const exitJumpIdx = bc.length - 1;
        // 3. Compile body
        for (const stmt of node.body.body) {
          this._compileStatement(stmt, scope, bc);
        }
        // 4. Unconditional back-edge — jump to loop header
        bc.push([OP.JUMP, loopTop]);
        // 5. Patch the exit jump to land here (after the back-edge)
        bc[exitJumpIdx][1] = bc.length;
        break;
      }

      case "DoWhileStatement": {
        // ┌─ loop body ─────────────────────────────────────────────┐
        // │  Body runs unconditionally on the first iteration.      │
        // │  Test sits at the BOTTOM — jump back only if truthy.    │
        // └─────────────────────────────────────────────────────────┘
        const loopTop = bc.length; // address of first body instruction

        // 1. Compile body
        for (const stmt of node.body.body) {
          this._compileStatement(stmt, scope, bc);
        }

        // 2. Compile test — leaves boolean on stack
        this._compileExpr(node.test, scope, bc);

        // 3. If test is falsy → exit loop (jump over back-edge)
        bc.push([OP.JUMP_IF_FALSE, 0]);
        const exitJumpIdx = bc.length - 1;

        // 4. Truthy → back-edge to top of body
        bc.push([OP.JUMP, loopTop]);

        // 5. Patch exit jump to land here
        bc[exitJumpIdx][1] = bc.length;
        break;
      }

      case "ForStatement": {
        // for (init; test; update) { body }
        // Compiles to the exact same shape as while, just with
        // init hoisted before the header and update appended to the body.
        // 1. Init (e.g. var i = 0) — runs once before the loop
        if (node.init) {
          if (node.init.type === "VariableDeclaration") {
            this._compileStatement(node.init, scope, bc);
          } else {
            // bare expression init (e.g. i = 0)
            this._compileExpr(node.init, scope, bc);
            bc.push([OP.POP]);
          }
        }
        // 2. Loop header — test evaluated every iteration
        const loopTop = bc.length;
        if (node.test) {
          this._compileExpr(node.test, scope, bc);
          bc.push([OP.JUMP_IF_FALSE, 0]);
        }
        const exitJumpIdx = node.test ? bc.length - 1 : null;
        // 3. Body
        for (const stmt of node.body.body) {
          this._compileStatement(stmt, scope, bc);
        }
        // 4. Update expression (e.g. i++) — runs at end of each iteration
        if (node.update) {
          this._compileExpr(node.update, scope, bc);
          bc.push([OP.POP]); // update result is always discarded
        }
        // 5. Back-edge
        bc.push([OP.JUMP, loopTop]);
        // 6. Patch exit
        if (exitJumpIdx !== null) bc[exitJumpIdx][1] = bc.length;
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
          "==": OP.EQ,
          "<=": OP.LTE,
          ">=": OP.GTE,
          "!==": OP.NEQ,
          "!=": OP.NEQ,
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
        const bump = node.operator === "++" ? [OP.ADD] : [OP.SUB];
        const one = this.constants.intern(1);
        if (res.kind === "local") {
          bc.push([OP.LOAD_LOCAL, res.slot]);
          bc.push([OP.LOAD_CONST, one]);
          bc.push(bump);
          bc.push([OP.STORE_LOCAL, res.slot]);
          bc.push([OP.LOAD_LOCAL, res.slot]);
        } else if (res.kind === "upvalue") {
          bc.push([OP.LOAD_UPVALUE, res.index]);
          bc.push([OP.LOAD_CONST, one]);
          bc.push(bump);
          bc.push([OP.STORE_UPVALUE, res.index]);
          bc.push([OP.LOAD_UPVALUE, res.index]);
        } else {
          const nameIdx = this.constants.intern(node.argument.name);
          bc.push([OP.LOAD_GLOBAL, nameIdx]);
          bc.push([OP.LOAD_CONST, one]);
          bc.push(bump);
          bc.push([OP.STORE_GLOBAL, nameIdx]);
          bc.push([OP.LOAD_GLOBAL, nameIdx]);
        }
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
  constructor(constants, fnDescriptors) {
    this.constants = constants;
    this.fnDescriptors = fnDescriptors;
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
  _serializeInstr(instr, constants) {
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

    const instrText = operand !== undefined ? `[${op}, ${operand}]` : `[${op}]`;

    return `      ${instrText.padEnd(12)}, // ${comment}`;
  }

  // Serialize one fn descriptor into its FN[n] block
  _serializeFn(desc) {
    const lines = [
      `  {                       // FN[${desc._fnIdx}] — ${desc.name}`,
      `    name:       ${JSON.stringify(desc.name)},`,
      `    paramCount: ${desc.paramCount},`,
      `    localCount: ${desc.localCount},`,
      `    upvalueDescriptors: ${JSON.stringify(desc.upvalueDescriptors)},`,
      `    bytecode: [`,
    ];
    for (const instr of desc.bytecode) {
      lines.push(this._serializeInstr(instr, this.constants));
    }
    lines.push("    ],");
    lines.push("  },");
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

  serialize(mainBytecode) {
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

    // ── MAIN_BYTECODE
    const mainLines = ["var MAIN_BYTECODE = ["];
    for (const instr of mainBytecode) {
      mainLines.push(this._serializeInstr(instr, this.constants));
    }
    mainLines.push("];");
    sections.push(mainLines.join("\n"));

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
var OP = ${JSON.stringify(OP)};

// ── Upvalue ───────────────────────────────────────────────────────
// While the outer frame is alive: reads/writes go to frame.locals[slot].
// After the outer frame returns (closed): reads/writes hit this.value.
function Upvalue(frame, slot) {
  this.frame  = frame;
  this.slot   = slot;
  this.closed = false;
  this.value  = undefined;
}
Upvalue.prototype.read  = function()  {
  return this.closed ? this.value : this.frame.locals[this.slot];
};
Upvalue.prototype.write = function(v) {
  if (this.closed) this.value = v;
  else this.frame.locals[this.slot] = v;
};
Upvalue.prototype.close = function()  {
  this.value  = this.frame.locals[this.slot];
  this.closed = true;
};

// ── Closure & Frame ───────────────────────────────────────────────
function Closure(fn) {
  this.fn = fn;
  this.upvalues = [];
  this.prototype = {};   // ← default prototype object for \`new\`
}

function Frame(closure, returnPc, parent, thisVal) {
  this.closure   = closure;
  this.locals    = new Array(closure.fn.localCount).fill(undefined);
  this.pc        = 0;
  this.returnPc  = returnPc;  // pc to resume in parent frame after RETURN
  this.parent    = parent;
  this.thisVal  = thisVal !== undefined ? thisVal : undefined; 
  this._newObj  = null;   // ← set by NEW so RETURN can see it
}

// ── VM ────────────────────────────────────────────────────────────
function VM(mainBytecode, constants, globals) {
  this.constants  = constants;
  this.globals    = globals;
  this.stack      = [];
  this.frameStack = [];
  this.openUpvalues = [];  // all currently open Upvalue objects across all frames

  var mainFn = { name:'<main>', paramCount:0, localCount:0, bytecode:mainBytecode };
  this.currentFrame = new Frame(new Closure(mainFn), null, null);
}

VM.prototype.push = function(v) { this.stack.push(v); };
VM.prototype.pop  = function()  { return this.stack.pop(); };
VM.prototype.peek = function()  { return this.stack[this.stack.length - 1]; };

VM.prototype.captureUpvalue = function(frame, slot) {
  // Reuse existing open upvalue for this frame+slot if one exists.
  // This is what makes two closures share the same mutable cell.
  for (var i = 0; i < this.openUpvalues.length; i++) {
    var uv = this.openUpvalues[i];
    if (uv.frame === frame && uv.slot === slot) return uv;
  }
  var uv = new Upvalue(frame, slot);
  this.openUpvalues.push(uv);
  return uv;
};

VM.prototype.closeUpvaluesFor = function(frame) {
  // Called on RETURN — close every upvalue that was pointing into this frame.
  // After this, closures that captured from the frame read from upvalue.value.
  this.openUpvalues = this.openUpvalues.filter(function(uv) {
    if (uv.frame === frame) { uv.close(); return false; }
    return true;
  });
};

VM.prototype.run = function() {
  while (true) {
    var frame = this.currentFrame;
    var bc    = frame.closure.fn.bytecode;
    if (frame.pc >= bc.length) break;

    var instr   = bc[frame.pc++];
    var op      = instr[0];
    var operand = instr[1];

    switch (op) {

      case OP.LOAD_CONST:
        this.push(this.constants[operand]);
        break;

      case OP.LOAD_LOCAL:
        this.push(frame.locals[operand]);
        break;

      case OP.STORE_LOCAL:
        frame.locals[operand] = this.pop();
        break;

      case OP.LOAD_GLOBAL:
        this.push(this.globals[this.constants[operand]]);
        break;

      case OP.STORE_GLOBAL:
        this.globals[this.constants[operand]] = this.pop();
        break;

      case OP.GET_PROP: {
        // Stack: [..., obj, key] → [..., obj, obj[key]]
        // obj is PEEKED (not popped) — CALL_METHOD needs it as receiver
        var key = this.pop();
        var obj = this.peek();
        this.push(obj[key]);
        break;
      }

      case OP.ADD: { var b = this.pop(); this.push(this.pop() + b); break; }
      case OP.SUB: { var b = this.pop(); this.push(this.pop() - b); break; }
      case OP.MUL: { var b = this.pop(); this.push(this.pop() * b); break; }
      case OP.DIV: { var b = this.pop(); this.push(this.pop() / b); break; }
      case OP.MOD:  { var b = this.pop(); this.push(this.pop() % b);   break; }
      case OP.BAND: { var b = this.pop(); this.push(this.pop() & b);   break; }
      case OP.BOR:  { var b = this.pop(); this.push(this.pop() | b);   break; }
      case OP.BXOR: { var b = this.pop(); this.push(this.pop() ^ b);   break; }
      case OP.SHL:  { var b = this.pop(); this.push(this.pop() << b);  break; }
      case OP.SHR:  { var b = this.pop(); this.push(this.pop() >> b);  break; }
      case OP.USHR: { var b = this.pop(); this.push(this.pop() >>> b); break; }

      case OP.LT: { var b = this.pop(); this.push(this.pop() < b);  break; }
      case OP.GT: { var b = this.pop(); this.push(this.pop() > b);  break; }
      case OP.EQ: { var b = this.pop(); this.push(this.pop() === b); break; }

      case OP.LTE: { var b = this.pop(); this.push(this.pop() <= b); break; }
      case OP.GTE: { var b = this.pop(); this.push(this.pop() >= b); break; }
      case OP.NEQ: { var b = this.pop(); this.push(this.pop() !== b); break; }

      case OP.IN: {
        var b = this.pop();
        this.push(this.pop() in b);
        break;
      }

      case OP.INSTANCEOF: {
        var ctor = this.pop();
        var obj  = this.pop();
        if (typeof ctor === 'function') {
          // Native constructor (e.g. Array, Date) — native instanceof is fine
          this.push(obj instanceof ctor);
        } else {
          // VM Closure — ctor.prototype was set by MAKE_CLOSURE / user assignment.
          // Walk obj's prototype chain looking for identity with ctor.prototype.
          var proto  = ctor.prototype;          // the .prototype property on the Closure
          var target = Object.getPrototypeOf(obj);
          var result = false;
          while (target !== null) {
            if (target === proto) { result = true; break; }
            target = Object.getPrototypeOf(target);
          }
          this.push(result);
        }
        break;
      }

      case OP.UNARY_NEG:    this.push(-this.pop());          break;
      case OP.UNARY_POS:    this.push(this.pop());          break;
      case OP.UNARY_NOT:    this.push(!this.pop());          break;
      case OP.UNARY_BITNOT: this.push(~this.pop());          break;
      case OP.TYPEOF:       this.push(typeof this.pop());    break;
      case OP.VOID:         this.pop(); this.push(undefined); break;

      case OP.TYPEOF_SAFE: {
        // operand is a const index holding the variable name string.
        // Mimics JS semantics: typeof undeclaredVar === "undefined" (no throw).
        var name = this.pop();  // LOAD_CONST pushed the name — consume it
        var val  = Object.prototype.hasOwnProperty.call(this.globals, name)
          ? this.globals[name]
          : undefined;
        this.push(typeof val);
        break;
      }

      case OP.JUMP:
        frame.pc = operand;
        break;

      case OP.JUMP_IF_FALSE:
        if (!this.pop()) frame.pc = operand;
        break;

      case OP.JUMP_IF_TRUE_OR_POP:
        // || semantics: if truthy, we're done — leave value, jump over RHS.
        // If falsy, discard it and fall through to evaluate RHS.
        if (this.peek()) { frame.pc = operand; } else { this.pop(); }
        break;

      case OP.JUMP_IF_FALSE_OR_POP:
        // && semantics: if falsy, we're done — leave value, jump over RHS.
        // If truthy, discard it and fall through to evaluate RHS.
        if (!this.peek()) { frame.pc = operand; } else { this.pop(); }
        break;

      case OP.MAKE_CLOSURE: {
        var fn       = this.constants[operand];
        var closure  = new Closure(fn);
        for (var i = 0; i < fn.upvalueDescriptors.length; i++) {
          var desc = fn.upvalueDescriptors[i];
          if (desc.isLocal) {
            // Capture directly from current frame's local slot
            closure.upvalues.push(this.captureUpvalue(frame, desc.index));
          } else {
            // Relay — take upvalue from the enclosing closure's list
            closure.upvalues.push(frame.closure.upvalues[desc.index]);
          }
        }
        this.push(closure);
        break;
      }

      case OP.LOAD_UPVALUE:
        this.push(frame.closure.upvalues[operand].read());
        break;

      case OP.STORE_UPVALUE:
        frame.closure.upvalues[operand].write(this.pop());
        break;

      case OP.BUILD_ARRAY: {
        // Pop \`operand\` values off the stack in reverse, assemble array.
        var elems = this.stack.splice(this.stack.length - operand);
        this.push(elems);
        break;
      }
      
      case OP.BUILD_OBJECT: {
        // Stack has: key0, val0, key1, val1 ... keyN, valN  (pushed left→right)
        // Pop all pairs and build the object.
        var pairs = this.stack.splice(this.stack.length - operand * 2);
        var o = {};
        for (var i = 0; i < pairs.length; i += 2) {
          o[pairs[i]] = pairs[i + 1];   // key at even index, val at odd
        }
        this.push(o);
        break;
      }
      case OP.SET_PROP: {
        // Stack: [..., obj, key, val]
        // Leaves val on stack — assignment is an expression in JS.
        var val = this.pop();
        var key = this.pop();
        var obj = this.pop();   
        obj[key] = val;
        this.push(val);          // assignment expression evaluates to the assigned value
        break;
      }
      case OP.GET_PROP_COMPUTED: {
        // Stack: [..., obj, key]  — key is a runtime value (nums[i])
        // Mirrors GET_PROP but pops the key that was pushed dynamically.
        var key = this.pop();
        var obj = this.pop();
        this.push(obj[key]);
        break;
      }
      case OP.DELETE_PROP: {
        var key = this.pop();
        var obj = this.pop();
        this.push(delete obj[key]);
        break;
      }

      case OP.CALL: {
        var args   = this.stack.splice(this.stack.length - operand);
        var callee = this.pop();
        if (typeof callee === 'function') {
          this.push(callee.apply(null, args));
        } else {
          var f = new Frame(callee, frame.pc, frame, undefined); // ← pass undefined as thisVal
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[callee.fn.paramCount] = args;  // ← arguments slot
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        }
        break;
      }

      case OP.CALL_METHOD: {
        var args     = this.stack.splice(this.stack.length - operand);
        var callee   = this.pop();
        var receiver = this.pop();  // left on stack by GET_PROP
        if (typeof callee === 'function') {
          this.push(callee.apply(receiver, args));
        } else {
          var f = new Frame(callee, frame.pc, frame, receiver); // ← pass receiver as thisVal
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[callee.fn.paramCount] = args;  // ← arguments slot
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        }
        break;
      }

      case OP.LOAD_THIS:
        this.push(frame.thisVal);
        break;

      case OP.NEW: {
        var args    = this.stack.splice(this.stack.length - operand);
        var callee  = this.pop();
        var newObj  = Object.create(callee.prototype || null);  // respects MyClass.prototype
        if (typeof callee === 'function') {
          // Native function constructor (e.g. new Date())
          var result = callee.apply(newObj, args);
          this.push((typeof result === 'object' && result !== null) ? result : newObj);
        } else {
          // VM closure constructor
          var f = new Frame(callee, frame.pc, frame, newObj);   // this = newObj
          f._newObj = newObj;                                    // remember for RETURN
          for (var i = 0; i < args.length; i++) f.locals[i] = args[i];
          f.locals[callee.fn.paramCount] = args;  // ← arguments slot
          this.frameStack.push(this.currentFrame);
          this.currentFrame = f;
        }
        break;
      } 


      case OP.RETURN: {
        var retVal = this.pop();
        this.closeUpvaluesFor(frame);  // must happen before frame is abandoned
        if (this.frameStack.length === 0) return retVal;

        // new-call rule: primitive return → discard, use the constructed object instead
        if (frame._newObj !== null) {
          if (typeof retVal !== 'object' || retVal === null) retVal = frame._newObj;
        }

        this.currentFrame = this.frameStack.pop();
        this.push(retVal);
        break;
      }

      case OP.POP:
        this.pop();
        break;

      default:
        throw new Error('Unknown opcode: ' + op + ' at pc ' + (frame.pc - 1));
    }
  }
};

// ── Boot ─────────────────────────────────────────────────────────
var globals = typeof window !== 'undefined' ? window : global; // global object for globals

globals.undefined = undefined; 
globals.null = null;            
globals.Infinity = Infinity;     
globals.NaN = NaN; 

var vm = new VM(MAIN_BYTECODE, CONSTANTS, globals);
vm.run();
`;

export function compileAndSerialize(SOURCE) {
  const compiler = new Compiler();
  const result = compiler.compile(SOURCE);
  const serializer = new Serializer(result.constants, result.fnDescriptors);
  const output = serializer.serialize(result.mainBytecode);

  return output;
}
