#!/usr/bin/env node
/**
 * test.js — checks that vm.js
 *
 *   1. deobfuscates input.js into readable, dispatcher-free source,
 *   2. produces a program that behaves *exactly* like the obfuscated one,
 *   3. recovers the concealed strings,
 *   4. passes ordinary, non-obfuscated files straight through.
 *
 *      $ node test.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vmMod = require("./vm.js");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;

const here = (f) => path.join(__dirname, f);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true || r === undefined;
    if (!ok) detail = String(r);
  } catch (e) {
    detail = e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : String(e);
  }
  if (ok) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    failures.push(name + "\n       " + detail.replace(/\n/g, "\n       "));
    console.log("  FAIL " + name);
  }
}

/* ------------------------------------------------------------------ *
 * a tiny deterministic browser-ish sandbox so both programs can run   *
 * ------------------------------------------------------------------ */

function runProgram(code, filename, env) {
  env = env || {};
  const vm = require("vm");
  const trace = [];
  const noop = () => {};
  const show = (v) => {
    try {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") return Object.prototype.toString.call(v);
      return String(v);
    } catch (e) {
      return "?";
    }
  };
  const el = () => ({
    style: {},
    // the sample measures a laid-out element; the test drives this value
    offsetWidth: env.width === undefined ? 140 : env.width,
    offsetHeight: 0,
    children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: (k, v) => trace.push("setAttribute " + k + "=" + show(v)),
    getAttribute: () => null,
    appendChild: (c) => (trace.push("appendChild"), c),
    removeChild: noop,
    addEventListener: (t) => trace.push("addEventListener " + t),
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => null,
    set innerHTML(v) {
      trace.push("innerHTML=" + show(v));
    },
    get innerHTML() {
      return "";
    },
    set textContent(v) {
      trace.push("textContent=" + show(v));
    },
    get textContent() {
      return "";
    },
  });
  const FROZEN = env.now === undefined ? 1700000000000 : env.now;
  const RANDOM = env.random === undefined ? 0.4242424242 : env.random;
  const sandbox = {
    console: new Proxy(
      {},
      {
        get: (_, k) => (...a) => trace.push("console." + String(k) + " " + a.map(show).join(" ")),
      }
    ),
    document: {
      body: el(),
      head: el(),
      documentElement: el(),
      createElement: (t) => (trace.push("createElement " + t), el()),
      createTextNode: el,
      getElementById: () => el(),
      querySelector: () => el(),
      querySelectorAll: () => [],
      addEventListener: noop,
      write: (s) => trace.push("write " + show(s)),
      cookie: "",
      title: "",
    },
    navigator: { userAgent: "node", language: "en" },
    location: { href: "about:blank", protocol: "about:", host: "", search: "", hash: "" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    performance: { now: () => 0 },
    setTimeout: noop,
    setInterval: noop,
    clearTimeout: noop,
    clearInterval: noop,
    requestAnimationFrame: noop,
    alert: (m) => trace.push("alert " + show(m)),
    prompt: () => null,
    confirm: () => false,
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    JSON,
    Date: new Proxy(Date, {
      apply: () => new Date(FROZEN).toString(),
      construct: (T, a) => (a.length ? new T(...a) : new T(FROZEN)),
      get: (T, k) => (k === "now" ? () => FROZEN : T[k]),
    }),
    Math: Object.assign(Object.create(Math), { random: () => RANDOM }),
    process: { platform: "test", version: "v0", env: {}, argv: [] },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  let error = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename, timeout: 60000 });
  } catch (e) {
    error = String((e && e.message) || e);
  }
  return { trace: trace.join("\n"), error };
}

/* ------------------------------------------------------------------ *
 * tests                                                               *
 * ------------------------------------------------------------------ */

console.log("vm.js — deobfuscator tests\n");

const inputSrc = fs.readFileSync(here("input.js"), "utf8");
const outFile = here("output.js");

console.log("input.js (obfuscated sample)");

let out = null;
check("vm.js('input.js', 'output.js') runs and writes output.js", () => {
  out = vmMod(here("input.js"), outFile);
  return typeof out === "string" && out.length > 0 && fs.existsSync(outFile);
});

