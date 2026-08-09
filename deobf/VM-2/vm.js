#!/usr/bin/env node
/**
 * vm.js — AST deobfuscator for the "state-array control-flow-flattening" technique
 *         used by JS-Confuser / JS-Confuser-VM samples (see ./input.js).
 *
 * The technique
 * -------------
 *   Every function of the original program is turned into a *state array* of
 *   numbers.  A shared dispatcher
 *
 *        function bh(bb, bc = {...}, bd, bk) {
 *          while (sum(bb) !== EXIT) {
 *            switch (sum(bb)) {
 *              case <expr over bb>: <real code>; bb[i] += bb[j] - K, ...; break;
 *              ...
 *            }
 *          }
 *        }
 *
 *   executes it: the "program counter" is the *sum* of the array, and a basic
 *   block jumps by adding constants to a handful of slots.  Every `case` test is
 *   an arithmetic expression over the (constant) slots of the very same array,
 *   so nothing can be matched syntactically — the array has to be interpreted.
 *
 *   On top of that:
 *     * functions are outlined into the same dispatcher and reached through
 *       trampolines   `function(...a){ return bh([<state>], scope, bd, a) }`
 *     * locals are lifted into "scope" objects (variable masking)
 *     * strings are concealed behind `be(seed, index, length)` decoders
 *     * opaque predicates guard dead branches
 *
 * The solution
 * ------------
 *   1. Detect  `while (S(X) !== N) { switch (S(X)) { ... } }`  dispatchers and
 *      evaluate the pure top level helpers (state pool, string table, decoders)
 *      so their calls can be folded for real instead of reimplemented.
 *   2. Symbolically execute each dispatcher from its concrete entry state,
 *      recovering a real control flow graph: every distinct state array is a
 *      basic block, statically decidable predicates are folded away, and the
 *      remaining `if`s become real CFG edges.
 *   3. Re-structure that CFG into `if / else / while / break / continue`
 *      (dominator + post-dominator based structuring).
 *   4. Un-outline: specialise the dispatcher per state array, recursively for
 *      the generic trampolines whose state arrives through the argument list,
 *      until the trampoline registry and the emitted set stop changing.
 *   5. Recover the payload's concealed strings by running the already recovered
 *      program once in an inert sandbox and folding the call sites whose
 *      decoder is provably a function of its literal arguments alone; the
 *      result is verified by re-running and diffing the observable behaviour.
 *   6. Readability: drop `(1, f)` this-guards, bind repeated masked scope paths
 *      to locals, fold the constants the decoded strings unlock, and remove the
 *      dead branches and unreachable statements that leaves behind.
 *
 * Nothing is folded or removed unless it is provably safe, and step 5 reverts
 * itself if the program's behaviour changes at all: a less readable output is
 * always preferred to a wrong one.
 *
 * Usage
 * -----
 *      $ node vm.js input.js output.js        [--no-strings] [--quiet]
 *      > require('./vm.js')('input.js')       // -> deobfuscated source string
 *
 * See NOTES.md for the analysis this is based on, and `node test.js` for the
 * checks (including a second, independently generated sample).
 */

"use strict";

const fs = require("fs");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const traverse = require("@babel/traverse").default;
const t = require("@babel/types");

/* ------------------------------------------------------------------ *
 * small helpers                                                       *
 * ------------------------------------------------------------------ */

/** Canonical dotted path for `a`, `a.b`, `a["b"]["c"]` … or null. */
function pathOf(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression") {
    const obj = pathOf(node.object);
    if (obj === null) return null;
    let key;
    if (!node.computed && node.property.type === "Identifier") key = node.property.name;
    else if (node.property.type === "StringLiteral") key = node.property.value;
    else return null;
    return obj + "." + key;
  }
  return null;
}

function rootOf(path) {
  const i = path.indexOf(".");
  return i === -1 ? path : path.slice(0, i);
}

function numLit(v) {
  return v < 0 ? t.unaryExpression("-", t.numericLiteral(-v)) : t.numericLiteral(v);
}

function literalOf(v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return t.identifier("NaN");
    if (!Number.isFinite(v)) {
      const inf = t.binaryExpression("/", t.numericLiteral(1), t.numericLiteral(0));
      return v < 0 ? t.unaryExpression("-", inf) : inf;
    }
    return numLit(v);
  }
  if (typeof v === "string") return t.stringLiteral(v);
  if (typeof v === "boolean") return t.booleanLiteral(v);
  if (v === null) return t.nullLiteral();
  if (v === undefined) return t.identifier("undefined");
  return null;
}

const sumArr = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

const keyOf = (a) => a.join(",");

/** Statements of a `BlockStatement` / single statement. */
function bodyOf(node) {
  if (!node) return [];
  return node.type === "BlockStatement" ? node.body : [node];
}

/* ------------------------------------------------------------------ *
 * 1. detection                                                        *
 * ------------------------------------------------------------------ */

/**
 * A dispatcher is  `while (SUM(X) !== <n>) { switch (SUM(X)) { … } }`
 * where SUM is a one argument function and X is the same expression twice.
 */
function asDispatcher(node, sumName) {
  if (!node || node.type !== "WhileStatement") return null;
  const test = node.test;
  if (!test || test.type !== "BinaryExpression") return null;
  if (test.operator !== "!==" && test.operator !== "!=") return null;
  const call = test.left;
  if (!call || call.type !== "CallExpression") return null;
  if (call.callee.type !== "Identifier") return null;
  if (sumName && call.callee.name !== sumName) return null;
  if (call.arguments.length !== 1) return null;
  const body = bodyOf(node.body).filter((s) => s.type !== "EmptyStatement");
  if (body.length !== 1 || body[0].type !== "SwitchStatement") return null;
  const sw = body[0];
  const d = sw.discriminant;
  if (
    !d ||
    d.type !== "CallExpression" ||
    d.callee.type !== "Identifier" ||
    d.callee.name !== call.callee.name ||
    d.arguments.length !== 1
  )
    return null;
  const p1 = pathOf(call.arguments[0]);
  const p2 = pathOf(d.arguments[0]);
  if (p1 === null || p1 !== p2) return null;
  return { sumName: call.callee.name, statePath: p1, exitTest: test.right, switch: sw };
}

/** Locate the sum helper by looking for the dispatcher shape anywhere. */
function findSumName(ast) {
  const counts = new Map();
  traverse(ast, {
    WhileStatement(p) {
      const d = asDispatcher(p.node, null);
      if (d) counts.set(d.sumName, (counts.get(d.sumName) || 0) + 1);
    },
  });
  let best = null;
  let bestN = 0;
  for (const [name, n] of counts) if (n > bestN) ((best = name), (bestN = n));
  return best;
}

/* ------------------------------------------------------------------ *
 * 2. the pure top level helper sandbox                                *
 * ------------------------------------------------------------------ */

/**
 * Top level declarations that contain no dispatcher are pure data / decoders
 * (state pool, string table, hash, sum, slice, string decoder).  They are
 * evaluated once so that calls with literal arguments can be folded.
 */
function buildHelpers(ast, sumName) {
  const decls = [];
  const names = [];
  for (const st of ast.program.body) {
    if (st.type !== "FunctionDeclaration" && st.type !== "VariableDeclaration") continue;
    let hasDispatcher = false;
    const sub = t.file(t.program([st]));
    traverse(sub, {
      WhileStatement(p) {
        if (asDispatcher(p.node, sumName)) hasDispatcher = true;
      },
    });
    if (hasDispatcher) continue;
    let size = 0;
    try {
      size = generate(st, { compact: true }).code.length;
    } catch (e) {
      continue;
    }
    if (size > 400000) continue;
    decls.push(st);
    if (st.type === "FunctionDeclaration") names.push(st.id.name);
    else for (const d of st.declarations) if (d.id.type === "Identifier") names.push(d.id.name);
  }
  if (!names.length) return { fns: {}, names: [] };
  const src =
    generate(t.program(decls), { compact: false }).code +
    "\nreturn {" +
    names.map((n) => JSON.stringify(n) + ":typeof " + n + '!=="undefined"?' + n + ":undefined").join(",") +
    "};";
  let fns = {};
  try {
    fns = new Function(src)();
  } catch (e) {
    fns = {};
  }
  return { fns, names };
}

/* ------------------------------------------------------------------ *
 * 3. constant evaluation over a symbolic environment                  *
 * ------------------------------------------------------------------ */

/** A statically known argument list (used to resolve outlined functions). */
class Tuple {
  constructor(items) {
    this.items = items;
  }
  static key(v) {
    if (v instanceof Tuple) return "(" + v.items.map(Tuple.key).join(";") + ")";
    if (Array.isArray(v)) return "[" + v.join(",") + "]";
    return "?";
  }
}

class Env {
  constructor(parent) {
    this.arrays = new Map(parent ? parent.arrays : undefined); // path -> number[]
    this.helpers = parent ? parent.helpers : {};
    this.blocked = new Set(parent ? parent.blocked : undefined); // shadowed roots
    this.tuple = parent ? parent.tuple : null; // concrete `arguments` list
    this.tupleName = parent ? parent.tupleName : null;
    this.tuples = new Map(parent ? parent.tuples : undefined); // path -> Tuple
    this.dispatchers = new Map(parent ? parent.dispatchers : undefined); // name -> record
    // roots re-bound by *emitted* code (as opposed to a dispatcher's own
    // parameters, which are the natural home of the scope object paths)
    this.shadowed = new Set(parent ? parent.shadowed : undefined);
  }
  getArray(path) {
    if (path === null) return undefined;
    if (this.blocked.has(rootOf(path))) return undefined;
    return this.arrays.get(path);
  }
  setArray(path, arr) {
    this.blocked.delete(rootOf(path));
    this.arrays.set(path, arr);
  }
  shadow(name) {
    this.shadowed.add(name);
    this.block(name);
  }
  block(name) {
    this.blocked.add(name);
    this.dispatchers.delete(name);
    for (const k of [...this.arrays.keys()]) if (rootOf(k) === name) this.arrays.delete(k);
    for (const k of [...this.tuples.keys()]) if (rootOf(k) === name) this.tuples.delete(k);
  }
}

const NOTHING = Symbol("not-constant");

/** true/false for a literal test expression, null when it is not decidable. */
function literalTruth(node) {
  switch (node.type) {
    case "BooleanLiteral":
      return node.value;
    case "NumericLiteral":
      return node.value !== 0;
    case "StringLiteral":
      return node.value.length > 0;
    case "NullLiteral":
      return false;
    case "Identifier":
      if (node.name === "undefined") return false;
      if (node.name === "NaN") return false;
      return null;
    case "UnaryExpression":
      if (node.operator === "!") {
        const v = literalTruth(node.argument);
        return v === null ? null : !v;
      }
      return null;
  }
  return null;
}

/**
 * A branch may only be deleted when nothing outside of it uses the bindings it
 * declares (function declarations and `var`s escape their block).
 */
