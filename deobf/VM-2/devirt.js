#!/usr/bin/env node
/**
 * devirt.js — devirtualiser for the register VM that `vm.js` leaves behind.
 *
 * After vm.js removes the control-flow flattening, what remains is a virtual
 * machine:
 *
 *      Machine(U, C, t, H, N, q)      U = constant pool    C = globals
 *        this.k   memory (contiguous frames)
 *        this.y   frame pointer
 *        this.N   bytecode (uint32 words)
 *      frame:  +0 counter  +1 size  +2 this  +3 return slot  +4 caller
 *              +5 function +6 pc    +7 handler stack  +8 register base
 *
 * with ~128 opcode handlers - mostly the same few templates specialised for
 * fixed register numbers ("randomised opcodes").
 *
 * The instruction set is *not* hard-coded here.  Each recovered handler is
 * reduced to a canonical one-line shape (`M[B+@0]=M[B+@1]+M[B+@2]`) and
 * matched against a table of templates, so the same code works for a sample
 * with a different opcode numbering or a different register assignment.
 *
 *      $ node devirt.js <vm-level.js> program.js
 *
 * (vm-level.js is what `vm.js input.js out.js --keep-vm` writes.)
 */

"use strict";

const fs = require("fs");
const parser = require("@babel/parser");
const generate = require("@babel/generator").default;
const traverse = require("@babel/traverse").default;
const t = require("@babel/types");

/* ------------------------------------------------------------------ *
 * helpers                                                             *
 * ------------------------------------------------------------------ */