check("output is valid JavaScript", () => {
  parser.parse(out, { sourceType: "unambiguous" });
});

check("output is much smaller than the obfuscated input", () =>
  out.length < inputSrc.length * 0.6 || "output " + out.length + " vs input " + inputSrc.length
);

check("no state-array dispatchers survive", () => {
  const ast = parser.parse(out, { sourceType: "unambiguous" });
  let found = 0;
  traverse(ast, {
    WhileStatement(p) {
      const body = p.node.body;
      if (
        body.type === "BlockStatement" &&
        body.body.length === 1 &&
        body.body[0].type === "SwitchStatement" &&
        p.node.test.type === "BinaryExpression" &&
        p.node.test.left.type === "CallExpression"
      )
        found++;
    },
  });
  return found === 0 || found + " dispatcher(s) left";
});

check("no references to the obfuscator's helper functions remain", () => {
  const ast = parser.parse(out, { sourceType: "unambiguous" });
  const leftovers = new Set();
  traverse(ast, {
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      if (p.scope.hasBinding(p.node.name)) return;
      if (/^(bb|bc|bd|be|bf|bg|bh)$/.test(p.node.name)) leftovers.add(p.node.name);
    },
  });
  return leftovers.size === 0 || "unbound: " + [...leftovers].join(", ");
});

check("every identifier the output uses is bound or a real global", () => {
  const ast = parser.parse(out, { sourceType: "unambiguous" });
  const globals = new Set([
    "document", "console", "Math", "Date", "String", "Object", "Array", "JSON",
    "undefined", "NaN", "Infinity", "globalThis", "window", "Reflect", "Number",
    "Boolean", "Error", "TypeError", "ReferenceError", "Symbol", "Promise",
  ]);
  const bad = new Set();
  traverse(ast, {
    Identifier(p) {
      if (!p.isReferencedIdentifier()) return;
      if (p.scope.hasBinding(p.node.name) || globals.has(p.node.name)) return;
      bad.add(p.node.name);
    },
  });
  return bad.size === 0 || "unbound: " + [...bad].join(", ");
});

check("the virtual machine is gone: no bytecode, no opcode table", () => {
  const ast = parser.parse(out, { sourceType: "unambiguous" });
  let big = 0;
  let numericProps = 0;
  traverse(ast, {
    StringLiteral(p) {
      if (p.node.value.length > 200) big++;
    },
    MemberExpression(p) {
      if (p.node.computed && p.node.property.type === "NumericLiteral" && p.node.property.value > 1000)
        numericProps++;
    },
  });
  if (big) return big + " large blob(s) left";
  if (numericProps) return numericProps + " opcode-table style write(s) left";
  return true;
});

check("the original program's own strings are back", () => {
  const ast = parser.parse(out, { sourceType: "unambiguous" });
  const strings = new Set();
  traverse(ast, {
    StringLiteral(p) {
      strings.add(p.node.value);
    },
  });
  const expected = ["div", "calc(100px + 20px * 2)", "|"];
  const missing = expected.filter((s) => !strings.has(s));
  return missing.length === 0 || "not recovered: " + missing.join(", ");
});

check("the recovered source is a few hundred bytes, not a VM", () =>
  out.length < 4000 || "output is " + out.length + " bytes"
);

check("deobfuscated program behaves exactly like the obfuscated one", () => {
  const a = runProgram(inputSrc, "input.js");
  const b = runProgram(out, "output.js");
  if (a.error !== b.error) return "errors differ: " + a.error + " vs " + b.error;
  if (a.trace !== b.trace)
    return (
      "traces differ:\n         obfuscated: " +
      a.trace.slice(0, 200) +
      "\n         recovered : " +
      b.trace.slice(0, 200)
    );
  if (!a.trace) return "no observable behaviour was captured";
  return true;
});

/* ------------------------------------------------------------------ *
 * ground truth: original.js was provided only after the fact           *
 * ------------------------------------------------------------------ */