function branchIsSelfContained(branchPath) {
  if (!branchPath || !branchPath.node) return true;
  let ok = true;
  const inside = (p) => {
    let cur = p;
    while (cur) {
      if (cur.node === branchPath.node) return true;
      cur = cur.parentPath;
    }
    return false;
  };
  branchPath.traverse({
    Scopable(p) {
      for (const name of Object.keys(p.scope.bindings || {})) {
        const b = p.scope.bindings[name];
        if (!b) continue;
        for (const ref of b.referencePaths.concat(b.constantViolations))
          if (!inside(ref)) ok = false;
      }
    },
  });
  if (branchPath.scope) {
    const own = branchPath.scope.bindings || {};
    for (const name of Object.keys(own)) {
      const b = own[name];
      for (const ref of b.referencePaths.concat(b.constantViolations))
        if (!inside(ref)) ok = false;
    }
  }
  return ok;
}

/** `a.b.c` (string) -> the equivalent MemberExpression. */
function buildMember(path) {
  const parts = path.split(".");
  let node = parts[0] === "this" ? t.thisExpression() : t.identifier(parts[0]);
  for (let i = 1; i < parts.length; i++)
    node = t.memberExpression(node, t.identifier(parts[i]));
  return node;
}

/**
 * The base91 + UTF-8 decoder that the obfuscator inlines into every scope,
 * rebuilt from the alphabet found in the recovered source.
 */
function decodeBase91(alphabet, input) {
  const bytes = [];
  let acc = 0;
  let bits = 0;
  let v = -1;
  const s = "" + (input || "");
  for (let i = 0; i < s.length; i++) {
    const d = alphabet.indexOf(s[i]);
    if (d === -1) continue;
    if (v < 0) {
      v = d;
    } else {
      v += d * 91;
      acc |= v << bits;
      bits += (v & 8191) > 88 ? 13 : 14;
      do {
        bytes.push(acc & 255);
        acc >>= 8;
        bits -= 8;
      } while (bits > 7);
      v = -1;
    }
  }
  if (v > -1) bytes.push((acc | (v << bits)) & 255);
  return Buffer.from(bytes).toString("utf8");
}

function unwrapSeq(node) {
  return node && node.type === "SequenceExpression"
    ? node.expressions[node.expressions.length - 1]
    : node;
}

/** Plain JS value of a simple literal node. */
function literalValue(a) {
  if (a.type === "UnaryExpression" && a.operator === "-") return -a.argument.value;
  return a.value;
}

/** Value of `node` when it is a state array literal, else null. */
function arrValue(node, env) {
  const v = ev(node, env);
  return Array.isArray(v) ? v : null;
}

/** Evaluate `node` to a JS value or NOTHING. */
function ev(node, env) {
  switch (node.type) {
    case "NumericLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "Identifier":
      if (node.name === "undefined" && !env.blocked.has("undefined")) return undefined;
      return NOTHING;
    case "UnaryExpression": {
      if (node.operator === "typeof") {
        // only safe for operands we can fully evaluate ourselves
        const a = node.argument;
        if (a.type === "Identifier" && a.name !== "undefined") return NOTHING;
        const v = ev(a, env);
        return v === NOTHING ? NOTHING : Array.isArray(v) ? "object" : typeof v;
      }
      const v = ev(node.argument, env);
      if (v === NOTHING) return NOTHING;
      switch (node.operator) {
        case "-": return -v;
        case "+": return +v;
        case "~": return ~v;
        case "!": return !v;
        case "void": return undefined;
      }
      return NOTHING;
    }
    case "BinaryExpression": {
      const a = ev(node.left, env);
      if (a === NOTHING) return NOTHING;
      const b = ev(node.right, env);
      if (b === NOTHING) return NOTHING;
      switch (node.operator) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return a % b;
        case "**": return a ** b;
        case "<<": return a << b;
        case ">>": return a >> b;
        case ">>>": return a >>> b;
        case "^": return a ^ b;
        case "&": return a & b;
        case "|": return a | b;
        case "==": return a == b;
        case "!=": return a != b;
        case "===": return a === b;
        case "!==": return a !== b;
        case "<": return a < b;
        case ">": return a > b;
        case "<=": return a <= b;
        case ">=": return a >= b;
      }
      return NOTHING;
    }
    case "LogicalExpression": {
      const a = ev(node.left, env);
      if (a === NOTHING) return NOTHING;
      if (node.operator === "&&") return a ? ev(node.right, env) : a;
      if (node.operator === "||") return a ? a : ev(node.right, env);
      if (node.operator === "??") return a === null || a === undefined ? ev(node.right, env) : a;
      return NOTHING;
    }
    case "ConditionalExpression": {
      const c = ev(node.test, env);
      if (c === NOTHING) return NOTHING;
      return ev(c ? node.consequent : node.alternate, env);
    }
    case "SequenceExpression": {
      let last = NOTHING;
      for (const e of node.expressions) last = ev(e, env);
      return last;
    }
    case "MemberExpression": {
      const arr = env.getArray(pathOf(node.object));
      if (arr && node.computed) {
        const i = ev(node.property, env);
        if (i === NOTHING) return NOTHING;
        const v = arr[i];
        return v === undefined ? NOTHING : v;
      }
      return NOTHING;
    }
    case "ArrayExpression": {
      const out = [];
      for (const el of node.elements) {
        if (el === null) return NOTHING;
        if (el.type === "SpreadElement") {
          const s = ev(el.argument, env);
          if (s === NOTHING || !Array.isArray(s)) return NOTHING;
          out.push(...s);
        } else {
          const v = ev(el, env);
          if (v === NOTHING) return NOTHING;
          out.push(v);
        }
      }
      return out;
    }
    case "CallExpression": {
      if (node.callee.type !== "Identifier") return NOTHING;
      const name = node.callee.name;
      if (env.blocked.has(name)) return NOTHING;
      const fn = env.helpers[name];
      if (typeof fn !== "function") return NOTHING;
      const args = [];
      for (const a of node.arguments) {
        if (a.type === "SpreadElement") return NOTHING;
        const v = ev(a, env);
        if (v === NOTHING) return NOTHING;
        args.push(v);
      }
      try {
        const r = fn(...args);
        if (
          typeof r === "number" ||
          typeof r === "string" ||
          typeof r === "boolean" ||
          Array.isArray(r)
        )
          return r;
      } catch (e) {
        /* ignore */
      }
      return NOTHING;
    }
  }
  return NOTHING;
}

/* ------------------------------------------------------------------ *
 * 4. AST rewriting (constant folding + trampoline specialisation)     *
 * ------------------------------------------------------------------ */

/** Names bound by a function/catch/block, used to stop constant folding. */
function boundNames(node) {
  const out = [];
  const pat = (p) => {
    if (!p) return;
    switch (p.type) {
      case "Identifier": out.push(p.name); break;
      case "AssignmentPattern": pat(p.left); break;
      case "RestElement": pat(p.argument); break;
      case "ArrayPattern": p.elements.forEach(pat); break;
      case "ObjectPattern":
        p.properties.forEach((pr) => pat(pr.type === "RestElement" ? pr.argument : pr.value));
        break;
    }
  };
  if (t.isFunction(node)) {
    node.params.forEach(pat);
    if (node.id) out.push(node.id.name);
    // var / function declarations in the body shadow too
    for (const st of bodyOf(node.body)) collectVarNames(st, out);
  } else if (node.type === "CatchClause") {
    pat(node.param);
  }
  return out;
}

/** Just the parameter names (and self reference) of a function. */
function paramNames(fn) {
  const out = [];
  const pat = (p) => {
    if (!p) return;
    switch (p.type) {
      case "Identifier": out.push(p.name); break;
      case "AssignmentPattern": pat(p.left); break;
      case "RestElement": pat(p.argument); break;
      case "ArrayPattern": p.elements.forEach(pat); break;
      case "ObjectPattern":
        p.properties.forEach((pr) => pat(pr.type === "RestElement" ? pr.argument : pr.value));
        break;
    }
  };
  fn.params.forEach(pat);
  return out;
}

function collectVarNames(st, out) {
  if (!st || typeof st.type !== "string") return;
  switch (st.type) {
    case "FunctionDeclaration":
      if (st.id) out.push(st.id.name);
      return; // do not descend
    case "VariableDeclaration":
      for (const d of st.declarations) {
        if (d.id.type === "Identifier") out.push(d.id.name);
      }
      return;
    case "IfStatement":
      collectVarNames(st.consequent, out);
      collectVarNames(st.alternate, out);
      return;
    case "ForStatement":
      collectVarNames(st.init, out);
      collectVarNames(st.body, out);
      return;
    case "ForInStatement":
    case "ForOfStatement":
      collectVarNames(st.left, out);
      collectVarNames(st.body, out);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
      collectVarNames(st.body, out);
      return;
    case "BlockStatement":
      st.body.forEach((s) => collectVarNames(s, out));
      return;
    case "TryStatement":
      collectVarNames(st.block, out);
      if (st.handler) collectVarNames(st.handler.body, out);
      collectVarNames(st.finalizer, out);
      return;
    case "SwitchStatement":
      st.cases.forEach((c) => c.consequent.forEach((s) => collectVarNames(s, out)));
      return;
  }
}

/* ------------------------------------------------------------------ *
 * 5. the deobfuscator                                                 *
 * ------------------------------------------------------------------ */

class Deobfuscator {
  constructor(ast, opts) {
    this.ast = ast;
    this.opts = opts || {};
    this.warnings = [];
    this.sumName = findSumName(ast);
    this.helpers = this.sumName ? buildHelpers(ast, this.sumName).fns : {};
    this.dispatchers = null; // FunctionDeclaration name -> node
    this.specialised = new Map(); // key -> {name, node}
    this.emitted = []; // hoisted top level function declarations
    this.trampolines = new Map(); // path -> generic dispatcher entry
    this.dispRecs = new Map(); // dispatcher AST node -> record (stable)
    this.specStack = [];
    this.dispId = 0;
    this.emitScopeId = 0;
    this.uid = 0;
    this.labelId = 0;
    this.stats = { blocks: 0, functions: 0, fallbacks: 0, trampolines: 0, deferred: 0 };
  }

  warn(msg) {
    if (this.warnings.length < 60) this.warnings.push(msg);
  }

  fresh(prefix) {
    return prefix + ++this.uid;
  }

  /* ---------------- dispatcher discovery ---------------- */

  /**
   * A dispatcher function: its body is exactly one dispatcher `while` driven by
   * its own first parameter.  These exist at the top level (the shared
   * interpreter) and as closures inside recovered code.
   */
  asDispatcherFn(fn) {
    if (!t.isFunction(fn)) return null;
    if (!fn.body || fn.body.type !== "BlockStatement") return null;
    const body = fn.body.body.filter((s) => s.type !== "EmptyStatement");
    if (body.length !== 1) return null;
    const d = asDispatcher(body[0], this.sumName);
    if (!d) return null;
    if (!fn.params.length || fn.params[0].type !== "Identifier") return null;
    if (d.statePath !== fn.params[0].name) return null;
    return d;
  }