function pathOf(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression") {
    const o = pathOf(node.object);
    if (o === null) return null;
    let k;
    if (!node.computed && node.property.type === "Identifier") k = node.property.name;
    else if (node.property.type === "StringLiteral") k = node.property.value;
    else return null;
    return o + "." + k;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 1. read the machine out of the recovered source                     *
 * ------------------------------------------------------------------ */

function extractMachine(ast) {
  const m = { pool: null, code: null, entry: null, handlers: new Map(), globals: null };

  traverse(ast, {
    NewExpression(p) {
      const args = p.node.arguments;
      if (args.length < 5) return;
      const codeArg = args.find(
        (a) =>
          a.type === "CallExpression" &&
          a.arguments.length === 1 &&
          a.arguments[0].type === "StringLiteral" &&
          a.arguments[0].value.length > 200
      );
      if (!codeArg) return;
      m.code = decodeWords(codeArg.arguments[0].value);
      m.globals = pathOf(args[1]);
    },
    ObjectExpression(p) {
      const props = {};
      for (const q of p.node.properties) {
        if (q.type !== "ObjectProperty" || q.computed) return;
        const k = q.key.type === "Identifier" ? q.key.name : q.key.value;
        props[k] = q.value.type === "NumericLiteral" ? q.value.value : undefined;
      }
      if (props.I === undefined || props.z === undefined || props.F === undefined) return;
      if (!m.entry) m.entry = { params: props.I, regs: props.z, pc: props.F, rest: !!props.p };
    },
    AssignmentExpression(p) {
      const n = p.node;
      if (n.operator !== "=") return;
      const l = n.left;
      if (l.type === "MemberExpression" && l.computed && l.property.type === "NumericLiteral") {
        const o = l.object;
        if (
          o.type === "MemberExpression" &&
          !o.computed &&
          o.property.type === "Identifier" &&
          o.property.name === "t" &&
          t.isFunction(n.right)
        )
          m.handlers.set(l.property.value, n.right);
        return;
      }
      const q = pathOf(l);
      if (q && /\.r$/.test(q) && n.right.type === "ArrayExpression" && n.right.elements.length > 10) {
        const pool = [];
        for (const el of n.right.elements) {
          if (!el) return;
          if (el.type === "NumericLiteral") pool.push(el.value);
          else if (el.type === "StringLiteral") pool.push(el.value);
          else if (el.type === "BooleanLiteral") pool.push(el.value);
          else if (el.type === "NullLiteral") pool.push(null);
          else if (el.type === "Identifier" && el.name === "undefined") pool.push(undefined);
          else if (
            el.type === "UnaryExpression" &&
            el.operator === "-" &&
            el.argument.type === "NumericLiteral"
          )
            pool.push(-el.argument.value);
          else return;
        }
        m.pool = pool;
      }
    },
  });
  return m;
}

function decodeWords(b64) {
  const bytes = Buffer.from(b64, "base64");
  const out = new Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readUInt32LE(i * 4);
  return out;
}

/** the recovered `B` method: pool lookup + per-instruction decryption */
function makeConstantReader(pool) {
  return function (index, key) {
    const v = pool[index];
    if (!key) return v;
    if (typeof v === "number") return v ^ key;
    if (typeof v !== "string") return v;
    const bytes = Buffer.from(v, "base64");
    let out = "";
    let s = key | 0;
    for (let i = 0; i < Math.floor(bytes.length / 2); i++) {
      s = (s + 2654435769) | 0;
      const q = (s ^ (s >>> 13)) & 65535;
      out += String.fromCharCode((bytes[i * 2] | (bytes[i * 2 + 1] << 8)) ^ q);
    }
    return out;
  };
}

/* ------------------------------------------------------------------ *
 * 2. canonical shape of a handler                                     *
 * ------------------------------------------------------------------ */

/**
 * Inline single-use temporaries and rewrite the machine plumbing to short
 * names, so `function(){ var a=this.k; var b=a[this.y+8]; a[b+5]=a[b+6]; }`
 * becomes `M[B+5]=M[B+6]` and every `this.ad(...)` becomes `@0`, `@1`, …
 */
function shapeOf(fn) {
  const wrapper = t.file(t.program([t.expressionStatement(t.cloneNode(fn, true))]));

  // Operands must keep their *original* read order, so tag them before any
  // inlining moves them around.  `this.B()` is a hidden reader: with no
  // arguments it pulls the pool index and the decryption key off the stream.
  let operands = 0;
  const tag = () => t.identifier("__op" + operands++);
  traverse(wrapper, {
    CallExpression(p) {
      const callee = pathOf(p.node.callee);
      if (callee === "this.ad") {
        p.replaceWith(tag());
        p.skip();
        return;
      }
      if (callee === "this.B") {
        const a = p.node.arguments;
        const given = (n) =>
          a[n] && !(a[n].type === "Identifier" && a[n].name === "undefined") ? a[n] : null;
        const index = given(0) || tag();
        const key = given(2) || tag();
        p.replaceWith(
          t.callExpression(p.node.callee, [index, t.numericLiteral(0), key])
        );
        p.skip();
      }
    },
  });

  // canonical names for the machine plumbing
  const plain = (n) => generate(n, { compact: true }).code.replace(/\s+/g, "");
  const isMem = (c) => c === "this.k" || c === "M";
  const isFp = (c) => c === "this.y" || c === "FP";
  for (let round = 0; round < 6; round++) {
    let changed = false;
    traverse.cache.clear();
    traverse(wrapper, {
      VariableDeclarator(p) {
        const id = p.node.id;
        if (id.type !== "Identifier" || !p.node.init) return;
        const c = plain(p.node.init);
        let canon = null;
        if (isMem(c)) canon = "M";
        else if (isFp(c)) canon = "FP";
        else if (/^(this\.k|M)\[(this\.y|FP)\+8\]$/.test(c)) canon = "B";
        if (!canon) return;
        const b = p.scope.getBinding(id.name);
        if (!b) return;
        for (const ref of b.referencePaths) ref.node.name = canon;
        if (p.parentPath.node.declarations.length === 1) p.parentPath.remove();
        else p.remove();
        changed = true;
      },
    });
    if (!changed) break;
  }

  // then fold the single-use temporaries
  for (let round = 0; round < 8; round++) {
    let changed = false;
    traverse.cache.clear();
    traverse(wrapper, {
      VariableDeclarator(p) {
        const id = p.node.id;
        if (id.type !== "Identifier" || !p.node.init) return;
        const b = p.scope.getBinding(id.name);
        if (!b || b.constantViolations.length || b.referencePaths.length !== 1) return;
        b.referencePaths[0].replaceWith(t.cloneNode(p.node.init, true));
        if (p.parentPath.node.declarations.length === 1) p.parentPath.remove();
        else p.remove();
        changed = true;
      },
    });
    if (!changed) break;
  }

  let code = generate(wrapper.program.body[0].expression.body, { compact: true }).code;
  code = code
    .replace(/this\.k/g, "M")
    .replace(/this\.y/g, "FP")
    .replace(/M\[FP\+8\]/g, "B")
    .replace(/__op(\d+)/g, "@$1")
    .replace(/^\{/, "")
    .replace(/\}$/, "");
  return { code, operands };
}

/* ------------------------------------------------------------------ *
 * 3. instruction templates                                            *
 * ------------------------------------------------------------------ */

const V = "(@\\d+|\\d+)"; // an operand slot or a baked-in register number
const rx = (s) => new RegExp("^" + s + "$");

const BIN_OPS = ["+", "-", "*", "/", "%", "**", "===", "!==", "==", "!=", "<=", ">=", "<", ">", "<<", ">>>", ">>", "&", "|", "^", "instanceof", "in"];
const UN_OPS = ["!", "-", "+", "~", "typeof", "void"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the return / frame-teardown template, whatever registers it uses */
const RET_RE = rx(
  "var \\w+=M\\[B\\+" + V + "\\];this\\.T\\([^)]*\\);.*this\\.R=FP;FP=\\w+;M\\[\\w+\\?M\\[\\w+\\+8\\]\\+\\(\\w+>>1\\):0\\]=\\w+;"
);

const TEMPLATES = [
  // control flow ---------------------------------------------------------
  { name: "jmp", re: rx("M\\[FP\\+6\\]=" + V + ";"), map: (g) => ({ target: g[0] }) },
  {
    // computed goto: the target sits in a register (finally / switch dispatch)
    name: "jmpreg",
    re: rx("M\\[FP\\+6\\]=M\\[B\\+" + V + "\\];"),
    map: (g) => ({ reg: g[0] }),
  },
  {
    name: "jz",
    re: rx("if\\(!M\\[B\\+" + V + "\\]\\)\\{M\\[FP\\+6\\]=" + V + ";\\}"),
    map: (g) => ({ reg: g[0], target: g[1] }),
  },
  {
    name: "jnz",
    re: rx("if\\(M\\[B\\+" + V + "\\]\\)\\{M\\[FP\\+6\\]=" + V + ";\\}"),
    map: (g) => ({ reg: g[0], target: g[1] }),
  },
  { name: "throw", re: rx("throw M\\[B\\+" + V + "\\];"), map: (g) => ({ reg: g[0] }) },
  { name: "debugger", re: rx("debugger;"), map: () => ({}) },

  // data movement --------------------------------------------------------
  {
    name: "mov",
    re: rx("M\\[B\\+" + V + "\\]=M\\[B\\+" + V + "\\];"),
    map: (g) => ({ dst: g[0], src: g[1] }),
  },
  { name: "this", re: rx("M\\[B\\+" + V + "\\]=M\\[FP\\+2\\];"), map: (g) => ({ dst: g[0] }) },
  {
    name: "imm",
    re: rx("M\\[B\\+" + V + "\\]=(-?\\d+);"),
    map: (g) => ({ dst: g[0], value: Number(g[1]) }),
  },
  {
    // the immediate comes from the bytecode stream
    name: "imm",
    re: rx("M\\[B\\+" + V + "\\]=(@\\d+);"),
    map: (g) => ({ dst: g[0], value: g[1] }),
  },
  {
    name: "undef",
    re: rx("(?:@\\d+;)?M\\[B\\+" + V + "\\]=undefined;"),
    map: (g) => ({ dst: g[0] }),
  },
  {
    name: "const",
    re: rx("M\\[B\\+" + V + "\\]=this\\.B\\(" + V + ",0," + V + "\\);"),
    map: (g) => ({ dst: g[0], index: g[1], key: g[2] }),
  },

  // property access ------------------------------------------------------
  {
    name: "getprop",
    re: rx("M\\[B\\+" + V + "\\]=M\\[B\\+" + V + "\\]\\[M\\[B\\+" + V + "\\]\\];"),
    map: (g) => ({ dst: g[0], obj: g[1], key: g[2] }),
  },
  {
    name: "setprop",
    re: rx("Reflect\\.set\\(M\\[B\\+" + V + "\\],M\\[B\\+" + V + "\\],M\\[B\\+" + V + "\\]\\);"),
    map: (g) => ({ obj: g[0], key: g[1], val: g[2] }),
  },
  {
    name: "delete",
    re: rx("M\\[B\\+" + V + "\\]=delete M\\[B\\+" + V + "\\]\\[M\\[B\\+" + V + "\\]\\];"),
    map: (g) => ({ dst: g[0], obj: g[1], key: g[2] }),
  },

  // globals --------------------------------------------------------------
  {
    name: "getglobal",
    re: rx(
      "var \\w+=this\\.B\\(" + V + ",0," + V +
        "\\);if\\(!\\(\\w+ in this\\.C\\)\\)\\{throw new ReferenceError\\([^)]*\\);\\}M\\[B\\+" +
        V + "\\]=this\\.C\\[\\w+\\];"
    ),
    map: (g) => ({ index: g[0], key: g[1], dst: g[2] }),
  },
  {
    name: "setglobal",
    re: rx("this\\.C\\[this\\.B\\(" + V + ",0," + V + "\\)\\]=M\\[B\\+" + V + "\\];"),
    map: (g) => ({ index: g[0], key: g[1], src: g[2] }),
  },
  {
    name: "typeofglobal",
    re: rx(
      "var \\w+=this\\.B\\(" + V + ",0," + V + "\\);M\\[B\\+" + V +
        "\\]=typeof\\(Object\\.prototype\\.hasOwnProperty\\.call\\(this\\.C,\\w+\\)\\?this\\.C\\[\\w+\\]:undefined\\);"
    ),
    map: (g) => ({ index: g[0], key: g[1], dst: g[2] }),
  },

  // closure cells --------------------------------------------------------
  {
    name: "getcell",
    re: rx("M\\[B\\+" + V + "\\]=M\\[FP\\+5\\]\\.P\\[" + V + "\\]\\.x\\([^)]*\\);"),
    map: (g) => ({ dst: g[0], cell: g[1] }),
  },
  {
    name: "setcell",
    re: rx("M\\[FP\\+5\\]\\.P\\[" + V + "\\]\\.g\\([^,]*,[^,]*,[^,]*,M\\[B\\+" + V + "\\],[^)]*\\);"),
    map: (g) => ({ cell: g[0], src: g[1] }),
  },

  // literals -------------------------------------------------------------
  {
    name: "array",
    re: rx(
      "var \\w+=" + V + ";var \\w+=new Array\\(\\w+\\);for\\(var \\w+=0;\\w+<\\w+;\\w+\\+\\+\\)\\{\\w+\\[\\w+\\]=M\\[B\\+@\\d+\\];\\}M\\[B\\+@\\d+\\]=\\w+;"
    ),
    map: (g) => ({ count: g[0] }),
    variadic: "array",
  },
  {
    name: "object",
    re: rx(
      "var \\w+=\\{\\};for\\(var \\w+=0;\\w+<" + V + ";\\w+\\+\\+\\)\\{var \\w+=M\\[B\\+@\\d+\\];var \\w+=M\\[B\\+@\\d+\\];\\w+\\[\\w+\\]=\\w+;\\}M\\[B\\+@\\d+\\]=\\w+;"
    ),
    map: (g) => ({ count: g[0] }),
    variadic: "object",
  },

  // exception handling ---------------------------------------------------
  {
    name: "pushtry",
    re: rx(
      "var \\w+=M\\[FP\\+7\\];if\\(!\\w+\\)\\{M\\[FP\\+7\\]=\\w+=\\[\\];\\}\\w+\\.push\\(\\{G:" +
        V + ",j:" + V + ",W:" + V + ",Z:" + V + "\\}\\);"
    ),
    map: (g) => ({ finallyPc: g[0], j: g[1], w: g[2], z: g[3] }),
  },
  {
    name: "pushtry",
    re: rx(
      "var \\w+=M\\[FP\\+7\\];if\\(!\\w+\\)\\{M\\[FP\\+7\\]=\\w+=\\[\\];\\}\\w+\\.push\\(\\{M:" +
        V + ",i:" + V + "\\}\\);"
    ),
    map: (g) => ({ catchPc: g[0], catchReg: g[1] }),
  },
  { name: "poptry", re: rx("M\\[FP\\+7\\]\\.pop\\(\\);"), map: () => ({}) },

  // for-in ---------------------------------------------------------------
  {
    name: "forin_next",
    re: rx(
      "var \\w+=M\\[B\\+" + V + "\\];if\\(\\w+\\.l>=\\w+\\.v\\.length\\)\\{M\\[FP\\+6\\]=" + V +
        ";\\}else\\{M\\[B\\+" + V + "\\]=\\w+\\.v\\[\\w+\\.l\\+\\+\\];\\}"
    ),
    map: (g) => ({ iter: g[0], target: g[1], dst: g[2] }),
  },

  // self-modifying bytecode ---------------------------------------------
  {
    name: "decrypt",
    re: rx(
      "var \\w+=" + V + ";var \\w+=" + V + ";var \\w+=" + V + "\\^\\w+\\|0;for\\(var \\w+=\\w+;\\w+<" +
        V + ";\\w+\\+\\+\\)\\{\\w+=\\w+\\+2654435769\\|0;this\\.N\\[\\w+\\+\\(\\w+-\\w+\\)\\]=\\(this\\.N\\[\\w+\\]\\^\\(\\w+\\^\\w+>>>13\\)\\)>>>0;\\}"
    ),
    map: (g) => ({ dst: g[0], src: g[1], seed: g[2], end: g[3] }),
  },
];

// generated templates: binary and unary operators
for (const op of BIN_OPS) {
  const sep = /[a-z]/.test(op) ? " ?" : "";
  TEMPLATES.push({
    name: "bin",
    re: rx("M\\[B\\+" + V + "\\]=M\\[B\\+" + V + "\\]" + sep + esc(op) + sep + "M\\[B\\+" + V + "\\];"),
    map: (g) => ({ dst: g[0], a: g[1], b: g[2], op }),
  });
}
for (const op of UN_OPS) {
  const sep = /[a-z]/.test(op) ? " ?" : "";
  TEMPLATES.push({
    name: "un",
    re: rx("M\\[B\\+" + V + "\\]=" + esc(op) + sep + "M\\[B\\+" + V + "\\];"),
    map: (g) => ({ dst: g[0], a: g[1], op }),
  });
}
// Math.max / Math.min style helpers
TEMPLATES.push({
  name: "mathcall",
  re: rx("M\\[B\\+" + V + "\\]=Math\\.(\\w+)\\(M\\[B\\+" + V + "\\],M\\[B\\+" + V + "\\]\\);"),
  map: (g) => ({ dst: g[0], fn: g[1], a: g[2], b: g[3] }),
});

/** decode one canonical shape into an instruction descriptor */
function classify(shape) {
  for (const tpl of TEMPLATES) {
    const mm = tpl.re.exec(shape.code);
    if (mm) return Object.assign({ kind: tpl.name, variadic: tpl.variadic }, tpl.map(mm.slice(1)));
  }
  if (RET_RE.test(shape.code)) {
    const mm = /var \w+=M\[B\+(@\d+|\d+)\];this\.T\(/.exec(shape.code);
    if (mm) return { kind: "ret", reg: mm[1] };
  }
  // calls: `… = fn.apply(thisArg, args)` with a VM-function fast path
  if (/\.apply\(/.test(shape.code) && /new Array\(/.test(shape.code)) {
    const hasThis = /apply\(M\[B\+@?\d+\]|apply\(\w+,/.test(shape.code) && !/apply\(null,/.test(shape.code);
    return { kind: "call", withThis: hasThis, variadic: "call" };
  }
  if (/Reflect\.construct\(/.test(shape.code)) return { kind: "new", variadic: "call" };
  if (/_s_s\.set\(|\.prototype=\w+\.prototype/.test(shape.code)) return { kind: "closure", variadic: "closure" };
  if (/Object\.defineProperty\(/.test(shape.code)) return { kind: "defineprop" };
  if (/Object\.getOwnPropertyNames|Object\.create\(null\)/.test(shape.code))
    return { kind: "forin_init" };
  return { kind: "?", code: shape.code };
}

/* ------------------------------------------------------------------ *
 * 4. disassembler                                                     *
 * ------------------------------------------------------------------ */

function buildOpcodeTable(machine) {
  const table = new Map();
  for (const [op, fn] of machine.handlers) {
    const shape = shapeOf(fn);
    const info = classify(shape);
    info.operands = shape.operands;
    info.shape = shape.code;
    table.set(op, info);
  }
  return table;
}

/* ------------------------------------------------------------------ *
 * 5. decoding instructions                                            *
 * ------------------------------------------------------------------ */

const SPREAD_MARK = 10597911; // argument count sentinel meaning "one array"

/**
 * Instruction layouts that depend on a count read from the stream.  Everything
 * else is `info.operands` fixed words, in the order the handler reads them.
 */
const VARIADIC = {
  call: (read, info) => {
    const dst = read();
    const thisReg = info.withThis ? read() : null;
    const fn = read();
    const argc = read();
    const args = [];
    let spread = false;
    if (argc === SPREAD_MARK) {
      spread = true;
      args.push(read());
    } else for (let i = 0; i < argc; i++) args.push(read());
    return { dst, thisReg, fn, args, spread };
  },
  closure: (read) => {
    // dst, entry pc, parameter count, register count, cell count, rest flag,
    // then one (own?, index) pair per captured cell
    const dst = read();
    const pc = read();
    const params = read();
    const regs = read();
    const nCells = read();
    const rest = read();
    const cells = [];
    for (let i = 0; i < nCells; i++) cells.push({ own: read(), index: read() });
    return { dst, cells, meta: { params, regs, pc, rest: !!rest } };
  },
  array: (read) => {
    const count = read();
    const elems = [];
    for (let i = 0; i < count; i++) elems.push(read());
    return { elems, dst: read() };
  },
  object: (read) => {
    const dst = read();
    const count = read();
    const pairs = [];
    for (let i = 0; i < count; i++) pairs.push({ key: read(), value: read() });
    return { dst, pairs };
  },
};

/** replace `@n` operand slots with the values read for this instruction */
function bind(info, words) {
  const out = { kind: info.kind };
  for (const [k, v] of Object.entries(info)) {
    if (k === "kind" || k === "re" || k === "map" || k === "shape" || k === "operands") continue;
    if (typeof v === "string" && /^@\d+$/.test(v)) out[k] = words[Number(v.slice(1))];
    else if (typeof v === "string" && /^-?\d+$/.test(v)) out[k] = Number(v); // baked in
    else out[k] = v;
  }
  return out;
}

function disassemble(machine, table) {
  const N = machine.code.slice();
  const readConst = makeConstantReader(machine.pool);
  const functions = new Map(); // entry pc -> descriptor
  const queue = [{ pc: machine.entry.pc, meta: machine.entry, name: "main" }];
  const seenFn = new Set();
  let anon = 0;

  while (queue.length) {
    const job = queue.shift();
    if (seenFn.has(job.pc)) continue;
    seenFn.add(job.pc);

    const code = new Map(); // pc -> instruction
    const work = [job.pc];
    const visited = new Set();

    while (work.length) {
      let pc = work.pop();
      while (true) {
        if (visited.has(pc)) break;
        visited.add(pc);
        const at = pc;
        const op = N[pc++];
        const info = table.get(op);
        if (!info) {
          code.set(at, { kind: "??", op, next: null });
          break;
        }
        const words = [];
        const read = () => N[pc++];
        let ins;
        if (info.variadic) {
          ins = Object.assign({ kind: info.kind }, VARIADIC[info.variadic](read, info));
        } else {
          for (let i = 0; i < info.operands; i++) words.push(read());
          ins = bind(info, words);
        }
        ins.opcode = op;
        ins.at = at;
        ins.size = pc - at;

        // resolve constants so the listing reads properly
        if (ins.kind === "const" || ins.kind === "getglobal" || ins.kind === "setglobal" || ins.kind === "typeofglobal")
          ins.value = readConst(ins.index, ins.key);

        // self-modifying bytecode: run the decryptor now
        if (ins.kind === "decrypt") {
          let s = (ins.seed ^ ins.dst) | 0;
          for (let i = ins.src; i < ins.end; i++) {
            s = (s + 2654435769) | 0;
            N[ins.dst + (i - ins.src)] = (N[i] ^ (s ^ (s >>> 13))) >>> 0;
          }
        }

        if (ins.kind === "closure") {
          const nm = "f" + ++anon;
          ins.name = nm;
          queue.push({ pc: ins.meta.pc, meta: ins.meta, name: nm });
        }

        code.set(at, ins);

        // control flow
        if (ins.kind === "jmp") {
          pc = ins.target;
          continue;
        }
        if (ins.kind === "jz" || ins.kind === "jnz" || ins.kind === "forin_next") {
          work.push(ins.target);
          continue;
        }
        if (ins.kind === "pushtry") {
          if (ins.catchPc !== undefined) work.push(ins.catchPc);
          if (ins.finallyPc !== undefined) work.push(ins.finallyPc);
          continue;
        }
        if (ins.kind === "ret" || ins.kind === "throw" || ins.kind === "jmpreg" || ins.kind === "??")
          break;
      }
    }
    functions.set(job.pc, { name: job.name, meta: job.meta, code, entry: job.pc });
  }
  return { functions, N, readConst };
}

/* ------------------------------------------------------------------ *
 * 6. lifting: bytecode -> JavaScript                                  *
 * ------------------------------------------------------------------ */

const UNKNOWN = Symbol("unknown");

const lit = (v) => {
  if (typeof v === "number")
    return v < 0 ? t.unaryExpression("-", t.numericLiteral(-v)) : t.numericLiteral(v);
  if (typeof v === "string") return t.stringLiteral(v);
  if (typeof v === "boolean") return t.booleanLiteral(v);
  if (v === null) return t.nullLiteral();
  if (v === undefined) return t.identifier("undefined");
  return null;
};

/**
 * Symbolically execute one VM function.  Registers that provably hold a
 * constant are folded away, which is what dissolves the *second* layer of
 * control-flow flattening: the bytecode's own dispatch compares a register
 * against constants, so once the register is known every branch decides
 * itself and a real control flow graph falls out.
 */
/**
 * Splitting a block per constant state is what dissolves the flattening, but
 * a loop whose counter is constant would be unrolled forever.  So each program
 * point may be specialised a bounded number of times; past that it is *widened*
 * (analysed once with nothing known) and the analysis restarts.
 */
/**
 * Registers the bytecode compares against constants.  Those carry the source
 * program's own control-flow-flattening state, so they are the ones worth
 * specialising on; anything else (loop counters, accumulators) is joined.
 */
function stateRegisters(fn) {
  const out = new Set();
  for (const ins of fn.code.values()) {
    if (ins.kind !== "bin") continue;
    if (!["===", "!==", "==", "!="].includes(ins.op)) continue;
    out.add(ins.a);
    out.add(ins.b);
  }
  return out;
}

/**
 * Constant propagation with a fixpoint join.  A block is identified by its pc
 * *plus* the values of the flattening state registers, which is what dissolves
 * the dispatch; every other register is merged across incoming edges, so loops
 * stay loops instead of unrolling.
 */
function liftFunction(fn, ctx) {
  return analyseFunction(fn, ctx, stateRegisters(fn));
}

function joinValue(a, b) {
  if (a === undefined) return b;
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  return Object.is(a, b) ? a : UNKNOWN;
}

function joinInto(target, incoming) {
  let changed = false;
  for (const [k, v] of incoming) {
    const cur = target.has(k) ? target.get(k) : undefined;
    const j = joinValue(cur, v);
    if (cur === undefined || !Object.is(cur, j)) {
      target.set(k, j);
      changed = true;
    }
  }
  // a register the new edge says nothing about is unknown on that path
  for (const [k, v] of target)
    if (!incoming.has(k) && v !== UNKNOWN) {
      target.set(k, UNKNOWN);
      changed = true;
    }
  return changed;
}

function analyseFunction(fn, ctx, stateRegs) {
  const blocks = new Map();
  const R = (i) => t.identifier("r" + i);

  const stateKey = (pc, regs) => {
    const parts = [];
    for (const [k, v] of regs) if (v !== UNKNOWN && stateRegs.has(k)) parts.push(k + "=" + JSON.stringify(v));
    parts.sort();
    return pc + "|" + parts.join(",");
  };

  const entryKey = stateKey(fn.entry, new Map());
  blocks.set(entryKey, { key: entryKey, pc: fn.entry, regs: new Map(), stmts: [], term: null });
  const queue = [entryKey];
  let guard = 0;

  while (queue.length) {
    const key = queue.shift();
    const block = blocks.get(key);
    if (!block) continue;
    if (++guard > 60000) {
      ctx.warn("lift: analysis budget exhausted in " + fn.name);
      break;
    }
    block.stmts = [];
    block.term = null;
    const job = { pc: block.pc, regs: block.regs };

    const regs = new Map(job.regs);
    const get = (i) => (regs.has(i) ? regs.get(i) : UNKNOWN);
    const set = (i, v) => regs.set(i, v);
    /** expression for a register: its constant if known, else the variable */
    const use = (i) => {
      const v = get(i);
      if (v === UNKNOWN) return R(i);
      const l = lit(v);
      return l || R(i);
    };
    const emit = (node) => block.stmts.push(node);
    const assign = (dst, expr) => {
      set(dst, UNKNOWN);
      emit(t.expressionStatement(t.assignmentExpression("=", R(dst), expr)));
    };

    let pc = job.pc;
    let terminated = false;
    while (!terminated) {
      const ins = fn.code.get(pc);
      if (!ins) {
        block.term = { k: "end" };
        break;
      }
      const next = pc + ins.size;
      switch (ins.kind) {
        case "imm":
        case "const":
          set(ins.dst, ins.value);
          break;
        case "undef":
          set(ins.dst, undefined);
          break;
        case "mov":
          if (get(ins.src) !== UNKNOWN) set(ins.dst, get(ins.src));
          else assign(ins.dst, R(ins.src));
          break;
        case "this":
          assign(ins.dst, t.thisExpression());
          break;
        case "bin": {
          const a = get(ins.a);
          const b = get(ins.b);
          if (a !== UNKNOWN && b !== UNKNOWN && ctx.foldable(ins.op)) {
            set(ins.dst, ctx.fold(ins.op, a, b));
            break;
          }
          assign(ins.dst, t.binaryExpression(ins.op, use(ins.a), use(ins.b)));
          break;
        }
        case "un": {
          const a = get(ins.a);
          if (a !== UNKNOWN && ctx.foldableUnary(ins.op)) {
            set(ins.dst, ctx.foldUnary(ins.op, a));
            break;
          }
          assign(ins.dst, t.unaryExpression(ins.op, use(ins.a), true));
          break;
        }
        case "getprop":
          assign(ins.dst, member(use(ins.obj), use(ins.key)));
          break;
        case "setprop":
          emit(
            t.expressionStatement(
              t.assignmentExpression("=", member(use(ins.obj), use(ins.key)), use(ins.val))
            )
          );
          break;
        case "delete":
          assign(ins.dst, t.unaryExpression("delete", member(use(ins.obj), use(ins.key)), true));
          break;
        case "getglobal":
          assign(ins.dst, globalRef(ins.value));
          break;
        case "setglobal":
          emit(
            t.expressionStatement(t.assignmentExpression("=", globalRef(ins.value), use(ins.src)))
          );
          break;
        case "typeofglobal":
          assign(ins.dst, t.unaryExpression("typeof", globalRef(ins.value), true));
          break;
        case "getcell":
          assign(ins.dst, t.identifier("c" + ins.cell));
          break;
        case "setcell":
          emit(
            t.expressionStatement(
              t.assignmentExpression("=", t.identifier("c" + ins.cell), use(ins.src))
            )
          );
          break;
        case "array":
          assign(ins.dst, t.arrayExpression(ins.elems.map(use)));
          break;
        case "object":
          assign(
            ins.dst,
            t.objectExpression(
              ins.pairs.map((p) => t.objectProperty(use(p.key), use(p.value), true))
            )
          );
          break;
        case "call": {
          const args = ins.args.map(use);
          const callArgs = ins.spread ? [t.spreadElement(args[0])] : args;
          let callee = use(ins.fn);
          let node;
          if (ins.thisReg !== null && ins.thisReg !== undefined) {
            node = t.callExpression(
              t.memberExpression(callee, t.identifier("call")),
              [use(ins.thisReg)].concat(callArgs)
            );
          } else {
            node = t.callExpression(callee, callArgs);
          }
          assign(ins.dst, node);
          break;
        }
        case "new":
          assign(ins.dst, t.newExpression(use(ins.fn), ins.args.map(use)));
          break;
        case "closure":
          assign(ins.dst, t.identifier("__fn_" + ins.meta.pc));
          block.closures = block.closures || [];
          block.closures.push(ins);
          break;
        case "mathcall":
          assign(
            ins.dst,
            t.callExpression(
              t.memberExpression(t.identifier("Math"), t.identifier(ins.fn)),
              [use(ins.a), use(ins.b)]
            )
          );
          break;
        case "defineprop":
          emit(t.expressionStatement(t.identifier("/* Object.defineProperty */")));
          break;
        case "debugger":
          emit(t.debuggerStatement());
          break;
        case "decrypt":
          break; // already applied while disassembling
        case "ret":
          block.term = { k: "ret", arg: use(ins.reg) };
          terminated = true;
          break;
        case "throw":
          block.term = { k: "throw", arg: use(ins.reg) };
          terminated = true;
          break;
        case "jmp":
          block.term = { k: "goto", pc: ins.target, regs };
          terminated = true;
          break;
        case "jmpreg": {
          const v = get(ins.reg);
          if (v !== UNKNOWN && typeof v === "number") {
            block.term = { k: "goto", pc: v, regs };
          } else {
            block.term = { k: "end" };
          }
          terminated = true;
          break;
        }
        case "jz":
        case "jnz": {
          const v = get(ins.reg);
          const taken = ins.kind === "jz" ? (x) => !x : (x) => !!x;
          if (v !== UNKNOWN) {
            block.term = { k: "goto", pc: taken(v) ? ins.target : next, regs };
          } else {
            const test = ins.kind === "jz" ? t.unaryExpression("!", R(ins.reg), true) : R(ins.reg);
            block.term = {
              k: "if",
              test,
              then: { pc: ins.target, regs: new Map(regs) },
              else: { pc: next, regs: new Map(regs) },
            };
          }
          terminated = true;
          break;
        }
        case "pushtry":
        case "poptry":
        case "forin_init":
        case "forin_next":
          emit(t.expressionStatement(t.identifier("/* " + ins.kind + " */")));
          if (ins.kind === "forin_next") {
            block.term = {
              k: "if",
              test: t.identifier("/* forin */"),
              then: { pc: ins.target, regs: new Map(regs) },
              else: { pc: next, regs: new Map(regs) },
            };
            terminated = true;
          }
          break;
        default:
          emit(t.expressionStatement(t.identifier("/* " + ins.kind + " */")));
          break;
      }
      if (!terminated) pc = next;
    }

    if (!block.term) block.term = { k: "end" };
    // name the successors and merge this edge's state into them
    const push = (tgt) => {
      tgt.regs = new Map(tgt.regs);
      tgt.key = stateKey(tgt.pc, tgt.regs);
      let succ = blocks.get(tgt.key);
      if (!succ) {
        succ = { key: tgt.key, pc: tgt.pc, regs: new Map(tgt.regs), stmts: [], term: null };
        blocks.set(tgt.key, succ);
        queue.push(tgt.key);
      } else if (joinInto(succ.regs, tgt.regs)) {
        if (!queue.includes(tgt.key)) queue.push(tgt.key);
      }
      return tgt.key;
    };
    if (block.term.k === "goto") block.term.key = push(block.term);
    if (block.term.k === "if") {
      push(block.term.then);
      push(block.term.else);
    }
  }

  // a value the successor no longer knows must be handed over explicitly
  for (const b of blocks.values()) {
    const edges = b.term && b.term.k === "goto" ? [b.term] : b.term && b.term.k === "if" ? [b.term.then, b.term.else] : [];
    for (const e of edges) {
      const succ = blocks.get(e.key);
      e.fix = [];
      if (!succ) continue;
      for (const [i, v] of e.regs || [])
        if (v !== UNKNOWN && succ.regs.get(i) === UNKNOWN) {
          const l = lit(v);
          if (l) e.fix.push(t.expressionStatement(t.assignmentExpression("=", R(i), l)));
        }
    }
  }
  return { entryKey, blocks };
}

function member(obj, key) {
  if (key.type === "StringLiteral" && t.isValidIdentifier(key.value))
    return t.memberExpression(obj, t.identifier(key.value));
  return t.memberExpression(obj, key, true);
}

function globalRef(name) {
  return typeof name === "string" && t.isValidIdentifier(name)
    ? t.identifier(name)
    : t.memberExpression(t.identifier("globalThis"), lit(name), true);
}

/* ------------------------------------------------------------------ *
 * 6b. local SSA: one name per assignment, so expressions can be rebuilt *
 * ------------------------------------------------------------------ */

const REG_RE = /^r\d+$/; // a machine register
const TEMP_RE = /^r\d+(_\d+)?$/; // register or one of its SSA versions
const VAR_RE = /^[rc]\d+(_\d+)?$/; // …or a closure cell

function walkNodes(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k of t.VISITOR_KEYS[node.type] || []) {
    const c = node[k];
    if (Array.isArray(c)) c.forEach((x) => walkNodes(x, fn));
    else if (c && typeof c.type === "string") walkNodes(c, fn);
  }
}

/** registers a statement reads / writes (a plain `r5 = …` is the only write) */
function defOf(stmt) {
  if (
    stmt.type === "ExpressionStatement" &&
    stmt.expression.type === "AssignmentExpression" &&
    stmt.expression.operator === "=" &&
    stmt.expression.left.type === "Identifier" &&
    REG_RE.test(stmt.expression.left.name)
  )
    return stmt.expression.left.name;
  return null;
}

function usesOf(stmt) {
  const out = new Set();
  const skip = defOf(stmt) ? stmt.expression.left : null;
  walkNodes(stmt, (n) => {
    if (n.type === "Identifier" && REG_RE.test(n.name) && n !== skip) out.add(n.name);
  });
  return out;
}

/**
 * Rename every assignment to a fresh name inside its block, keeping the shared
 * register name only where the value is actually live on the way out.  That is
 * what lets the readability pass rebuild `document.createElement("div")` from
 * three separate register moves.
 */
function localSSA(lifted) {
  const { blocks } = lifted;

  // liveness over the lifted control flow graph
  const use = new Map();
  const def = new Map();
  for (const [k, b] of blocks) {
    const u = new Set();
    const d = new Set();
    const consider = (stmt) => {
      for (const r of usesOf(stmt)) if (!d.has(r)) u.add(r);
      const dd = defOf(stmt);
      if (dd) d.add(dd);
    };
    b.stmts.forEach(consider);
    const term = b.term;
    const extra = [];
    if (term.k === "ret" || term.k === "throw") extra.push(t.expressionStatement(term.arg));
    if (term.k === "if") extra.push(t.expressionStatement(term.test));
    extra.forEach((s) => {
      for (const r of usesOf(s)) if (!d.has(r)) u.add(r);
    });
    for (const fix of edgeFixes(term)) {
      const dd = defOf(fix);
      if (dd) d.add(dd);
    }
    use.set(k, u);
    def.set(k, d);
  }

  const liveIn = new Map([...blocks.keys()].map((k) => [k, new Set()]));
  const liveOut = new Map([...blocks.keys()].map((k) => [k, new Set()]));
  const order = [...blocks.keys()].reverse(); // backwards flows faster this way
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  for (let round = 0; round < blocks.size + 8; round++) {
    let changed = false;
    for (const k of order) {
      const b = blocks.get(k);
      const out = new Set();
      for (const s of succOf(b.term)) for (const r of liveIn.get(s) || []) out.add(r);
      const inn = new Set(use.get(k));
      for (const r of out) if (!def.get(k).has(r)) inn.add(r);
      if (!same(inn, liveIn.get(k)) || !same(out, liveOut.get(k))) changed = true;
      liveIn.set(k, inn);
      liveOut.set(k, out);
    }
    if (!changed) break;
  }

  let uid = 0;
  for (const [k, b] of blocks) {
    const cur = new Map(); // register -> current name
    const rename = (stmt) => {
      const d = defOf(stmt);
      const skip = d ? stmt.expression.left : null;
      walkNodes(stmt, (n) => {
        if (n.type === "Identifier" && REG_RE.test(n.name) && n !== skip && cur.has(n.name))
          n.name = cur.get(n.name);
      });
      if (d) {
        const fresh = d + "_" + ++uid;
        stmt.expression.left.name = fresh;
        cur.set(d, fresh);
      }
    };
    b.stmts.forEach(rename);
    const term = b.term;
    const patch = (node) =>
      node &&
      walkNodes(node, (n) => {
        if (n.type === "Identifier" && REG_RE.test(n.name) && cur.has(n.name))
          n.name = cur.get(n.name);
      });
    if (term.k === "ret" || term.k === "throw") patch(term.arg);
    if (term.k === "if") patch(term.test);
    // hand the live values back to the shared register names
    const tail = [];
    for (const [reg, name] of cur)
      if ((liveOut.get(k) || new Set()).has(reg))
        tail.push(
          t.expressionStatement(t.assignmentExpression("=", t.identifier(reg), t.identifier(name)))
        );
    b.stmts.push(...tail);
  }
}

function edgeFixes(term) {
  if (!term) return [];
  if (term.k === "goto") return term.fix || [];
  if (term.k === "if") return (term.then.fix || []).concat(term.else.fix || []);
  return [];
}

/* ------------------------------------------------------------------ *
 * 7. structuring the lifted CFG                                       *
 * ------------------------------------------------------------------ */

function succOf(term) {
  if (!term) return [];
  if (term.k === "goto") return [term.key];
  if (term.k === "if") return [term.then.key, term.else.key];
  return [];
}

function structure(lifted, warn) {
  const { blocks, entryKey } = lifted;
  if (!blocks.has(entryKey)) return [];

  const order = [];
  const seen = new Set();
  (function dfs(k) {
    if (seen.has(k) || !blocks.has(k)) return;
    seen.add(k);
    for (const s of succOf(blocks.get(k).term)) dfs(s);
    order.push(k);
  })(entryKey);
  const rpo = order.slice().reverse();
  const idx = new Map(rpo.map((k, i) => [k, i]));
  const preds = new Map(rpo.map((k) => [k, []]));
  for (const k of rpo)
    for (const s of succOf(blocks.get(k).term)) if (idx.has(s)) preds.get(s).push(k);

  const idom = dominators(rpo, idx, preds);
  const ipdom = postDominators(rpo, idx, blocks);
  const loops = new Map();
  for (const k of rpo)
    for (const s of succOf(blocks.get(k).term))
      if (idx.has(s) && dominates(idom, s, k)) {
        if (!loops.has(s)) loops.set(s, new Set([s]));
        const set = loops.get(s);
        const stack = [k];
        while (stack.length) {
          const n = stack.pop();
          if (set.has(n)) continue;
          set.add(n);
          for (const p of preds.get(n) || []) if (p !== s) stack.push(p);
        }
      }

  let labelId = 0;
  const emitted = new Set();
  const budget = { left: Math.max(400, blocks.size * 4) };
  const ctx = { loopStack: [], duplicated: 0 };
  const BAIL = {};

  function emitSeq(start, stop) {
    const out = [];
    let cur = start;
    let steps = 0;
    while (cur && !stop.has(cur)) {
      if (--budget.left < 0) throw BAIL;
      if (++steps > 5000) break;
      if (loops.has(cur) && !ctx.loopStack.some((l) => l.header === cur)) {
        const r = emitLoop(cur, stop);
        out.push(...r.stmts);
        cur = r.next;
        continue;
      }
      const b = blocks.get(cur);
      if (!b) break;
      if (emitted.has(cur)) ctx.duplicated++;
      emitted.add(cur);
      out.push(...b.stmts.map((s) => t.cloneNode(s, true)));
      const term = b.term;
      if (term.k === "ret") {
        out.push(t.returnStatement(t.cloneNode(term.arg, true)));
        cur = null;
      } else if (term.k === "throw") {
        out.push(t.throwStatement(t.cloneNode(term.arg, true)));
        cur = null;
      } else if (term.k === "goto") {
        out.push(...(term.fix || []).map((s) => t.cloneNode(s, true)));
        const j = jump(term.key);
        if (j) {
          out.push(j);
          cur = null;
        } else cur = term.key;
      } else if (term.k === "if") {
        const merge = ipdom.get(cur);
        const inner = new Set(stop);
        if (merge && merge !== EXIT) inner.add(merge);
        const a = (term.then.fix || [])
          .map((s) => t.cloneNode(s, true))
          .concat(branch(term.then.key, inner, merge));
        const c = (term.else.fix || [])
          .map((s) => t.cloneNode(s, true))
          .concat(branch(term.else.key, inner, merge));
        out.push(
          t.ifStatement(
            t.cloneNode(term.test, true),
            t.blockStatement(a),
            c.length ? t.blockStatement(c) : null
          )
        );
        cur = merge && merge !== EXIT ? merge : null;
      } else cur = null;
    }
    return out;
  }

  function branch(target, stop, merge) {
    if (target === merge) return [];
    const j = jump(target);
    if (j) return [j];
    return emitSeq(target, stop);
  }

  function jump(target) {
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
    return null;
  }

  function emitLoop(header, stop) {
    const nodes = loops.get(header);
    const exits = new Set();
    for (const n of nodes)
      for (const s of succOf(blocks.get(n).term)) if (!nodes.has(s)) exits.add(s);
    let follow = ipdom.get(header);
    if (!follow || !exits.has(follow)) follow = exits.size ? [...exits][0] : null;
    const label = "L" + ++labelId;
    const frame = { header, follow, label, usedBreak: false, usedContinue: false };
    ctx.loopStack.push(frame);
    const inner = new Set(stop);
    if (follow) inner.add(follow);
    const body = emitSeq(header, inner);
    ctx.loopStack.pop();
    body.push(t.breakStatement(t.identifier(label)));
    frame.usedBreak = true;
    const loop = t.whileStatement(t.booleanLiteral(true), t.blockStatement(body));
    return {
      stmts: [t.labeledStatement(t.identifier(label), loop)],
      next: follow,
    };
  }

  let stmts;
  try {
    stmts = emitSeq(entryKey, new Set());
  } catch (e) {
    if (e !== BAIL) throw e;
    // irreducible or heavily shared control flow: fall back to an explicit
    // program counter, which is always correct if less pretty
    if (warn) warn("structuring fell back to a pc loop");
    return dispatchLoop(lifted);
  }
  if (ctx.duplicated && warn) warn(ctx.duplicated + " duplicated block(s) while structuring");
  return stmts;
}

/** last resort: `var pc = 0; L: while (true) switch (pc) { … }` */
function dispatchLoop(lifted) {
  const { blocks, entryKey } = lifted;
  const ids = new Map();
  for (const k of blocks.keys()) ids.set(k, ids.size);
  const PC = t.identifier("_pc");
  const L = t.identifier("_dispatch");
  const goTo = (key) => [
    t.expressionStatement(t.assignmentExpression("=", PC, t.numericLiteral(ids.get(key)))),
    t.continueStatement(L),
  ];
  const cases = [];
  for (const [key, b] of blocks) {
    const body = b.stmts.map((s) => t.cloneNode(s, true));
    const term = b.term;
    if (term.k === "ret") body.push(t.returnStatement(t.cloneNode(term.arg, true)));
    else if (term.k === "throw") body.push(t.throwStatement(t.cloneNode(term.arg, true)));
    else if (term.k === "goto") {
      body.push(...(term.fix || []).map((s) => t.cloneNode(s, true)));
      body.push(...goTo(term.key));
    } else if (term.k === "if") {
      body.push(
        t.ifStatement(
          t.cloneNode(term.test, true),
          t.blockStatement(
            (term.then.fix || []).map((s) => t.cloneNode(s, true)).concat(goTo(term.then.key))
          ),
          t.blockStatement(
            (term.else.fix || []).map((s) => t.cloneNode(s, true)).concat(goTo(term.else.key))
          )
        )
      );
    } else body.push(t.returnStatement(null));
    cases.push(t.switchCase(t.numericLiteral(ids.get(key)), body));
  }
  return [
    t.variableDeclaration("var", [
      t.variableDeclarator(PC, t.numericLiteral(ids.get(entryKey))),
    ]),
    t.labeledStatement(
      L,
      t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.switchStatement(PC, cases)]))
    ),
  ];
}

const EXIT = "<exit>";

function dominators(rpo, idx, preds) {
  const idom = new Map();
  if (!rpo.length) return idom;
  idom.set(rpo[0], rpo[0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < rpo.length; i++) {
      const b = rpo[i];
      let nd = null;
      for (const p of preds.get(b) || []) {
        if (!idom.has(p)) continue;
        nd = nd === null ? p : meet(idom, idx, p, nd);
      }
      if (nd !== null && idom.get(b) !== nd) {
        idom.set(b, nd);
        changed = true;
      }
    }
  }
  return idom;
}

function meet(idom, idx, a, b) {
  let guard = 0;
  while (a !== b && guard++ < 100000) {
    while (idx.get(a) > idx.get(b)) a = idom.get(a);
    while (idx.get(b) > idx.get(a)) b = idom.get(b);
  }
  return a;
}

function dominates(idom, a, b) {
  let cur = b;
  const seen = new Set();
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === a) return true;
    seen.add(cur);
    const n = idom.get(cur);
    if (n === cur) break;
    cur = n;
  }
  return false;
}

function postDominators(rpo, idxIn, blocks) {
  const nodes = rpo.slice().reverse();
  const order = [EXIT].concat(nodes);
  const idx = new Map(order.map((k, i) => [k, i]));
  const rsucc = new Map();
  for (const k of rpo) {
    const s = succOf(blocks.get(k).term).filter((x) => blocks.has(x));
    rsucc.set(k, s.length ? s : [EXIT]);
  }
  const ipdom = new Map([[EXIT, EXIT]]);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    for (const b of nodes) {
      let np = null;
      for (const s of rsucc.get(b) || []) {
        if (!ipdom.has(s)) continue;
        np = np === null ? s : meet(ipdom, idx, s, np);
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
 * 8. driver                                                           *
 * ------------------------------------------------------------------ */

const FOLDABLE = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "**": (a, b) => a ** b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
  "&": (a, b) => a & b,
  "|": (a, b) => a | b,
  "^": (a, b) => a ^ b,
  "<<": (a, b) => a << b,
  ">>": (a, b) => a >> b,
  ">>>": (a, b) => a >>> b,
};
const FOLDABLE_UN = {
  "!": (a) => !a,
  "-": (a) => -a,
  "+": (a) => +a,
  "~": (a) => ~a,
  typeof: (a) => typeof a,
  void: () => undefined,
};

function devirtualize(source, opts) {
  opts = opts || {};
  const warnings = [];
  const warn = (m) => warnings.length < 40 && warnings.push(m);
  const ast = parser.parse(source, { sourceType: "unambiguous" });
  const machine = extractMachine(ast);
  if (!machine.code || !machine.pool || !machine.entry || machine.handlers.size < 8)
    return { code: null, warnings: ["no virtual machine found"] };

  const table = buildOpcodeTable(machine);
  const unknown = [...table].filter(([, i]) => i.kind === "?");
  if (unknown.length) warn(unknown.length + " opcode(s) not recognised");

  const dis = disassemble(machine, table);
  const ctx = {
    warn,
    foldable: (op) => Object.prototype.hasOwnProperty.call(FOLDABLE, op),
    fold: (op, a, b) => FOLDABLE[op](a, b),
    foldableUnary: (op) => Object.prototype.hasOwnProperty.call(FOLDABLE_UN, op),
    foldUnary: (op, a) => FOLDABLE_UN[op](a),
  };

  const out = [];
  for (const [entry, fn] of dis.functions) {
    const lifted = liftFunction(fn, ctx);
    localSSA(lifted);
    const body = structure(lifted, warn);
    const params = [];
    for (let i = 0; i < fn.meta.params; i++) params.push(t.identifier("r" + i));
    const name = fn.name === "main" ? "__main" : "__fn_" + entry;
    out.push(t.functionDeclaration(t.identifier(name), params, t.blockStatement(body)));
  }
  out.push(t.expressionStatement(t.callExpression(t.identifier("__main"), [])));

  const file = t.file(t.program(out));
  cleanup(file);
  return {
    code: generate(file, { compact: false, comments: true }).code,
    warnings,
    stats: {
      functions: dis.functions.size,
      opcodes: table.size,
      bytecode: machine.code.length,
      unknownOpcodes: unknown.length,
    },
  };
}

/** readability pass over the lifted program */
function cleanup(file) {
  const skip = (process.env.DEVIRT_SKIP || "").split(",");
  for (let round = 0; round < 4000; round++) {
    declareRegisters(file);
    const a = skip.includes("call") ? 0 : foldMethodCalls(file);
    const b = skip.includes("copy") ? 0 : copyPropagate(file);
    const c = skip.includes("inline") ? 0 : inlineTemporaries(file);
    if (!a && !b && !c) break;
  }
  declareRegisters(file);
  dropDeadStores(file);
  dropUnreachable(file);
  normaliseLoops(file);
  dropUnusedResults(file);
  declareRegisters(file);
  dropDeadStores(file);
  mergeDeclarations(file);
  // a trailing `return undefined` is what the VM's return opcode compiles to
  traverse(file, {
    Function(p) {
      const body = p.node.body.body;
      const last = body[body.length - 1];
      if (
        last &&
        last.type === "ReturnStatement" &&
        last.argument &&
        last.argument.type === "Identifier" &&
        last.argument.name === "undefined"
      )
        body.pop();
    },
  });
  // `r12` reads like a machine register; `v12` like a variable
  traverse(file, {
    Identifier(p) {
      if (TEMP_RE.test(p.node.name)) p.node.name = "v" + p.node.name.slice(1);
    },
  });
}

/** every register a function writes becomes a local, so scope analysis works */
function declareRegisters(file) {
  traverse(file, {
    Function(p) {
      // drop the declaration from a previous round, then rebuild it
      p.node.body.body = p.node.body.body.filter(
        (s) =>
          !(
            s.type === "VariableDeclaration" &&
            s.declarations.every(
              (d) => !d.init && d.id.type === "Identifier" && VAR_RE.test(d.id.name)
            )
          )
      );
      const params = new Set(p.node.params.map((q) => q.name));
      const names = new Set();
      p.traverse({
        Identifier(q) {
          if (VAR_RE.test(q.node.name) && !params.has(q.node.name)) names.add(q.node.name);
        },
      });
      if (!names.size) return;
      p.node.body.body.unshift(
        t.variableDeclaration(
          "var",
          [...names].sort().map((n) => t.variableDeclarator(t.identifier(n)))
        )
      );
    },
  });
}

/** `o.m.call(o, …)` -> `o.m(…)` */
function foldMethodCalls(file) {
  let n = 0;
  traverse(file, {
    CallExpression(p) {
      const c = p.node.callee;
      if (c.type !== "MemberExpression" || c.computed) return;
      if (c.property.name !== "call" || !p.node.arguments.length) return;
      const fnExpr = c.object;
      if (fnExpr.type !== "MemberExpression") return;
      const a = generate(fnExpr.object, { compact: true }).code;
      const b = generate(p.node.arguments[0], { compact: true }).code;
      if (a !== b) return;
      p.node.callee = fnExpr;
      p.node.arguments = p.node.arguments.slice(1);
      n++;
    },
  });
  return n;
}

/**
 * `a = b;` where both are single-assignment locals is just a rename; the
 * lifter emits a lot of them handing SSA values back to the shared register.
 */
function copyPropagate(file) {
  // Only the local form is provably safe: `y = <expr>; x = y;` with `y` used
  // nowhere else is just `x = <expr>`.  A global rename would need dominance
  // information the pc-loop form does not give us.
  const jobs = [];
  traverse.cache.clear();
  traverse(file, {
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (e.type !== "AssignmentExpression" || e.operator !== "=") return;
      if (e.left.type !== "Identifier" || e.right.type !== "Identifier") return;
      if (!VAR_RE.test(e.left.name) || !VAR_RE.test(e.right.name)) return;
      if (e.left.name === e.right.name) {
        jobs.push({ kind: "self", p });
        return;
      }
      // scan back for the definition, past statements that cannot interfere
      let prev = null;
      for (let k = p.key - 1; k >= 0 && p.key - k <= 6; k--) {
        const s = p.getSibling(k);
        if (!s || !s.node) break;
        const d = s.node.expression;
        if (
          s.node.type === "ExpressionStatement" &&
          d &&
          d.type === "AssignmentExpression" &&
          d.operator === "=" &&
          d.left.type === "Identifier" &&
          d.left.name === e.right.name
        ) {
          prev = s;
          break;
        }
        if (interferes(s.node, e.right.name)) break;
      }
      if (!prev) return;
      const d = prev.node.expression;
      if (!TEMP_RE.test(d.left.name)) return;
      const b = p.scope.getBinding(d.left.name);
      if (!b || b.constantViolations.length !== 1) return;
      if (b.referencePaths.length !== 1 || b.referencePaths[0].node !== e.right) return;
      jobs.push({ kind: "merge", p, prev, target: e.left.name });
    },
  });
  if (!jobs.length) return 0;
  const j = jobs[0];
  if (j.kind === "self") j.p.remove();
  else {
    j.prev.node.expression.left = t.identifier(j.target);
    j.p.remove();
  }
  return 1;
}

/** fold `r5 = <expr>;` into its single, immediately following use */
function inlineTemporaries(file) {
  // collect with valid bindings, then apply - mutating mid-traversal would
  // leave Babel's scope information stale and silently drop assignments
  const jobs = [];
  traverse.cache.clear();
  traverse(file, {
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (e.type !== "AssignmentExpression" || e.operator !== "=") return;
      if (e.left.type !== "Identifier" || !TEMP_RE.test(e.left.name)) return;
      const b = p.scope.getBinding(e.left.name);
      if (!b || b.constantViolations.length !== 1) return;
      const reads = b.referencePaths;
      if (reads.length !== 1) return;
      const use = reads[0];
      if (use.getFunctionParent() !== p.getFunctionParent()) return;
      if (!sameRun(p, use)) return;
      jobs.push({ def: p, use, value: e.right });
    },
  });
  // one at a time: every substitution can invalidate the rest
  if (!jobs.length) return 0;
  const j = jobs[0];
  j.use.replaceWith(t.cloneNode(j.value, true));
  j.def.remove();
  return 1;
}

/** statements after a `break` / `continue` / `return` / `throw` never run */
function dropUnreachable(file) {
  traverse(file, {
    BlockStatement(p) {
      const body = p.node.body;
      for (let i = 0; i < body.length; i++) {
        const s = body[i].type;
        if (s === "BreakStatement" || s === "ContinueStatement" || s === "ReturnStatement" || s === "ThrowStatement") {
          if (i < body.length - 1) p.node.body = body.slice(0, i + 1);
          break;
        }
      }
    },
  });
}

/**
 * `L: while (true) { if (T) { … continue L; } else { break L; } }`
 * is the shape the structurer produces for an ordinary `while (T) { … }`.
 */
function normaliseLoops(file) {
  traverse(file, {
    WhileStatement(p) {
      if (p.node.test.type !== "BooleanLiteral" || p.node.test.value !== true) return;
      const labelled = p.parentPath.isLabeledStatement() ? p.parentPath.node.label.name : null;
      let body = p.node.body.body;
      // the structurer leaves a `break L;` behind the if; it is unreachable
      if (
        body.length === 2 &&
        body[1].type === "BreakStatement" &&
        (!body[1].label || !labelled || body[1].label.name === labelled)
      )
        body = body.slice(0, 1);
      if (body.length !== 1 || body[0].type !== "IfStatement") return;
      const ifs = body[0];
      if (!ifs.alternate) return;
      const cons = ifs.consequent.type === "BlockStatement" ? ifs.consequent.body : [ifs.consequent];
      const alt = ifs.alternate.type === "BlockStatement" ? ifs.alternate.body : [ifs.alternate];
      const isJump = (s, kind) =>
        s &&
        s.type === kind &&
        (!s.label || !labelled || s.label.name === labelled);
      if (!isJump(cons[cons.length - 1], "ContinueStatement")) return;
      if (alt.length !== 1 || !isJump(alt[0], "BreakStatement")) return;
      p.node.test = ifs.test;
      p.node.body = t.blockStatement(cons.slice(0, -1));
      if (labelled) p.parentPath.replaceWith(p.node);
    },
  });
}

/** `v12 = f();` where nothing reads `v12` is just `f();` */
function dropUnusedResults(file) {
  traverse.cache.clear();
  traverse(file, {
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (e.type !== "AssignmentExpression" || e.operator !== "=") return;
      if (e.left.type !== "Identifier" || !VAR_RE.test(e.left.name)) return;
      const b = p.scope.getBinding(e.left.name);
      if (!b || b.referencePaths.length || b.constantViolations.length !== 1) return;
      p.node.expression = e.right;
    },
  });
}

/** `var x; … x = e;` -> `var x = e;` when that is the only assignment */
function mergeDeclarations(file) {
  traverse.cache.clear();
  traverse(file, {
    Function(p) {
      const body = p.node.body.body;
      if (!body.length || body[0].type !== "VariableDeclaration") return;
      const decl = body[0];
      const names = new Set(
        decl.declarations.filter((d) => !d.init).map((d) => d.id.name)
      );
      const done = new Set();
      for (let i = 1; i < body.length; i++) {
        const s = body[i];
        if (s.type !== "ExpressionStatement") continue;
        const e = s.expression;
        if (e.type !== "AssignmentExpression" || e.operator !== "=") continue;
        if (e.left.type !== "Identifier" || !names.has(e.left.name)) continue;
        const b = p.scope.getBinding(e.left.name);
        if (!b || b.constantViolations.length !== 1 || done.has(e.left.name)) continue;
        body[i] = t.variableDeclaration("var", [
          t.variableDeclarator(t.identifier(e.left.name), e.right),
        ]);
        done.add(e.left.name);
      }
      decl.declarations = decl.declarations.filter(
        (d) => !(names.has(d.id.name) && done.has(d.id.name))
      );
      if (!decl.declarations.length) body.shift();
    },
  });
}

function dropDeadStores(file) {
  for (let round = 0; round < 6; round++) {
    let n = 0;
    traverse.cache.clear();
    traverse(file, {
      ExpressionStatement(p) {
        const e = p.node.expression;
        if (e.type !== "AssignmentExpression" || e.operator !== "=") return;
        if (e.left.type !== "Identifier" || !VAR_RE.test(e.left.name)) return;
        const b = p.scope.getBinding(e.left.name);
        if (!b || b.referencePaths.length) return;
        if (!isPure(e.right)) return;
        p.remove();
        n++;
      },
      VariableDeclarator(p) {
        if (p.node.init || p.node.id.type !== "Identifier") return;
        if (!VAR_RE.test(p.node.id.name)) return;
        const b = p.scope.getBinding(p.node.id.name);
        if (!b || b.referencePaths.length || b.constantViolations.length) return;
        if (p.parentPath.node.declarations.length === 1) p.parentPath.remove();
        else p.remove();
        n++;
      },
    });
    if (!n) break;
  }
}

/** the definition and its single use are in the same straight-line run */
function sameRun(defPath, usePath) {
  const parent = defPath.parentPath;
  if (!parent || !Array.isArray(parent.node.body)) return false;
  let cur = usePath;
  while (cur && cur.parentPath !== parent) cur = cur.parentPath;
  if (!cur) return false;
  const body = parent.node.body;
  const di = body.indexOf(defPath.node);
  const ui = body.indexOf(cur.node);
  if (di < 0 || ui < 0 || ui < di) return false;
  // nothing in between may write to anything the value depends on
  return ui - di <= 1;
}

/**
 * Can a definition be moved across `stmt`?  Only if the statement performs no
 * call (which could observe or change anything) and never mentions the name.
 */
function interferes(stmt, name) {
  let bad = false;
  walkNodes(stmt, (n) => {
    if (n.type === "CallExpression" || n.type === "NewExpression") bad = true;
    if (n.type === "Identifier" && n.name === name) bad = true;
    if (n.type === "UpdateExpression") bad = true;
  });
  return bad;
}

function isPure(node) {
  let pure = true;
  const walk = (n) => {
    if (!pure || !n || typeof n.type !== "string") return;
    if (n.type === "CallExpression" || n.type === "NewExpression" || n.type === "AssignmentExpression") {
      pure = false;
      return;
    }
    for (const k of t.VISITOR_KEYS[n.type] || []) {
      const c = n[k];
      if (Array.isArray(c)) c.forEach(walk);
      else if (c && typeof c.type === "string") walk(c);
    }
  };
  walk(node);
  return pure;
}

module.exports = {
  extractMachine,
  decodeWords,
  makeConstantReader,
  shapeOf,
  classify,
  buildOpcodeTable,
  disassemble,
  liftFunction,
  localSSA,
  structure,
  devirtualize,
};

if (require.main === module) {
  const src = fs.readFileSync(process.argv[2] || "debug/vmlevel.js", "utf8");
  const ast = parser.parse(src, { sourceType: "unambiguous" });
  const m = extractMachine(ast);
  const table = buildOpcodeTable(m);
  const byKind = new Map();
  for (const [, i] of table) byKind.set(i.kind, (byKind.get(i.kind) || 0) + 1);
  console.log("pool " + m.pool.length + "  code " + m.code.length + "  handlers " + table.size);
  console.log("entry " + JSON.stringify(m.entry));
  console.log(
    "kinds: " +
      [...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + "=" + n).join(" ")
  );
  const unknown = [...table].filter(([, i]) => i.kind === "?");
  if (unknown.length) {
    console.log("\nunclassified (" + unknown.length + "):");
    for (const [op, i] of unknown.slice(0, 12)) console.log("  " + op + "  " + i.shape.slice(0, 150));
  }

  const res = devirtualize(src, {});
  if (res.code) {
    const outFile = process.argv[3] || "debug/program.js";
    fs.writeFileSync(outFile, res.code);
    console.log("\ndevirtualised -> " + outFile + " (" + res.code.length + " bytes)");
    console.log("stats: " + JSON.stringify(res.stats));
  }
  for (const w of res.warnings) console.log("  ! " + w);

  const dis = disassemble(m, table);
  console.log("\nfunctions: " + dis.functions.size);
  const lines = [];
  for (const [entry, f] of dis.functions) {
    lines.push(
      "; ---- " + f.name + "  entry=" + entry + " params=" + f.meta.params +
      " regs=" + f.meta.regs + (f.meta.rest ? " rest" : "") + " ----"
    );
    for (const pc of [...f.code.keys()].sort((a, b) => a - b)) {
      const i = f.code.get(pc);
      lines.push("  " + String(pc).padStart(5) + "  " + describe(i));
    }
    lines.push("");
  }
  fs.writeFileSync("debug/disasm.txt", lines.join("\n"));
  console.log("listing -> debug/disasm.txt (" + lines.length + " lines)");
}

function describe(i) {
  const r = (x) => "r" + x;
  switch (i.kind) {
    case "mov": return r(i.dst) + " = " + r(i.src);
    case "bin": return r(i.dst) + " = " + r(i.a) + " " + i.op + " " + r(i.b);
    case "un": return r(i.dst) + " = " + i.op + (/[a-z]/.test(i.op) ? " " : "") + r(i.a);
    case "imm": return r(i.dst) + " = " + i.value;
    case "undef": return r(i.dst) + " = undefined";
    case "this": return r(i.dst) + " = this";
    case "const": return r(i.dst) + " = " + JSON.stringify(i.value);
    case "getprop": return r(i.dst) + " = " + r(i.obj) + "[" + r(i.key) + "]";
    case "setprop": return r(i.obj) + "[" + r(i.key) + "] = " + r(i.val);
    case "delete": return r(i.dst) + " = delete " + r(i.obj) + "[" + r(i.key) + "]";
    case "getglobal": return r(i.dst) + " = global " + JSON.stringify(i.value);
    case "setglobal": return "global " + JSON.stringify(i.value) + " = " + r(i.src);
    case "typeofglobal": return r(i.dst) + " = typeof global " + JSON.stringify(i.value);
    case "getcell": return r(i.dst) + " = cell[" + i.cell + "]";
    case "setcell": return "cell[" + i.cell + "] = " + r(i.src);
    case "jmp": return "jmp " + i.target;
    case "jmpreg": return "jmp " + r(i.reg);
    case "jz": return "if (!" + r(i.reg) + ") jmp " + i.target;
    case "jnz": return "if (" + r(i.reg) + ") jmp " + i.target;
    case "ret": return "return " + r(i.reg);
    case "throw": return "throw " + r(i.reg);
    case "call":
      return (
        r(i.dst) + " = " + (i.thisReg !== null ? r(i.thisReg) + "." : "") + r(i.fn) +
        "(" + (i.spread ? "..." : "") + i.args.map(r).join(", ") + ")"
      );
    case "new": return r(i.dst) + " = new " + r(i.fn) + "(" + i.args.map(r).join(", ") + ")";
    case "closure":
      return r(i.dst) + " = closure " + i.name + " @" + i.meta.pc +
        " cells=[" + i.cells.map((c) => (c.own ? "own" : "up") + i.index).join(",") + "]";
    case "array": return r(i.dst) + " = [" + i.elems.map(r).join(", ") + "]";
    case "object":
      return r(i.dst) + " = {" + i.pairs.map((p) => r(p.key) + ": " + r(p.value)).join(", ") + "}";
    case "pushtry":
      return i.catchPc !== undefined
        ? "try catch@" + i.catchPc + " reg=" + i.catchReg
        : "try finally@" + i.finallyPc;
    case "poptry": return "endtry";
    case "forin_init": return "forin init";
    case "forin_next": return "forin next " + r(i.iter) + " -> " + r(i.dst) + " else jmp " + i.target;
    case "defineprop": return "defineProperty";
    case "decrypt": return "decrypt " + i.src + ".." + i.end + " -> " + i.dst;
    case "mathcall": return r(i.dst) + " = Math." + i.fn + "(" + r(i.a) + ", " + r(i.b) + ")";
    case "debugger": return "debugger";
    case "??": return "?? op=" + i.op;
  }
  return i.kind;
}