const originalFile = here("original.js");
if (fs.existsSync(originalFile)) {
  console.log("\noriginal.js (ground truth)");
  const originalSrc = fs.readFileSync(originalFile, "utf8");

  check("original.js runs in the harness", () => {
    const r = runProgram(originalSrc, "original.js");
    return (!r.error && r.trace.length > 0) || "error: " + r.error;
  });

  // The only inputs the program has are the clock, the RNG and the measured
  // width.  Sweeping them turns "same output once" into a real equivalence
  // check: 32-bit overflow, negative `%`, string coercion all get exercised.
  const cases = [];
  for (const now of [0, 1, 1700000000000, 2147483647, 4294967296, 1e15])
    for (const random of [0, 0.4242424242, 0.999999, 0.5])
      for (const width of [0, 1, 140, 65535, 2147483647])
        cases.push({ now, random, width });

  check("recovered program matches original.js on " + cases.length + " input combinations", () => {
    for (const env of cases) {
      const a = runProgram(originalSrc, "original.js", env);
      const b = runProgram(out, "output.js", env);
      if (a.error || b.error)
        return "error at " + JSON.stringify(env) + ": " + a.error + " / " + b.error;
      if (a.trace !== b.trace)
        return (
          "differs at " + JSON.stringify(env) +
          "\n         original : " + a.trace.replace(/\n/g, " | ").slice(0, 160) +
          "\n         recovered: " + b.trace.replace(/\n/g, " | ").slice(0, 160)
        );
    }
    return true;
  });

  check("obfuscated input.js matches original.js too (the sample is faithful)", () => {
    for (const env of cases.slice(0, 12)) {
      const a = runProgram(originalSrc, "original.js", env);
      const b = runProgram(inputSrc, "input.js", env);
      if (a.trace !== b.trace) return "differs at " + JSON.stringify(env);
    }
    return true;
  });

  check("every construct of the original survives in the recovery", () => {
    const ast = parser.parse(out, { sourceType: "unambiguous" });
    const src = generate(ast, { compact: true }).code;
    const needed = [
      'createElement("div")',
      "style.width",
      "appendChild",
      "offsetWidth",
      "Date.now()",
      "Math.floor(Math.random()*1000000)",
      "%97",
      "%89",
      "%83",
      "charCodeAt",
      "String.fromCharCode",
      ">>>13",
      "&65535",
      "console.log",
    ];
    const missing = needed.filter((n) => !src.includes(n));
    return missing.length === 0 || "missing: " + missing.join(", ");
  });
}

console.log("\ninput.js with --keep-vm (flattening removed, VM left in place)");

let vmLevel = null;
check("the intermediate stage is produced", () => {
  const r = vmMod.deobfuscateSource(inputSrc, { devirtualize: false });
  vmLevel = r.code;
  return r.changed && vmLevel.length > 20000;
});

check("no state-array dispatchers survive there either", () => {
  const ast = parser.parse(vmLevel, { sourceType: "unambiguous" });
  let found = 0;
  traverse(ast, {
    WhileStatement(p) {
      const body = p.node.body;
      if (
        body.type === "BlockStatement" &&
        body.body.length === 1 &&
        body.body[0].type === "SwitchStatement" &&
        p.node.test.type === "BinaryExpression" &&
        p.node.test.left.type === "CallExpression"
      )
        found++;
    },
  });
  return found === 0 || found + " dispatcher(s) left";
});

check("the concealed strings are decoded there", () => {
  const ast = parser.parse(vmLevel, { sourceType: "unambiguous" });
  const strings = new Set();
  traverse(ast, {
    StringLiteral(p) {
      strings.add(p.node.value);
    },
  });
  const expected = ["base64", "undefined", "string", "number", "return this"];
  const missing = expected.filter((s) => !strings.has(s));
  return missing.length === 0 || "not decoded: " + missing.join(", ");
});

check("every specialised function it emits is defined", () => {
  const ast = parser.parse(vmLevel, { sourceType: "unambiguous" });
  const defined = new Set();
  const used = new Set();
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node.id && /^fn\d+$/.test(p.node.id.name)) defined.add(p.node.id.name);
    },
    Identifier(p) {
      if (/^fn\d+$/.test(p.node.name) && p.isReferencedIdentifier()) used.add(p.node.name);
    },
  });
  const missing = [...used].filter((n) => !defined.has(n));
  return missing.length === 0 || "missing: " + missing.join(", ");
});