  /**
   * Register every dispatcher declared directly inside `stmts` (they are always
   * `function NAME(state, …) { while … }`).  Their specialisations must stay in
   * the same lexical scope because they capture surrounding variables.
   */
  scanLocalDispatchers(stmts, env, emitList) {
    const found = new Set();
    for (const st of stmts) {
      let fn = null;
      let name = null;
      if (st.type === "FunctionDeclaration" && st.id) {
        fn = st;
        name = st.id.name;
      } else if (st.type === "VariableDeclaration") {
        for (const dcl of st.declarations) {
          if (
            dcl.id.type === "Identifier" &&
            dcl.init &&
            t.isFunction(dcl.init) &&
            this.asDispatcherFn(dcl.init)
          ) {
            fn = dcl.init;
            name = dcl.id.name;
          }
        }
      }
      if (!fn || !name) continue;
      const disp = this.asDispatcherFn(fn);
      if (!disp) continue;
      env.dispatchers.set(name, this.dispRecord(fn, disp, emitList, env, true));
      found.add(st);
    }
    return found;
  }

  /**
   * One record per dispatcher AST node, kept across passes so that the
   * trampoline registry never points at a stale emission list.
   */
  dispRecord(fn, disp, emitList, declEnv, local) {
    let rec = this.dispRecs.get(fn);
    if (!rec) {
      rec = { id: ++this.dispId, fn, disp };
      this.dispRecs.set(fn, rec);
    }
    rec.emitList = emitList;
    rec.declEnv = declEnv;
    rec.local = local;
    return rec;
  }

  findRootDispatchers() {
    const out = new Map();
    for (const st of this.ast.program.body) {
      if (st.type !== "FunctionDeclaration") continue;
      const disp = this.asDispatcherFn(st);
      if (!disp) continue;
      out.set(st.id.name, this.dispRecord(st, disp, this.emitted, null, false));
    }
    return out;
  }

  /* ---------------- entry point ---------------- */

  run() {
    if (!this.sumName) return null; // not this technique
    this.dispatchers = this.findRootDispatchers();
    if (!this.dispatchers.size) return null;

    // Trampolines are discovered while walking, so a call site may be reached
    // before the assignment that defines it.  Iterate until the registry is
    // stable (it only ever grows), then keep the last, fully resolved result.
    let out = null;
    for (let pass = 0; pass < 8; pass++) {
      const before = this.trampolines.size;
      out = this.pass();
      if (!out) return null;
      const missing = this.missingDefinitions(out);
      if (this.trampolines.size === before && !missing.length) break;
      if (pass === 7 && missing.length)
        this.warn("undefined after " + (pass + 1) + " passes: " + missing.join(", "));
    }
    if (this.opts.strings !== false) {
      try {
        this.inlineConcealedStrings(out);
      } catch (e) {
        this.warn("string recovery failed: " + e.message);
      }
    }
    this.postProcess(out);
    if (this.opts.readable !== false) {
      try {
        this.simplifyThisGuards(out);
        this.aliasScopePaths(out);
      } catch (e) {
        this.warn("readability pass failed: " + e.message);
      }
    }
    // final self check: nothing of the technique may be left standing
    let left = 0;
    traverse(out, {
      WhileStatement: (p) => {
        if (asDispatcher(p.node, null)) left++;
      },
    });
    this.stats.dispatchersLeft = left;
    if (left) this.warn(left + " dispatcher(s) could not be recovered");
    return out;
  }

  /** Specialisations that ended up referenced but never emitted. */
  missingDefinitions(file) {
    const defined = new Set();
    const used = new Set();
    traverse(file, {
      FunctionDeclaration(p) {
        if (p.node.id && /^fn\d+$/.test(p.node.id.name)) defined.add(p.node.id.name);
      },
      Identifier(p) {
        if (/^fn\d+$/.test(p.node.name) && p.isReferencedIdentifier()) used.add(p.node.name);
      },
    });
    return [...used].filter((n) => !defined.has(n));
  }

  pass() {
    this.specialised = new Map();
    this.emitted = [];
    this.specStack = [];
    this.warnings = [];
    this.uid = 0;
    this.labelId = 0;
    this.stats = { blocks: 0, functions: 0, fallbacks: 0, trampolines: 0, deferred: 0 };
    this.dispatchers = this.findRootDispatchers();

    // The program entry: last top-level call of a root dispatcher.
    let entry = null;
    for (let i = this.ast.program.body.length - 1; i >= 0; i--) {
      const st = this.ast.program.body[i];
      if (st.type !== "ExpressionStatement") continue;
      const e = st.expression;
      if (e.type !== "CallExpression") continue;
      const callee = e.callee.type === "SequenceExpression"
        ? e.callee.expressions[e.callee.expressions.length - 1]
        : e.callee;
      if (callee.type === "Identifier" && this.dispatchers.has(callee.name)) {
        entry = { index: i, call: e, name: callee.name };
        break;
      }
    }
    if (!entry) return null;

    const rootEnv = new Env(null);
    rootEnv.helpers = this.helpers;
    rootEnv.dispatchers = new Map(this.dispatchers);

    const state = ev(entry.call.arguments[0], rootEnv);
    if (!Array.isArray(state)) return null;

    const spec = this.specialise(this.dispatchers.get(entry.name), state, null, rootEnv);
    const callArgs = entry.call.arguments.slice(1).map((a) => this.rewrite(a, rootEnv));

    // Build the output program: helpers that survived + specialised functions.
    const program = [];
    for (const fn of this.emitted) program.push(fn);
    program.push(t.expressionStatement(t.callExpression(t.identifier(spec.name), callArgs)));

    const out = t.file(t.program(program));
    return out;
  }

  /* ---------------- specialisation ---------------- */

  /**
   * Turn `dispatcher(<state>, p1, p2, …)` into a real function
   * `function fnN(p1, p2, …) { …structured code… }` and return its name.
   *
   * `tuple` — when the dispatcher is used as a *trampoline* the arguments array
   * carries the state of the function that should really run; the caller passes
   * the already evaluated tuple so the nested dispatcher becomes concrete.
   */
  specialise(d, state, tuple, callerEnv) {
    // a closure dispatcher can be reached from several enclosing
    // specialisations; each one needs its own copy in its own scope
    const scope = d.local && d.emitList ? "@" + d.emitList.__id : "";
    const key = d.id + scope + "|" + keyOf(state) + "|" + (tuple ? Tuple.key(tuple) : "-");
    const hit = this.specialised.get(key);
    if (hit) return hit;

    const name = "fn" + this.specialised.size;
    const rec = { name, node: null, generic: false };
    this.specialised.set(key, rec);
    this.stats.functions++;

    // the body runs in the dispatcher's own lexical scope, not the caller's
    const env = new Env(d.local ? d.declEnv : null);
    env.helpers = this.helpers;
    env.arrays = new Map();
    env.tuples = new Map();
    env.tuple = null;
    env.tupleName = null;
    if (!d.local) env.dispatchers = new Map(this.dispatchers);
    // the parameters are fresh bindings: they own the scope-object paths that
    // the trampoline registry is keyed by, so un-shadow them
    for (const n of paramNames(d.fn)) {
      env.block(n);
      env.shadowed.delete(n);
    }
    if (d.fn.id) env.dispatchers.set(d.fn.id.name, d); // self recursion
    env.setArray(d.fn.params[0].name, state.slice());
    if (tuple) {
      env.tuple = tuple;
      // the last parameter receives the argument list
      const last = d.fn.params[d.fn.params.length - 1];
      if (last && last.type === "Identifier") env.tupleName = last.name;
    }

    // parameters other than the state array are kept verbatim
    const params = d.fn.params.slice(1).map((p) => t.cloneNode(p, true));

    this.specStack.push(rec);
    const stmts = this.unflattenDispatcher(d.disp, env, state);
    this.specStack.pop();

    const fnNode = t.functionDeclaration(t.identifier(name), params, t.blockStatement(stmts));
    rec.node = fnNode;
    rec.emitList = d.emitList;
    if (!rec.generic) d.emitList.push(fnNode);
    if (process.env.VMJS_DEBUG)
      console.error(
        "[spec] " + name + " generic=" + rec.generic + " local=" + !!d.local + " key=" + key.slice(0, 48)
      );
    return rec;
  }

  markGeneric() {
    if (this.specStack.length) this.specStack[this.specStack.length - 1].generic = true;
  }

  /**
   * `function (...p) { return TARGET([<state>], scope, extra, p); }`
   *
   * When the function specialised for `<state>` cannot decide which nested
   * dispatcher to run (because that state arrives through the argument list)
   * the function is a *generic trampoline*: every call site carries the real
   * state as its first argument, so specialisation happens per call site.
   * `TARGET` is either a root dispatcher or another generic trampoline, which
   * is how arbitrarily deep function nesting is encoded.
   */
  asTrampolineFactory(node, env) {
    if (!t.isFunction(node)) return null;
    if (node.params.length !== 1 || node.params[0].type !== "RestElement") return null;
    const rest = node.params[0].argument;
    if (rest.type !== "Identifier") return null;
    const body = bodyOf(node.body).filter((s) => s.type !== "EmptyStatement");
    if (body.length !== 1 || body[0].type !== "ReturnStatement" || !body[0].argument) return null;
    const call = body[0].argument;
    if (call.type !== "CallExpression") return null;
    const target = this.callTarget(call.callee, env);
    if (!target) return null;
    const args = call.arguments;
    if (!args.length) return null;
    const lastArg = args[args.length - 1];
    if (lastArg.type !== "Identifier" || lastArg.name !== rest.name) return null;
    const pre = args.slice(0, -1).map((a) => ({ node: a, value: arrValue(a, env) }));
    if (!Array.isArray(pre[0] && pre[0].value)) return null;
    const factory = { target, pre };
    // probe: is the callee generic when the argument list is unknown?
    const probe = this.resolveCall(factory.target, pre.concat([{ node: null, value: null }]), env);
    if (!probe || !probe.spec.generic) return null;
    return factory;
  }

  /** a dispatcher in scope, or a registered generic trampoline path. */
  callTarget(callee, env) {
    if (callee.type === "SequenceExpression")
      callee = callee.expressions[callee.expressions.length - 1];
    if (callee.type === "Identifier" && env.dispatchers.has(callee.name)) {
      return { kind: "disp", rec: env.dispatchers.get(callee.name) };
    }
    const p = pathOf(callee);
    if (p === null || env.shadowed.has(rootOf(p))) return null;
    if (!this.trampolines.has(p)) return null;
    return { kind: "tramp", path: p };
  }

  /**
   * Resolve `target(args…)` down to a concrete specialisation.
   * `args` is a list of `{node, value}`; the last entry is the argument list.
   */
  resolveCall(target, args, env, depth) {
    if ((depth || 0) > 12) return null;
    if (target.kind === "disp") {
      const state = args[0] && args[0].value;
      if (!Array.isArray(state)) return null;
      const lastVal = args.length > 1 ? args[args.length - 1].value : null;
      const spec = this.specialise(
        target.rec,
        state,
        lastVal instanceof Tuple ? lastVal : null,
        env
      );
      return { spec, middle: args.slice(1, -1), last: args.length > 1 ? args[args.length - 1] : null };
    }
    const f = this.trampolines.get(target.path);
    if (!f) return null;
    const nodes = args.map((a, i) =>
      i === 0 && Array.isArray(a.value) ? t.nullLiteral() : a.node
    );
    const packed = {
      node: nodes.every((n) => n !== null)
        ? t.arrayExpression(nodes)
        : null,
      value: new Tuple(args.map((a) => a.value)),
    };
    return this.resolveCall(f.target, f.pre.concat([packed]), env, (depth || 0) + 1);
  }

  /* ---------------- CFG construction ---------------- */

  unflattenDispatcher(disp, env, entryState) {
    const exit = ev(disp.exitTest, env);
    if (typeof exit !== "number") {
      this.warn("dispatcher exit value is not constant");
      return [];
    }
    const cfg = this.buildCFG(disp, env, entryState, exit);
    return this.structure(cfg);
  }

  buildCFG(disp, env, entryState, exitVal) {
    const blocks = new Map();
    const statePath = disp.statePath;
    const queue = [entryState.slice()];
    const entryKey = keyOf(entryState);
    let guard = 0;
    while (queue.length) {
      const arr = queue.pop();
      const key = keyOf(arr);
      if (blocks.has(key)) continue;
      if (++guard > 20000) {
        this.warn("CFG explosion, aborting dispatcher");
        break;
      }
      const block = { key, stmts: [], term: null };
      blocks.set(key, block);
      this.stats.blocks++;

      const cur = arr.slice();
      env.setArray(statePath, cur);
      const cs = this.caseFor(disp.switch, env, cur);
      if (!cs) {
        this.warn("no case matches state sum " + sumArr(cur));
        block.term = { k: "end" };
        continue;
      }
      const ctx = { env, statePath, exitVal, disp };
      let term;
      try {
        term = this.execStatements(cs, ctx, cur, block.stmts);
      } catch (e) {
        this.warn("exec failed: " + e.message);
        term = { k: "end" };
      }
      block.term = term || { k: "goto", key: keyOf(cur) };

      for (const s of termTargets(block.term)) {
        if (s !== EXIT && !blocks.has(s)) queue.push(s.split(",").map(Number));
      }
    }
    return { entry: entryKey, blocks, exitVal };
  }

  /** Statements of the switch case whose test evaluates to sum(arr). */
  caseFor(sw, env, arr) {
    const target = sumArr(arr);
    let idx = -1;
    let def = -1;
    for (let i = 0; i < sw.cases.length; i++) {
      const c = sw.cases[i];
      if (!c.test) {
        def = i;
        continue;
      }
      const v = ev(c.test, env);
      if (v !== NOTHING && v === target) {
        idx = i;
        break;
      }
    }
    if (idx === -1) idx = def;
    if (idx === -1) return null;
    let stmts = [];
    for (let j = idx; j < sw.cases.length; j++) {
      stmts = stmts.concat(sw.cases[j].consequent);
      if (sw.cases[j].consequent.length) break;
    }
    return stmts;
  }

  /* ---------------- symbolic execution of a case body ---------------- */