check("it behaves like the obfuscated original too", () => {
  const a = runProgram(inputSrc, "input.js");
  const b = runProgram(vmLevel, "vm-level.js");
  return a.trace === b.trace || "traces differ";
});

console.log("\ndebug/sample.js (a second, independently generated sample)");

// proves the solution matches the *technique*, not this one file
check("the generator produces a sample", () => {
  require("./debug/make-sample.js");
  return fs.existsSync(here("debug/sample.js"));
});

let sampleSrc = null;
let sampleOut = null;

check("the generated sample is recognised and recovered", () => {
  sampleSrc = fs.readFileSync(here("debug/sample.js"), "utf8");
  const r = vmMod.deobfuscateSource(sampleSrc, {});
  sampleOut = r.code;
  if (!r.changed) return "not recognised";
  if (r.stats.dispatchersLeft) return r.stats.dispatchersLeft + " dispatcher(s) left";
  return r.stats.functions >= 2 || "only " + r.stats.functions + " function(s)";
});

check("its loop and branches come back as real control flow", () => {
  const ast = parser.parse(sampleOut, { sourceType: "unambiguous" });
  let loops = 0;
  let ifs = 0;
  traverse(ast, {
    WhileStatement() {
      loops++;
    },
    IfStatement() {
      ifs++;
    },
  });
  return (loops >= 1 && ifs >= 3) || "loops=" + loops + " ifs=" + ifs;
});

check("nothing that only exists at runtime got constant folded", () => {
  // `out.join(",")` takes a literal argument but is *not* a string decoder
  return /out\.join\(","\)/.test(sampleOut) || "a stateful call was folded away";
});

check("the recovered sample behaves identically", () => {
  const a = runProgram(sampleSrc, "sample.js");
  const b = runProgram(sampleOut, "sample-out.js");
  if (a.error || b.error) return "error: " + a.error + " / " + b.error;
  return a.trace === b.trace || "traces differ:\n" + a.trace + "\n---\n" + b.trace;
});

console.log("\nregular.js (ordinary source)");

const regularSrc = fs.readFileSync(here("regular.js"), "utf8");
let regularOut = null;

check("vm.js('regular.js') returns without throwing", () => {
  regularOut = vmMod(here("regular.js"));
  return typeof regularOut === "string" && regularOut.length > 0;
});

check("regular source is passed through untouched", () =>
  regularOut === regularSrc || "output differs from the input"
);

check("regular program still behaves the same", () => {
  const a = runProgram(regularSrc, "regular.js");
  const b = runProgram(regularOut, "regular-out.js");
  if (a.error) return "reference run failed: " + a.error;
  return a.trace === b.trace || "traces differ";
});

console.log("\nedge cases");

const edge = {
  empty: "",
  "only a comment": "// nothing here\n",
  "modern syntax": "const f=async(x=1,...r)=>{for await (const v of x){}};class A{#p=1;static s=2;get v(){return this.#p??0}}",
  "regex and template": "const r=/a\\/b[/]/g; const t=`x${1+2}y`; console.log(r.source,t);",
  "a lone while/switch that is not a dispatcher": "let i=0;while(i<3){switch(i){case 0:i=1;break;default:i++;}}",
  "shadowed globals": "function f(){var Math=1;return Math;} f();",
};
for (const [name, src] of Object.entries(edge)) {
  check("passes through: " + name, () => {
    const r = vmMod.deobfuscateSource(src, {});
    if (r.changed) return "unexpectedly transformed";
    return r.code === src || "output differs";
  });
}

check("a truncated/broken obfuscated file does not crash vm.js", () => {
  const half = inputSrc.slice(0, Math.floor(inputSrc.length / 2)) + "\n";
  const r = vmMod.deobfuscateSource(half, {});
  return typeof r.code === "string";
});

/* ------------------------------------------------------------------ */

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