  /**
   * Executes `list` against the concrete state `arr`, appending recovered
   * statements to `out`.  Returns a terminator or null when control simply
   * runs off the end of the list.
   */
  execStatements(list, ctx, arr, out) {
    const env = ctx.env;
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      switch (st.type) {
        case "EmptyStatement":
          continue;
        case "BreakStatement":
        case "ContinueStatement":
          if (st.label) break; // labelled: treat as real code
          return this.gotoTerm(arr, ctx);
        case "ReturnStatement":
          return { k: "ret", arg: st.argument ? this.rewrite(st.argument, env) : null };
        case "ThrowStatement":
          return { k: "throw", arg: this.rewrite(st.argument, env) };
        case "BlockStatement": {
          const r = this.execStatements(st.body, ctx, arr, out);
          if (r) return r;
          continue;
        }
        case "ExpressionStatement": {
          if (this.applyStateWrites(st.expression, ctx, arr, out)) continue;
          break;
        }
        case "IfStatement": {
          env.setArray(ctx.statePath, arr);
          const v = ev(st.test, env);
          if (v !== NOTHING) {
            const branch = v ? st.consequent : st.alternate;
            if (branch) {
              const r = this.execStatements(bodyOf(branch), ctx, arr, out);
              if (r) return r;
            }
            continue;
          }
          // real, data dependent branch -> CFG fork
          const test = this.rewrite(st.test, env);
          const rest = list.slice(i + 1);
          const arrT = arr.slice();
          const arrF = arr.slice();
          const outT = [];
          const outF = [];
          let tT = this.execStatements(bodyOf(st.consequent), ctx, arrT, outT);
          if (!tT) tT = this.execStatements(rest, ctx, arrT, outT);
          let tF = st.alternate
            ? this.execStatements(bodyOf(st.alternate), ctx, arrF, outF)
            : null;
          if (!tF) tF = this.execStatements(rest, ctx, arrF, outF);
          return {
            k: "if",
            test,
            cons: { stmts: outT, term: tT || this.gotoTerm(arrT, ctx) },
            alt: { stmts: outF, term: tF || this.gotoTerm(arrF, ctx) },
          };
        }
        case "WhileStatement": {
          const nested = asDispatcher(st, this.sumName);
          if (nested) {
            env.setArray(ctx.statePath, arr);
            const sub = env.getArray(nested.statePath);
            if (sub) {
              const inner = new Env(env);
              inner.helpers = this.helpers;
              inner.setArray(ctx.statePath, arr.slice());
              const stmts = this.unflattenDispatcher(nested, inner, sub);
              out.push(...stmts);
              continue;
            }
            // expected while probing a generic trampoline: the state of the
            // function to run arrives through the argument list
            this.markGeneric();
            this.stats.deferred++;
          }
          break;
        }
      }
      // ordinary statement
      env.setArray(ctx.statePath, arr);
      this.learnBindings(st, ctx, arr);
      if (this.registerTrampolines(st, env)) continue;
      out.push(this.rewrite(st, env));
    }
    return null;
  }

  /**
   * `scope.f = function (...a) { return DISPATCH([state], …, a); };`
   * When `f` turns out to be a generic trampoline the assignment is recorded
   * and dropped — every call site is specialised instead.
   * Returns true when the whole statement was consumed.
   */
  registerTrampolines(st, env) {
    if (st.type !== "ExpressionStatement") return false;
    const parts =
      st.expression.type === "SequenceExpression" ? st.expression.expressions : [st.expression];
    let all = true;
    for (const e of parts) {
      if (e.type !== "AssignmentExpression" || e.operator !== "=") {
        all = false;
        continue;
      }
      const p = pathOf(e.left);
      if (!p) {
        all = false;
        continue;
      }
      const info = this.asTrampolineFactory(e.right, env);
      if (!info) {
        all = false;
        continue;
      }
      this.trampolines.set(p, info);
      this.stats.trampolines++;
    }
    return all && parts.length > 0;
  }

  gotoTerm(arr, ctx) {
    if (sumArr(arr) === ctx.exitVal) return { k: "goto", key: EXIT };
    return { k: "goto", key: keyOf(arr) };
  }

  /**
   * `bb[3] += bb[7] - 12, bb[9] += …` — pure state writes.  Mixed sequences are
   * split so the non-state parts stay as real code.  Returns true when the
   * whole expression was consumed.
   */
  applyStateWrites(expr, ctx, arr, out) {
    const env = ctx.env;
    const parts = expr.type === "SequenceExpression" ? expr.expressions : [expr];
    const keep = [];
    let consumedAny = false;
    for (const p of parts) {
      env.setArray(ctx.statePath, arr);
      if (
        p.type === "AssignmentExpression" &&
        p.left.type === "MemberExpression" &&
        p.left.computed &&
        pathOf(p.left.object) === ctx.statePath
      ) {
        const idx = ev(p.left.property, env);
        const val = ev(p.right, env);
        if (typeof idx === "number" && typeof val === "number") {
          if (p.operator === "+=") arr[idx] += val;
          else if (p.operator === "-=") arr[idx] -= val;
          else if (p.operator === "=") arr[idx] = val;
          else if (p.operator === "*=") arr[idx] *= val;
          else if (p.operator === "^=") arr[idx] ^= val;
          else keep.push(p);
          consumedAny = true;
          continue;
        }
      }
      keep.push(p);
    }
    if (!consumedAny) return false;
    if (keep.length) {
      env.setArray(ctx.statePath, arr);
      for (const k of keep) out.push(t.expressionStatement(this.rewrite(k, env)));
    }
    return true;
  }

  /**
   * Learn concrete state arrays produced by destructuring / assignment so that
   * the nested dispatchers become decidable.
   *
   *    [scope.a, scope.b = {..}, scope.c, scope.d] = args;
   *    scope.x.a = [ …numbers… ];
   */
  learnBindings(st, ctx, arr) {
    if (st.type !== "ExpressionStatement") return;
    const env = ctx.env;
    const parts =
      st.expression.type === "SequenceExpression" ? st.expression.expressions : [st.expression];
    for (const e of parts) {
      if (e.type !== "AssignmentExpression" || e.operator !== "=") continue;
      if (e.left.type === "ArrayPattern") {
        const src = this.tupleFor(e.right, env);
        if (!src) continue;
        e.left.elements.forEach((el, i) => {
          if (!el) return;
          const target = el.type === "AssignmentPattern" ? el.left : el;
          const p = pathOf(target);
          if (!p) return;
          const v = src.items[i];
          if (Array.isArray(v)) env.setArray(p, v.slice());
          else if (v instanceof Tuple) env.tuples.set(p, v);
        });
        continue;
      }
      const p = pathOf(e.left);
      if (!p) continue;
      const v = ev(e.right, env);
      if (Array.isArray(v)) env.setArray(p, v.slice());
      else {
        const tup = this.tupleFor(e.right, env);
        if (tup) env.tuples.set(p, tup);
      }
    }
  }

  /** The statically known argument list bound to `node`, if any. */
  tupleFor(node, env) {
    if (node.type === "Identifier" && env.tupleName === node.name && env.tuple) return env.tuple;
    const p = pathOf(node);
    if (p !== null && !env.blocked.has(rootOf(p)) && env.tuples.has(p)) return env.tuples.get(p);
    return null;
  }

  /* ---------------- CFG structuring ---------------- */

  structure(cfg) {
    const { blocks, entry } = cfg;
    if (!blocks.size) return [];

    // reachable + successor lists
    const succ = new Map();
    for (const [k, b] of blocks) succ.set(k, termTargets(b.term).filter((x) => x !== EXIT || true));

    const order = [];
    const seen = new Set();
    (function dfs(k) {
      if (k === EXIT || seen.has(k) || !blocks.has(k)) return;
      seen.add(k);
      for (const s of succ.get(k)) dfs(s);
      order.push(k);
    })(entry);
    const rpo = order.slice().reverse();
    const rpoIndex = new Map(rpo.map((k, i) => [k, i]));

    const preds = new Map(rpo.map((k) => [k, []]));
    for (const k of rpo)
      for (const s of succ.get(k)) if (rpoIndex.has(s)) preds.get(s).push(k);

    const idom = computeDominators(rpo, rpoIndex, preds);
    const ipdom = computePostDominators(rpo, rpoIndex, succ, blocks);

    // natural loops
    const loopOf = new Map(); // header -> Set(nodes)
    for (const k of rpo)
      for (const s of succ.get(k))
        if (rpoIndex.has(s) && dominates(idom, rpoIndex, s, k)) {
          if (!loopOf.has(s)) loopOf.set(s, new Set([s]));
          collectLoopBody(loopOf.get(s), s, k, preds);
        }

    const ctx = {
      blocks,
      succ,
      preds,
      idom,
      ipdom,
      rpoIndex,
      loopOf,
      loopStack: [],
      emitted: new Set(),
      regionLabel: null,
      self: this,
    };
    const res = this.emitSeq(entry, new Set(), ctx);
    let stmts = res.stmts;
    if (ctx.regionLabel) {
      stmts = [t.labeledStatement(t.identifier(ctx.regionLabel), t.blockStatement(stmts))];
    }
    return stmts;
  }

  emitSeq(start, stop, ctx) {
    const out = [];
    let cur = start;
    let guard = 0;
    while (cur && cur !== EXIT && !stop.has(cur)) {
      if (++guard > 20000) {
        this.warn("structuring loop guard");
        break;
      }
      // a loop header we are not already inside of
      if (ctx.loopOf.has(cur) && !ctx.loopStack.some((l) => l.header === cur)) {
        const r = this.emitLoop(cur, stop, ctx);
        out.push(...r.stmts);
        cur = r.next;
        continue;
      }
      const b = ctx.blocks.get(cur);
      if (!b) break;
      if (ctx.emitted.has(cur)) {
        // block duplicated: still correct, just noisy
        this.stats.fallbacks++;
      }
      ctx.emitted.add(cur);
      out.push(...b.stmts.map((s) => t.cloneNode(s, true)));

      const r = this.emitTerm(b.term, cur, stop, ctx);
      out.push(...r.stmts);
      cur = r.next;
    }
    return { stmts: out, next: cur };
  }

  emitTerm(term, blockKey, stop, ctx) {
    switch (term.k) {
      case "ret":
        return { stmts: [t.returnStatement(term.arg ? t.cloneNode(term.arg, true) : null)], next: null };
      case "throw":
        return { stmts: [t.throwStatement(t.cloneNode(term.arg, true))], next: null };
      case "end":
        return { stmts: [], next: null };
      case "goto": {
        const j = this.jumpTo(term.key, stop, ctx);
        if (j) return { stmts: [j], next: null };
        return { stmts: [], next: term.key };
      }
      case "if": {
        const merge = this.mergeFor(blockKey, ctx, stop);
        const innerStop = new Set(stop);
        if (merge) innerStop.add(merge);
        const consStmts = term.cons.stmts.map((s) => t.cloneNode(s, true));
        const altStmts = term.alt.stmts.map((s) => t.cloneNode(s, true));
        const c = this.emitTerm(term.cons.term, blockKey, innerStop, ctx);
        const a = this.emitTerm(term.alt.term, blockKey, innerStop, ctx);
        consStmts.push(...c.stmts);
        altStmts.push(...a.stmts);
        if (c.next && c.next !== merge && c.next !== EXIT)
          consStmts.push(...this.emitSeq(c.next, innerStop, ctx).stmts);
        else if (c.next === EXIT) {
          const j = this.jumpTo(EXIT, innerStop, ctx);
          if (j) consStmts.push(j);
        }
        if (a.next && a.next !== merge && a.next !== EXIT)
          altStmts.push(...this.emitSeq(a.next, innerStop, ctx).stmts);
        else if (a.next === EXIT) {
          const j = this.jumpTo(EXIT, innerStop, ctx);
          if (j) altStmts.push(j);
        }
        const ifStmt = t.ifStatement(
          t.cloneNode(term.test, true),
          t.blockStatement(consStmts),
          altStmts.length ? t.blockStatement(altStmts) : null
        );
        return { stmts: [ifStmt], next: merge || null };
      }
    }
    return { stmts: [], next: null };
  }

  /** `break`/`continue` for a jump that leaves the current region. */
  jumpTo(target, stop, ctx) {
    for (let i = ctx.loopStack.length - 1; i >= 0; i--) {
      const l = ctx.loopStack[i];
      if (target === l.header) {
        l.usedContinue = true;
        return t.continueStatement(t.identifier(l.label));
      }
      if (target === l.follow) {
        l.usedBreak = true;
        return t.breakStatement(t.identifier(l.label));
      }
    }
    if (target === EXIT) {
      if (ctx.loopStack.length) {
        if (!ctx.regionLabel) ctx.regionLabel = this.fresh("_end");
        return t.breakStatement(t.identifier(ctx.regionLabel));
      }
      return null; // falls off the end naturally
    }
    return null;
  }

  mergeFor(blockKey, ctx, stop) {
    const m = ctx.ipdom.get(blockKey);
    if (!m || m === EXIT) return null;
    if (stop.has(m)) return m;
    return m;
  }

  emitLoop(header, stop, ctx) {
    const nodes = ctx.loopOf.get(header);
    // exits: targets outside the loop
    const exits = new Set();
    for (const n of nodes)
      for (const s of ctx.succ.get(n) || []) if (!nodes.has(s)) exits.add(s);
    let follow = null;
    const ip = ctx.ipdom.get(header);
    if (ip && exits.has(ip)) follow = ip;
    else if (exits.size === 1) follow = [...exits][0];
    else if (exits.size > 1) {
      let best = null;
      for (const e of exits) {
        if (e === EXIT) continue;
        if (best === null || (ctx.rpoIndex.get(e) ?? 1e9) > (ctx.rpoIndex.get(best) ?? -1)) best = e;
      }
      follow = best || [...exits][0];
    }
    const label = "L" + ++this.labelId;
    const frame = { header, follow, label, usedBreak: false, usedContinue: false };
    ctx.loopStack.push(frame);
    const inner = new Set(stop);
    if (follow) inner.add(follow);
    const body = this.emitSeq(header, inner, ctx);
    ctx.loopStack.pop();

    const bodyStmts = body.stmts;
    if (body.next === follow || body.next === null || body.next === EXIT) {
      // control reaching the end of the body leaves the loop
      if (body.next !== null) {
        bodyStmts.push(
          body.next === EXIT && ctx.loopStack.length === 0
            ? t.returnStatement(null)
            : t.breakStatement(t.identifier(label))
        );
        frame.usedBreak = true;
      }
    }
    const loop = t.whileStatement(t.booleanLiteral(true), t.blockStatement(bodyStmts));
    const stmt =
      frame.usedBreak || frame.usedContinue
        ? t.labeledStatement(t.identifier(label), loop)
        : loop;
    if (!frame.usedBreak && !frame.usedContinue) this.labelId--;
    return { stmts: [stmt], next: follow === EXIT ? null : follow };
  }

  /* ---------------- expression / statement rewriting ---------------- */

  /**
   * Clone `node`, folding every state-array read and pure helper call into a
   * literal and turning trampolines into calls of specialised functions.
   */
  rewrite(node, env) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map((n) => this.rewrite(n, env));
    if (typeof node.type !== "string") return node;

    // 1. constant?
    if (
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression" &&
      node.type !== "ObjectExpression"
    ) {
      const v = ev(node, env);
      if (v !== NOTHING && !Array.isArray(v)) {
        const lit = literalOf(v);
        if (lit) return lit;
      }
    }

    // 2. trampoline?
    const spec = this.trySpecialiseTrampoline(node, env);
    if (spec) return spec;

    // 3. nested dispatcher inside a function body
    if (t.isFunction(node)) {
      const inner = new Env(env);
      inner.helpers = this.helpers;
      for (const n of boundNames(node)) inner.shadow(n);
      const clone = Object.assign({}, node);
      clone.params = node.params.map((p) => this.rewrite(p, inner));
      clone.body = this.rewrite(node.body, inner);
      clone.leadingComments = clone.trailingComments = clone.innerComments = undefined;
      clone.loc = clone.start = clone.end = clone.range = undefined;
      return clone;
    }

    if (node.type === "CatchClause") {
      const inner = new Env(env);
      inner.helpers = this.helpers;
      for (const n of boundNames(node)) inner.shadow(n);
      const clone = Object.assign({}, node);
      clone.param = node.param ? this.rewrite(node.param, inner) : null;
      clone.body = this.rewrite(node.body, inner);
      clone.loc = clone.start = clone.end = clone.range = undefined;
      return clone;
    }

    if (node.type === "BlockStatement" || node.type === "Program") {
      const inner = new Env(env);
      inner.helpers = this.helpers;
      const names = [];
      for (const s of node.body) collectVarNames(s, names);
      for (const n of names) inner.shadow(n);
      // dispatchers declared right here become local specialisations
      const emitList = [];
      emitList.__id = ++this.emitScopeId;
      const local = this.scanLocalDispatchers(node.body, inner, emitList);
      const clone = Object.assign({}, node);
      const rewritten = [];
      for (const s of node.body) {
        if (local.has(s)) continue;
        rewritten.push(this.rewrite(s, inner));
      }
      clone.body = emitList.concat(rewritten);
      clone.directives = node.directives ? node.directives.slice() : clone.directives;
      clone.loc = clone.start = clone.end = clone.range = undefined;
      return clone;
    }

    // 4. member access on a known state array with a non constant index cannot
    //    happen after folding, so just clone generically
    const clone = Object.assign({}, node);
    clone.loc = clone.start = clone.end = clone.range = undefined;
    clone.leadingComments = clone.trailingComments = clone.innerComments = undefined;
    const keys = t.VISITOR_KEYS[node.type] || [];
    for (const key of keys) {
      const child = node[key];
      if (Array.isArray(child)) clone[key] = child.map((c) => (c ? this.rewrite(c, env) : c));
      else if (child && typeof child.type === "string") clone[key] = this.rewrite(child, env);
    }
    return clone;
  }

  /**
   * `function (...a) { return DISPATCH([<state>], scope, x, a); }`
   * `function (...a) { return TRAMPOLINE([<state>], scope, x, a); }`
   */
  trySpecialiseTrampoline(node, env) {
    if (node.type !== "CallExpression") return null;
    let callee = node.callee;
    if (callee.type === "SequenceExpression") callee = callee.expressions[callee.expressions.length - 1];

    // direct dispatcher call:  bh([state], scope, x, args)
    if (callee.type === "Identifier" && env.dispatchers.has(callee.name)) {
      if (!node.arguments.length) return null;
      const state = ev(node.arguments[0], env);
      if (!Array.isArray(state)) return null;
      const lastTuple = this.tupleFor(node.arguments[node.arguments.length - 1], env);
      const rest = node.arguments.slice(1).map((a) => this.rewrite(a, env));
      const spec = this.specialise(
        env.dispatchers.get(callee.name),
        state,
        node.arguments.length > 1 ? lastTuple : null,
        env
      );
      return t.callExpression(t.identifier(spec.name), rest);
    }

    // trampoline call:  scope.f([state], scope2, x, args)   where scope.f was
    // registered as  function(...p){ return bh([D], O, bd, p) }
    const p = pathOf(callee);
    if (p === null) return null;
    if (env.shadowed.has(rootOf(p))) return null;
    if (!this.trampolines.has(p)) return null;
    if (!node.arguments.length) return null;
    const args = node.arguments.map((a) => ({ node: a, value: arrValue(a, env) }));
    if (!Array.isArray(args[0].value)) {
      if (process.env.VMJS_DEBUG)
        console.error("[tramp] " + p + " first argument is not a state array");
      return null;
    }
    const res = this.resolveCall({ kind: "tramp", path: p }, args, env);
    if (!res || !res.last || !res.last.node) return null;
    const callArgs = res.middle
      .map((m) => this.rewrite(m.node, env))
      .concat([this.rewrite(res.last.node, env)]);
    return t.callExpression(t.identifier(res.spec.name), callArgs);
  }

  /* ---------------- string recovery ---------------- */

  /**
   * The remaining `scope.f(<index>, <length>)` calls read from the concealed
   * string table.  Their decoders are ordinary (pure) functions of the table,
   * but they live behind several layers of closure scope, so the values are
   * recovered by evaluating the already recovered program once in a throwaway
   * sandbox and folding every call site that returned a stable primitive.
   *
   * Nothing is inlined when the sandbox run fails - the output stays correct,
   * just less readable.
   */
  /**
   * String concealing inlines, into every scope, a private
   *
   *      function dec(i, n) { return base91(TABLE.slice(i, i + n)); }
   *
   * where `base91` carries its own 91 character alphabet.  Both halves survive
   * into the recovered source, so the decoder can be rebuilt exactly rather
   * than observed - which reaches the call sites in branches that never run.
   */
  buildStaticDecoders(file) {
    // `<scope path> = "<the concealed string table>"`
    const tables = new Map();
    traverse(file, {
      AssignmentExpression(p) {
        if (p.node.operator !== "=") return;
        if (p.node.right.type !== "StringLiteral" || p.node.right.value.length < 256) return;
        const q = pathOf(p.node.left);
        if (q !== null) tables.set(q, p.node.right.value);
      },
    });
    if (!tables.size) return new Map();

    const alphabetOf = (fnPath) => {
      let alpha = null;
      fnPath.traverse({
        StringLiteral(q) {
          if (q.node.value.length === 91 && !alpha) alpha = q.node.value;
        },
      });
      return alpha;
    };

    const out = new Map(); // binding -> (i, n) => string
    traverse(file, {
      Function(p) {
        // `function dec(a, b) { return inner(<table>.slice(a, a + b)); }`
        const params = p.node.params;
        if (params.length !== 2 || params.some((q) => q.type !== "Identifier")) return;
        const body = p.node.body;
        if (!body || body.type !== "BlockStatement" || body.body.length !== 1) return;
        const ret = body.body[0];
        if (ret.type !== "ReturnStatement" || !ret.argument) return;
        const call = ret.argument;
        if (call.type !== "CallExpression" || call.arguments.length !== 1) return;
        const slice = call.arguments[0];
        if (slice.type !== "CallExpression" || slice.callee.type !== "MemberExpression") return;
        const prop = slice.callee.computed
          ? slice.callee.property.type === "StringLiteral"
            ? slice.callee.property.value
            : null
          : slice.callee.property.name;
        if (prop !== "slice") return;
        const table = tables.get(pathOf(slice.callee.object));
        if (!table) return;
        if (call.callee.type !== "Identifier") return;
        const innerBinding = p.scope.getBinding(call.callee.name);
        if (!innerBinding || !innerBinding.path.isFunctionDeclaration()) return;
        const alpha = alphabetOf(innerBinding.path);
        if (!alpha) return;
        const decoder = (i, n) => decodeBase91(alpha, table.slice(i, i + n));
        const self = p.node.id && p.scope.parent && p.scope.parent.getBinding(p.node.id.name);
        if (self) out.set(self, decoder);
      },
    });
    return out;
  }

  inlineConcealedStrings(file) {
    const staticDecoders = this.buildStaticDecoders(file);
    const sites = [];
    const isLiteralArg = (a) =>
      a.type === "StringLiteral" ||
      a.type === "NumericLiteral" ||
      a.type === "BooleanLiteral" ||
      (a.type === "UnaryExpression" &&
        a.operator === "-" &&
        a.argument.type === "NumericLiteral");
    const argKey = (n) => generate(t.arrayExpression(n.arguments), { compact: true }).code;
    const bindingIds = new Map();
    const declarations = [];

    traverse(file, {
      CallExpression(p) {
        const n = p.node;
        if (n.__rec) return;
        if (!n.arguments.length || !n.arguments.every(isLiteralArg)) return;
        let callee = n.callee;
        if (callee.type === "SequenceExpression")
          callee = callee.expressions[callee.expressions.length - 1];
        if (callee.type === "Identifier" && /^fn\d+$/.test(callee.name)) return;
        const cp = pathOf(callee);
        // `this.x(…)` is virtual machine plumbing (operand readers), never a
        // pure decoder - folding those would eat the interpreter's own state
        if (cp === null || rootOf(cp) === "this") return;
        if (p.getFunctionParent() === null) return; // top level: keep as is
        // the same identifier names a different local decoder in every scope,
        // so identify the callee by its binding whenever there is one
        let key = cp;
        let stat = null;
        if (callee.type === "Identifier") {
          const b = p.scope.getBinding(callee.name);
          if (b) {
            if (!bindingIds.has(b)) {
              bindingIds.set(b, "#" + bindingIds.size);
              if (b.path.isFunctionDeclaration() || b.path.isVariableDeclarator())
                declarations.push({ key: bindingIds.get(b), binding: b, name: callee.name });
            }
            key = bindingIds.get(b);
            stat = staticDecoders.get(b) || null;
          }
        }
        sites.push({ p, callee: key, args: argKey(n), decoder: stat });
      },
    });
    if (!sites.length) return 0;

    const REC = "__vmjs_rec";
    sites.forEach((s, i) => {
      const call = s.p.node;
      call.__rec = true;
      // id, callee path, callee reference, the untouched call
      s.p.replaceWith(
        t.callExpression(t.identifier(REC), [
          t.numericLiteral(i),
          t.stringLiteral(s.callee),
          t.cloneNode(unwrapSeq(call.callee), true),
          call,
        ])
      );
      s.p.skip();
    });

    // register the local decoders as soon as their scope is created, so call
    // sites in branches that never ran can still be resolved afterwards
    const FNREC = "__vmjs_fn";
    for (const d of declarations) {
      const stmt = d.binding.path.isFunctionDeclaration()
        ? d.binding.path
        : d.binding.path.parentPath;
      if (!stmt || !stmt.node || !Array.isArray(stmt.container)) continue;
      try {
        stmt.insertAfter(
          t.expressionStatement(
            t.callExpression(t.identifier(FNREC), [t.stringLiteral(d.key), t.identifier(d.name)])
          )
        );
      } catch (e) {
        /* not a statement position: skip */
      }
    }

    const CONFLICT = Symbol("conflict");
    const results = new Map(); // site id -> value | CONFLICT
    const decoders = new Map(); // callee path -> function | CONFLICT
    const before = this.evaluate(file, REC, results, decoders, CONFLICT);
    if (before === null) {
      this.unwrapRecorders(file, REC, null);
      this.stats.sandbox = false;
      return 0;
    }

    // A callee only counts as a decoder when *every* observation agrees:
    // same arguments always produced the same string, everywhere.
    const byCall = new Map();
    const bad = new Set();
    sites.forEach((s, i) => {
      const v = results.get(i);
      if (v === undefined) return; // never executed; decided below
      if (typeof v !== "string") {
        bad.add(s.callee);
        return;
      }
      const k = s.callee + "|" + s.args;
      if (!byCall.has(k)) byCall.set(k, v);
      else if (byCall.get(k) !== v) bad.add(s.callee);
    });

    /**
     * A string decoder is a function of its literal arguments and nothing
     * else.  Re-invoking the captured function detached from any receiver has
     * to reproduce what was observed - that rules out `xs.join(",")` and other
     * genuinely stateful calls that merely happen to take literal arguments.
     */
    const decode = (key, argNodes, expect, staticFn) => {
      // a decoder rebuilt from the source is exact; prefer it, but only when
      // it agrees with what was actually observed
      if (staticFn) {
        try {
          const r = staticFn(...argNodes.map(literalValue));
          if (typeof r === "string" && (expect === undefined || r === expect)) return r;
        } catch (e) {
          /* fall through to the observed decoder */
        }
      }
      const fn = decoders.get(key);
      if (typeof fn !== "function") return null;
      let src = "";
      try {
        src = Function.prototype.toString.call(fn);
      } catch (e) {
        return null;
      }
      if (/\[native code\]/.test(src)) return null;
      try {
        const r = fn(...argNodes.map(literalValue));
        if (typeof r !== "string") return null;
        if (expect !== undefined && r !== expect) return null;
        return r;
      } catch (e) {
        return null;
      }
    };

    const observed = new Map();
    const full = new Map();
    sites.forEach((s, i) => {
      if (bad.has(s.callee)) return;
      const v = results.get(i);
      const argNodes = s.p.node.arguments[3].arguments;
      if (typeof v === "string") {
        if (decode(s.callee, argNodes, v, s.decoder) === null) return;
        observed.set(i, v);
        full.set(i, v);
        return;
      }
      // branch never taken during the probe run: rebuild or re-invoke
      if (v !== undefined) return;
      const r = decode(s.callee, argNodes, undefined, s.decoder);
      if (r !== null) full.set(i, r);
    });

    // the folded program has to behave exactly like the original; try the
    // ambitious variant first and fall back to what was actually observed
    let chosen = null;
    for (const candidate of [full, observed, new Map()]) {
      const probe = t.cloneNode(file, true);
      this.unwrapRecorders(probe, REC, candidate);
      const after = this.evaluate(probe, REC, new Map(), new Map(), CONFLICT);
      if (after !== null && after === before) {
        chosen = candidate;
        break;
      }
      if (candidate === full) this.warn("speculative string folding rejected");
      else if (candidate === observed) this.warn("string folding changed behaviour, reverted");
    }

    const folded = this.unwrapRecorders(file, REC, chosen || new Map());
    this.stats.strings = folded;
    this.stats.sandbox = true;
    return folded;
  }

  /** Run `file` in a sandbox; returns its observable trace or null on error. */
  evaluate(file, REC, results, decoders, CONFLICT) {
    const code = generate(file, { compact: false }).code;
    try {
      const sandbox = makeSandbox();
      sandbox[REC] = (id, path, fn, value) => {
        // several closure instances of the same decoder are equivalent, keep
        // the first one so unexecuted call sites can still be resolved
        if (!decoders.has(path)) decoders.set(path, fn);
        if (!results.has(id)) results.set(id, value);
        else if (results.get(id) !== value) results.set(id, CONFLICT);
        return value;
      };
      sandbox.__vmjs_fn = (key, fn) => {
        if (!decoders.has(key)) decoders.set(key, fn);
      };
      require("vm").createContext(sandbox);
      require("vm").runInContext(code, sandbox, { timeout: 30000 });
      return sandbox.__trace.join("\n");
    } catch (e) {
      this.warn("sandbox evaluation: " + e.message);
      return null;
    }
  }

  /** Replace `__vmjs_rec(id, call)` by the folded literal or by `call`. */
  unwrapRecorders(file, REC, fold) {
    let n = 0;
    traverse(file, {
      ExpressionStatement(p) {
        const e = p.node.expression;
        if (e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "__vmjs_fn")
          p.remove();
      },
      CallExpression(p) {
        if (p.node.callee.type !== "Identifier" || p.node.callee.name !== REC) return;
        const id = p.node.arguments[0].value;
        const inner = p.node.arguments[3];
        if (fold && fold.has(id)) {
          p.replaceWith(t.stringLiteral(fold.get(id)));
          n++;
        } else {
          p.replaceWith(inner);
        }
      },
    });
    return n;
  }

  /* ---------------- readability ---------------- */

  /**
   * `(1, f)(x)` only exists to drop the `this` binding.  When `f` is provably
   * a function that never looks at `this`, the wrapper is noise.
   */
  simplifyThisGuards(file) {
    const byPath = new Map(); // path -> function node | CONFLICT
    const CONFLICT = {};
    traverse(file, {
      AssignmentExpression(p) {
        const n = p.node;
        if (n.operator !== "=") return;
        const path = pathOf(n.left);
        if (path === null) return;
        const v = t.isFunction(n.right) ? n.right : CONFLICT;
        byPath.set(path, byPath.has(path) ? CONFLICT : v);
      },
    });

    const usesThis = new Map();
    const checkThis = (fn) => {
      if (usesThis.has(fn)) return usesThis.get(fn);
      let found = false;
      const walk = (node) => {
        if (found || !node || typeof node.type !== "string") return;
        if (node.type === "ThisExpression") {
          found = true;
          return;
        }
        if (node !== fn && t.isFunction(node) && node.type !== "ArrowFunctionExpression") return;
        for (const k of t.VISITOR_KEYS[node.type] || []) {
          const c = node[k];
          if (Array.isArray(c)) c.forEach(walk);
          else if (c && typeof c.type === "string") walk(c);
        }
      };
      walk(fn);
      usesThis.set(fn, found);
      return found;
    };

    let n = 0;
    traverse(file, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee.type !== "SequenceExpression" || callee.expressions.length !== 2) return;
        const [guard, target] = callee.expressions;
        if (guard.type !== "NumericLiteral") return;
        const path = pathOf(target);
        if (path === null) return;
        const fn = byPath.get(path);
        if (!fn || fn === CONFLICT || checkThis(fn)) return;
        p.node.callee = target;
        n++;
      },
    });
    return n;
  }

  /**
   * Variable masking turns every local into a property of a nested "scope"
   * object, which leaves paths like `bc.aX.b.x.b.m.a` everywhere.  Bind the
   * repeated prefixes to a local once - object identity makes this exact.
   */
  aliasScopePaths(file) {
    const self = this;
    let made = 0;

    const visitFn = (fnPath) => {
      const bodyNode = fnPath.node.body;
      if (!bodyNode || bodyNode.type !== "BlockStatement") return;
      const stmts = bodyNode.body;
      if (!stmts.length) return;

      // statement index of every node inside this function
      const indexOf = (p) => {
        let cur = p;
        while (cur && cur.parentPath) {
          if (cur.parentPath.node === bodyNode) return stmts.indexOf(cur.node);
          cur = cur.parentPath;
        }
        return -1;
      };

      const uses = new Map(); // prefix -> {refs: [path], minIdx, lastWrite}
      const record = (prefix, p, idx) => {
        let e = uses.get(prefix);
        if (!e) uses.set(prefix, (e = { refs: [], minIdx: Infinity, lastWrite: -1 }));
        e.refs.push(p);
        if (idx < e.minIdx) e.minIdx = idx;
      };

      fnPath.traverse({
        Function(p) {
          // nested functions are visited on their own, but their *uses* still
          // count for the enclosing frame, so keep walking
        },
        MemberExpression(p) {
          const n = p.node;
          if (n.computed) return;
          if (n.property.type !== "Identifier") return;
          const objPath = pathOf(n.object);
          if (objPath === null) return;
          if (objPath.split(".").length < 3) return; // short enough already
          const idx = indexOf(p);
          if (idx < 0) return;
          record(objPath, p, idx);
        },
      });

      // where is each prefix (or one of its prefixes) written?
      const writes = new Map();
      fnPath.traverse({
        AssignmentExpression(p) {
          const targets = [];
          const collect = (node) => {
            if (!node) return;
            if (node.type === "ArrayPattern") return node.elements.forEach(collect);
            if (node.type === "AssignmentPattern") return collect(node.left);
            if (node.type === "ObjectPattern")
              return node.properties.forEach((pr) => collect(pr.value || pr.argument));
            const q = pathOf(node);
            if (q !== null) targets.push(q);
          };
          collect(p.node.left);
          const idx = indexOf(p);
          for (const q of targets) writes.set(q, Math.max(writes.get(q) || -1, idx));
        },
      });
      const lastWriteFor = (prefix) => {
        let last = -1;
        for (const [q, idx] of writes)
          if (prefix === q || prefix.startsWith(q + ".")) last = Math.max(last, idx);
        return last;
      };

      for (const [prefix, e] of [...uses].sort((a, b) => b[0].length - a[0].length)) {
        if (e.refs.length < 3) continue;
        const after = lastWriteFor(prefix);
        if (after >= e.minIdx) continue; // used before it is fully assigned
        if (writes.has(prefix) && writes.get(prefix) > after) continue;
        const base = prefix.split(".").pop();
        const name = fnPath.scope.generateUid("s_" + base);
        const decl = t.variableDeclaration("var", [
          t.variableDeclarator(t.identifier(name), buildMember(prefix)),
        ]);
        stmts.splice(after + 1, 0, decl);
        for (const ref of e.refs) ref.node.object = t.identifier(name);
        made++;
        // indices shifted by one; recompute lazily on the next prefix
        for (const [q, idx] of writes) writes.set(q, idx >= after + 1 ? idx + 1 : idx);
        for (const [, other] of uses) if (other.minIdx >= after + 1) other.minIdx++;
      }
    };

    traverse(file, {
      Function(p) {
        visitFn(p);
      },
    });

    // string concealing inlines a private decoder into every scope; once the
    // strings are folded most of them are never called again
    for (let round = 0; round < 4; round++) {
      let removed = 0;
      traverse.cache.clear(); // earlier passes invalidated the binding info
      traverse(file, {
        FunctionDeclaration(p) {
          if (!p.node.id) return;
          if (/^fn\d+$/.test(p.node.id.name)) return; // recovered functions
          const b = p.scope.parent && p.scope.parent.getBinding(p.node.id.name);
          if (b && !b.referenced && b.constantViolations.length === 0) {
            p.remove();
            removed++;
          }
        },
      });
      if (!removed) break;
    }

    // an alias can become dead when a longer one supersedes it
    traverse.cache.clear();
    traverse(file, {
      VariableDeclarator(p) {
        const id = p.node.id;
        if (id.type !== "Identifier" || !/^_s_/.test(id.name)) return;
        const binding = p.scope.getBinding(id.name);
        if (binding && !binding.referenced) {
          made--;
          if (p.parentPath.node.declarations.length === 1) p.parentPath.remove();
          else p.remove();
        }
      },
    });
    self.stats.aliases = made;
    return made;
  }

  /* ---------------- clean up ---------------- */

  postProcess(file) {
    // decoded strings unlock a second round of constant folding
    const empty = new Env(null);
    empty.helpers = {};
    const fold = {
      exit(p) {
        const n = p.node;
        const v = ev(n, empty);
        if (v === NOTHING || Array.isArray(v) || v === undefined) return;
        const lit = literalOf(v);
        // `-5` folds to a UnaryExpression again, which would never terminate
        if (!lit || lit.type === n.type) return;
        p.replaceWith(lit);
      },
    };
    traverse(file, {
      BinaryExpression: fold,
      UnaryExpression: fold,
      LogicalExpression: fold,
    });

    // opaque predicates left inside recovered (non-dispatcher) code
    let pruned = 0;
    traverse(file, {
      IfStatement(p) {
        const v = literalTruth(p.node.test);
        if (v === null) return;
        const dead = v ? p.node.alternate : p.node.consequent;
        const live = v ? p.node.consequent : p.node.alternate;
        if (!dead) {
          if (v && live) p.replaceWithMultiple(bodyOf(live));
          return;
        }
        if (!branchIsSelfContained(p.get(v ? "alternate" : "consequent"))) return;
        pruned++;
        if (live) p.replaceWithMultiple(bodyOf(live));
        else p.remove();
      },
      ConditionalExpression(p) {
        const v = literalTruth(p.node.test);
        if (v === null) return;
        p.replaceWith(v ? p.node.consequent : p.node.alternate);
      },
    });
    this.stats.deadBranches = pruned;

    // drop statements after a terminator, simplify member access, tidy names
    traverse(file, {
      BlockStatement(p) {
        const body = p.node.body;
        for (let i = 0; i < body.length; i++) {
          const s = body[i];
          if (
            s.type === "ReturnStatement" ||
            s.type === "ThrowStatement" ||
            s.type === "BreakStatement" ||
            s.type === "ContinueStatement"
          ) {
            if (i < body.length - 1) {
              // `var` and `function` are hoisted, so the *bindings* have to
              // survive even though the statements are unreachable
              const rest = body.slice(i + 1);
              const keep = [];
              const names = [];
              for (const x of rest) {
                if (x.type === "FunctionDeclaration") keep.push(x);
                else collectVarNames(x, names);
              }
              if (names.length)
                keep.push(
                  t.variableDeclaration(
                    "var",
                    [...new Set(names)].map((n) => t.variableDeclarator(t.identifier(n)))
                  )
                );
              p.node.body = body.slice(0, i + 1).concat(keep);
            }
            break;
          }
        }
      },
      MemberExpression(p) {
        const n = p.node;
        if (n.computed && n.property.type === "StringLiteral" && t.isValidIdentifier(n.property.value)) {
          n.computed = false;
          n.property = t.identifier(n.property.value);
        }
      },
      ObjectProperty(p) {
        const n = p.node;
        if (n.computed && n.key.type === "StringLiteral" && t.isValidIdentifier(n.key.value)) {
          n.computed = false;
          n.key = t.identifier(n.key.value);
        }
      },
    });
  }
}

const EXIT = "<exit>";


/**
 * A throwaway environment used only to observe what the recovered decoders
 * return.  It is deliberately inert: no filesystem, no network, no real DOM.
 */
const FROZEN_TIME = 1700000000000;

function makeSandbox() {
  const noop = () => {};
  const el = () => ({
    style: {},
    children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop,
    getAttribute: () => null,
    appendChild: (c) => c,
    removeChild: noop,
    insertBefore: (c) => c,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => null,
    innerHTML: "",
    textContent: "",
    value: ""
  });
  const documentShim = {
    body: el(),
    head: el(),
    documentElement: el(),
    createElement: el,
    createTextNode: el,
    createElementNS: el,
    getElementById: () => el(),
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    querySelector: () => el(),
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    write: noop,
    cookie: "",
    title: ""
  };
  const trace = [];
  const sandbox = {
    __trace: trace,
    console: new Proxy(
      {},
      {
        get: (_, k) => (...a) => {
          trace.push("console." + String(k) + " " + a.map(safeStr).join(" "));
        }
      }
    ),
    document: documentShim,
    navigator: { userAgent: "node", language: "en" },
    location: { href: "about:blank", protocol: "about:", host: "", search: "", hash: "" },
    history: { pushState: noop, replaceState: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    performance: { now: () => 0 },
    // frozen clock + rng so two runs of the same program are comparable
    Date: new Proxy(Date, {
      apply: () => new Date(FROZEN_TIME).toString(),
      construct: (T, a) => (a.length ? new T(...a) : new T(FROZEN_TIME)),
      get: (T, k) => (k === "now" ? () => FROZEN_TIME : T[k])
    }),
    Math: Object.assign(Object.create(Math), { random: () => 0.4242424242 }),
    setTimeout: noop,
    setInterval: noop,
    clearTimeout: noop,
    clearInterval: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    queueMicrotask: noop,
    fetch: () => Promise.resolve({ text: () => Promise.resolve("") }),
    XMLHttpRequest: function () {
      return { open: noop, send: noop, setRequestHeader: noop };
    },
    alert: noop,
    prompt: () => null,
    confirm: () => false,
    atob: (x) => Buffer.from(String(x), "base64").toString("binary"),
    btoa: (x) => Buffer.from(String(x), "binary").toString("base64"),
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    process: { platform: "sandbox", version: "v0", env: {}, argv: [] }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  return sandbox;
}

function safeStr(v) {
  try {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return Object.prototype.toString.call(v);
    return String(v);
  } catch (e) {
    return "?";
  }
}

function termTargets(term, out) {
  out = out || [];
  if (!term) return out;
  switch (term.k) {
    case "goto":
      out.push(term.key);
      break;
    case "if":
      termTargets(term.cons.term, out);
      termTargets(term.alt.term, out);
      break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * dominator helpers                                                   *
 * ------------------------------------------------------------------ */

function computeDominators(rpo, rpoIndex, preds) {
  const idom = new Map();
  if (!rpo.length) return idom;
  idom.set(rpo[0], rpo[0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i];
      let newIdom = null;
      for (const p of preds.get(b) || []) {
        if (!idom.has(p)) continue;
        newIdom = newIdom === null ? p : intersect(idom, rpoIndex, p, newIdom);
      }
      if (newIdom !== null && idom.get(b) !== newIdom) {
        idom.set(b, newIdom);
        changed = true;
      }
    }
  }
  return idom;
}

function intersect(idom, rpoIndex, a, b) {
  while (a !== b) {
    while (rpoIndex.get(a) > rpoIndex.get(b)) a = idom.get(a);
    while (rpoIndex.get(b) > rpoIndex.get(a)) b = idom.get(b);
  }
  return a;
}

function dominates(idom, rpoIndex, a, b) {
  let cur = b;
  const seen = new Set();
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === a) return true;
    seen.add(cur);
    const next = idom.get(cur);
    if (next === cur) break;
    cur = next;
  }
  return false;
}

function collectLoopBody(set, header, tail, preds) {
  const stack = [tail];
  while (stack.length) {
    const n = stack.pop();
    if (set.has(n)) continue;
    set.add(n);
    for (const p of preds.get(n) || []) if (p !== header) stack.push(p);
  }
  set.add(header);
}

function computePostDominators(rpo, rpoIndex, succ, blocks) {
  // reverse graph: EXIT is the single sink
  const nodes = rpo.slice().reverse(); // post order
  const order = [EXIT].concat(nodes);
  const index = new Map(order.map((k, i) => [k, i]));
  const rsucc = new Map();
  for (const k of rpo) {
    const s = (succ.get(k) || []).map((x) => (blocks.has(x) ? x : EXIT));
    rsucc.set(k, s.length ? s : [EXIT]);
    const b = blocks.get(k);
    if (b && (b.term.k === "ret" || b.term.k === "throw" || b.term.k === "end"))
      rsucc.set(k, [EXIT]);
  }
  const ipdom = new Map();
  ipdom.set(EXIT, EXIT);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const b of nodes) {
      let np = null;
      for (const s of rsucc.get(b) || []) {
        if (!ipdom.has(s)) continue;
        np = np === null ? s : intersect(ipdom, index, s, np);
      }
      if (np !== null && ipdom.get(b) !== np) {
        ipdom.set(b, np);
        changed = true;
      }
    }
  }
  return ipdom;
}

/* ------------------------------------------------------------------ *
 * public API                                                          *
 * ------------------------------------------------------------------ */

function deobfuscateSource(code, opts) {
  opts = opts || {};
  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
  } catch (e) {
    // not parseable: hand the input back rather than destroying it
    return {
      code,
      changed: false,
      warnings: ["parse error: " + e.message],
      stats: { blocks: 0, functions: 0 },
    };
  }
  const d = new Deobfuscator(ast, opts);
  let out = null;
  try {
    out = d.run();
  } catch (e) {
    if (opts.verbose) console.error(e);
    d.warn("fatal: " + e.message);
    out = null;
  }
  if (!out) {
    // not this obfuscation (or unrecognised): pass the source through untouched
    return { code, changed: false, warnings: d.warnings, stats: d.stats };
  }
  const res = {
    code: generate(out, { compact: false, comments: true, jsescOption: { minimal: true } }).code,
    changed: true,
    warnings: d.warnings,
    stats: d.stats,
  };
  if (opts.devirtualize !== false) {
    const program = removeVirtualMachine(res.code, res);
    if (program) {
      res.code =
        "// Recovered by vm.js: control-flow flattening, function outlining,\n" +
        "// variable masking and string concealing removed, then the register VM\n" +
        "// underneath devirtualised back into its own source.\n\n" +
        program +
        "\n";
      res.devirtualised = true;
    }
  }
  return res;
}

/**
 * Under the flattening sits a register virtual machine whose bytecode is the
 * original program.  `devirt.js` lifts it back to JavaScript; the result is
 * only used when it demonstrably behaves the same as the machine it replaces.
 */
function removeVirtualMachine(code, res) {
  let devirt;
  try {
    devirt = require("./devirt.js");
  } catch (e) {
    return null;
  }
  let out;
  try {
    out = devirt.devirtualize(code, {});
  } catch (e) {
    res.warnings.push("devirtualisation failed: " + e.message);
    return null;
  }
  if (!out || !out.code) return null;
  for (const w of out.warnings || []) res.warnings.push("vm: " + w);

  const before = runTrace(code);
  const after = runTrace(out.code);
  if (before === null || after === null || before !== after) {
    res.warnings.push("devirtualised program behaves differently, kept the VM");
    return null;
  }
  res.stats.vm = out.stats;
  return out.code;
}

/** observable behaviour of `code` in the inert sandbox, or null if it threw */
function runTrace(code) {
  try {
    const sandbox = makeSandbox();
    require("vm").createContext(sandbox);
    require("vm").runInContext(code, sandbox, { timeout: 30000 });
    return sandbox.__trace.join("\n");
  } catch (e) {
    return null;
  }
}

function deobfuscateFile(inputFile, outputFile, opts) {
  const src = fs.readFileSync(inputFile, "utf8");
  const res = deobfuscateSource(src, opts);
  if (outputFile) fs.writeFileSync(outputFile, res.code);
  return res.code;
}

module.exports = deobfuscateFile;
module.exports.deobfuscateSource = deobfuscateSource;
module.exports.deobfuscateFile = deobfuscateFile;

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const quiet = process.argv.includes("--quiet");
  const opts = { verbose: !quiet };
  if (process.argv.includes("--no-strings")) opts.strings = false;
  if (process.argv.includes("--keep-vm")) opts.devirtualize = false;
  const [inFile, outFile] = args;
  if (!inFile) {
    console.error("usage: vm.js <input.js> [output.js] [--keep-vm] [--no-strings] [--quiet]");
    process.exit(1);
  }
  const src = fs.readFileSync(inFile, "utf8");
  const res = deobfuscateSource(src, opts);
  if (outFile) fs.writeFileSync(outFile, res.code);
  else process.stdout.write(res.code);
  if (!quiet) {
    const s = res.stats;
    if (res.warnings.length) {
      console.error("\n[vm.js] " + res.warnings.length + " warning(s):");
      for (const w of res.warnings.slice(0, 20)) console.error("  - " + w);
    }
    if (!res.changed) {
      console.error("[vm.js] no state-array dispatcher found; source passed through unchanged");
    } else {
      console.error(
        "[vm.js] recovered " +
          s.functions +
          " functions from " +
          s.blocks +
          " basic blocks" +
          (s.trampolines ? " (" + s.trampolines + " outlining trampolines)" : "") +
          "\n        " +
          (s.strings || 0) + " concealed strings decoded, " +
          (s.deadBranches || 0) + " opaque branches removed, " +
          (s.aliases || 0) + " scope paths aliased" +
          "\n        " +
          src.length + " -> " + res.code.length + " bytes, " +
          (s.dispatchersLeft ? s.dispatchersLeft + " dispatcher(s) LEFT" : "0 dispatchers left")
      );
    }
  }
}
