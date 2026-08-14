// mbaFitCheck — the attacker's own test, run at build time
// ───────────────────────────────────────────────────────────────────────────
// Everything the MBA layer does is probabilistic.  Handlers are drawn, not
// written: a rule is picked at random, a null vector lands somewhere or does
// not, a domain is claimed by one pass and consumed by another.  That makes two
// kinds of silent failure possible, and this file exists to make both loud.
//
// ── 1. Silent miscompiles ────────────────────────────────────────────────────
// A domain-restricted term is only sound because the values reaching it really
// are inside the declared set.  If a claim is wrong — a mask that is not 0/-1, a
// state word outside its residue class, a taint operand that some identity rule
// turns into NaN — the vector fires during a REAL execution and the handler
// returns the wrong answer.  The program then fails in a way that looks like
// anything but an obfuscator bug, on some seeds and not others.
//
// So every handler is evaluated here, against in-domain inputs, and compared
// with the operator it is supposed to implement.  (One such bug was found by
// exactly this check while it was being written: an identity of the form
// `(x + t) - t` is exact for every int32 `t` and NaN for `undefined`, which is
// what a taint register holds in a function with nothing opaque in it.)
//
// ── 2. Silent no-ops ─────────────────────────────────────────────────────────
// The other failure is a handler that is perfectly correct and buys nothing.
// A black-box devirtualizer does not simplify MBA — it samples the handler over
// its operands and matches the results against a table of JavaScript operators.
// Depth, node count and non-linearity are all invisible to that attack. The
// only thing that defeats it is the handler not being extensionally equal to
// any operator on the values the attacker probes with.
//
// That is a property this file can measure directly, by running the same attack:
// the same probe grid, the same candidate table, the same "which operator
// reproduces every observation" question. A handler carrying a domain that
// fires on integer probes is REQUIRED to match nothing; the rest are reported,
// so the fraction of the table that is still trivially identifiable is a number
// the build prints rather than a thing nobody knows.
//
// The measurement that motivated this: in an analysed build, 175 null vectors
// were emitted over an `int32` domain and every one of them was worthless,
// because it could only fire on non-integer probes — which a classifier
// discards. Nothing in the build said so.

import { Compiler } from "../compiler.ts";
import {
  applySelector,
  domainFires,
  evalMBA,
  findSelectorOperand,
  frameKeyValue,
  RAW_PREFIX,
  type MBADomain,
  type MBAExpr,
} from "./mba-utils.ts";
import { getRandomInt } from "./random-utils.ts";

type MBAOp = Compiler["MBA_OPS"][number];

// The probe values a black-box classifier reaches for: small integers, powers
// of two, and the int32 boundaries.  Deliberately the same shape as the ones
// observed in a real devirtualizer, because the question being asked is
// literally theirs.
const INT_PROBES = [0, 1, 2, 3, 7, 255, 65535, -1, -7, 0x7fffffff, -0x80000000];
// Squared for two-source handlers, so this one is shorter.
const PAIR_PROBES = [0, 1, 2, 7, 255, -1, -65536, 0x7fffffff];

const UNARY_CANDIDATES: [string, (a: any) => any][] = [
  ["id", (a) => a],
  ["-", (a) => -a],
  ["+", (a) => +a],
  ["~", (a) => ~a],
  ["!", (a) => !a],
  ["!!", (a) => !!a],
  ["|0", (a) => a | 0],
  [">>>0", (a) => a >>> 0],
  ["-|0", (a) => -a | 0],
  ["~|0", (a) => ~a | 0],
];

const BINARY_CANDIDATES: [string, (a: any, b: any) => any][] = [
  ["===", (a, b) => a === b],
  ["!==", (a, b) => a !== b],
  ["<", (a, b) => a < b],
  ["<=", (a, b) => a <= b],
  [">", (a, b) => a > b],
  [">=", (a, b) => a >= b],
  ["+", (a, b) => a + b],
  ["-", (a, b) => a - b],
  ["*", (a, b) => a * b],
  ["/", (a, b) => a / b],
  ["%", (a, b) => a % b],
  ["&", (a, b) => a & b],
  ["|", (a, b) => a | b],
  ["^", (a, b) => a ^ b],
  ["<<", (a, b) => a << b],
  [">>", (a, b) => a >> b],
  [">>>", (a, b) => a >>> b],
  ["==", (a, b) => a == b],
  ["!=", (a, b) => a != b],
  ["+|0", (a, b) => (a + b) | 0],
  ["-|0", (a, b) => (a - b) | 0],
  ["*|0", (a, b) => Math.imul(a, b)],
];

/** The semantics an MBA handler may claim, by the OP_SPECS name it was built from. */
const REFERENCE: Record<string, (a: any, b: any) => any> = {
  BAND: (a, b) => a & b,
  BOR: (a, b) => a | b,
  BXOR: (a, b) => a ^ b,
  UNARY_BITNOT: (a) => ~a,
  ADD: (a, b) => (a + b) | 0,
  SUB: (a, b) => (a - b) | 0,
  UNARY_NEG: (a) => -a | 0,
  LT: (a, b) => a < b,
  GT: (a, b) => a > b,
  LTE: (a, b) => a <= b,
  GTE: (a, b) => a >= b,
  EQ: (a, b) => a === b,
  NEQ: (a, b) => a !== b,
};

const same = (a: any, b: any) =>
  a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));

/** A value inside `domain` — what a real execution would put in this operand. */
function inDomainValue(domain: MBADomain | undefined, fallback: number): number {
  if (!domain) return fallback;
  if (domain.bool) return fallback & 1;
  if (domain.mask) return -(fallback & 1);
  if (domain.modTag) {
    const mask = (1 << domain.modTag.bits) - 1;
    return ((fallback & ~mask) | (domain.modTag.tag & mask)) | 0;
  }
  return fallback | 0;
}

export interface FitCheckReport {
  /** Handlers examined. */
  total: number;
  /** Handlers a single JavaScript operator reproduced over the whole grid. */
  fitted: { name: string; operator: string }[];
  /** Handlers no candidate matched — the ones that cost an attacker real work. */
  unfittable: number;
  /** Handlers with too many sources for the classifier to attempt at all. */
  skipped: number;
  /** Correctness failures.  Any entry here is a miscompile waiting to happen. */
  violations: string[];
}

export function mbaFitCheck(compiler: Compiler): FitCheckReport {
  const report: FitCheckReport = {
    total: 0,
    fitted: [],
    unfittable: 0,
    skipped: 0,
    violations: [],
  };

  for (const [opStr, def] of Object.entries(compiler.MBA_OPS)) {
    const name = compiler.OP_NAME[Number(opStr)] ?? `MBA_${opStr}`;
    report.total++;
    checkHandler(compiler, def, name, report);
  }

  return report;
}

function checkHandler(
  compiler: Compiler,
  def: MBAOp,
  name: string,
  report: FitCheckReport,
): void {
  const srcNames = def.srcNames ?? (def.arity === 3 ? ["a", "b"] : ["a"]);
  const srcKinds = def.srcKinds ?? srcNames.map(() => "reg" as const);
  const taints = new Set(def.taintNames ?? []);
  const domains = def.domains ?? {};

  // Sources an attacker would treat as the handler's inputs: the real ones.
  // A taint source is an input in name only, which is the point of it.
  const inputs = srcNames.filter((n) => !taints.has(n));

  // Evaluate the handler the way the emitted case does: bindings in order, then
  // the result expression, with `v` / `c` / `k` / `s` resolved as mbaOpcodes
  // resolves them.
  const run = (
    values: Record<string, number>,
    selectorBit: 0 | 1 | null,
  ): { value: any; error?: string } => {
    const env = new Map<string, unknown>();
    for (const n of srcNames) {
      const v = values[n] ?? 0;
      env.set(n, v);
      // The raw alias is the value before the tier-0 coercion. Every probe here
      // is already an int32, so the two agree — which is exactly why an int32
      // null vector cannot fire on this grid, and exactly why it is worth so
      // little against a classifier that probes the same way.
      env.set(RAW_PREFIX + n, v);
    }

    if (def.frame) {
      const salt = compiler.fnDescriptors[def.fnId ?? -1]?.salt ?? 0;
      env.set("v", frameKeyValue(def.frame, values.__salt ?? salt));
      env.set("c", def.frame.inverse);
    }

    if (def.select && selectorBit !== null) {
      const k = findSelectorOperand(def.select.key, selectorBit);
      env.set("k", k | 0);
      env.set("s", applySelector(k, def.select.key));
    }

    try {
      for (const [bound, expr] of def.bindings ?? [])
        env.set(bound, evalMBA(expr as MBAExpr, env));
      return { value: evalMBA(def.expr as MBAExpr, env) };
    } catch (error) {
      return { value: undefined, error: (error as Error).message };
    }
  };

  // In-domain assignment for every source: what a real execution supplies.
  const realValues = (seed: number): Record<string, number> => {
    const values: Record<string, number> = {};
    srcNames.forEach((n, i) => {
      // An immediate is a word out of the bytecode stream, so it is whatever
      // the emitting pass put there; a register holds whatever it holds. Both
      // are constrained only by the declared domain.
      values[n] = inDomainValue(domains[n], seed * (i + 7) + i);
    });
    for (const n of taints) values[n] = 0;
    return values;
  };

  // ── 1. Taint invariance ────────────────────────────────────────────────────
  // The handler must compute the same value for EVERY value of a taint operand.
  // A failure here is a miscompile: the register holds whatever it holds, and
  // nothing constrains it.
  for (const t of taints) {
    for (let seed = 1; seed <= 3; seed++) {
      const base = realValues(seed);
      const expected = run({ ...base }, def.select ? 0 : null);
      for (const value of [0, 1, -1, 12345, 0x7fffffff, -0x80000000]) {
        const got = run({ ...base, [t]: value }, def.select ? 0 : null);
        if (!same(got.value, expected.value)) {
          report.violations.push(
            `${name}: value depends on taint operand "${t}" ` +
              `(${expected.value} vs ${got.value} at ${t}=${value})`,
          );
          seed = 99;
          break;
        }
      }
    }
  }

  // ── 2. The declared semantics ──────────────────────────────────────────────
  // Only handlers that claim one: a superoperator or a state transition is a
  // fused composite with no single operator behind it.
  const semantics = def.semantics;
  if (semantics && inputs.length >= 1 && inputs.length <= 2) {
    semantics.forEach((opName, bit) => {
      const ref = REFERENCE[opName];
      if (!ref) return;
      for (let seed = 1; seed <= 12; seed++) {
        const values = realValues(seed);
        const got = run(values, def.select ? ((bit % 2) as 0 | 1) : null);
        const want = ref(values[inputs[0]], values[inputs[1]]);
        if (!same(got.value, want)) {
          report.violations.push(
            `${name}: does not compute ${opName} on in-domain inputs ` +
              `(${inputs.map((n) => `${n}=${values[n]}`).join(", ")} → ` +
              `${got.error ?? got.value}, expected ${want})`,
          );
          break;
        }
      }
    });
  }

  // ── 3. The classifier ──────────────────────────────────────────────────────
  // Now play the attacker: probe the handler over the grid and see whether any
  // single operator reproduces every observation. Immediates stay at a
  // plausible real value, exactly as a fitter reading them off the instruction
  // would have them.
  if (inputs.length === 0 || inputs.length > 2) {
    report.skipped++;
    return;
  }

  const fixed = realValues(5);
  const regInputs = inputs.filter(
    (n) => srcKinds[srcNames.indexOf(n)] === "reg",
  );
  if (regInputs.length === 0 || regInputs.length > 2) {
    report.skipped++;
    return;
  }

  const observations: { in: number[]; out: any }[] = [];
  if (regInputs.length === 1) {
    for (const x of INT_PROBES) {
      const values = { ...fixed, [regInputs[0]]: x };
      observations.push({ in: [x], out: run(values, def.select ? 0 : null).value });
    }
  } else {
    for (const x of PAIR_PROBES)
      for (const y of PAIR_PROBES) {
        const values = { ...fixed, [regInputs[0]]: x, [regInputs[1]]: y };
        observations.push({
          in: [x, y],
          out: run(values, def.select ? 0 : null).value,
        });
      }
  }

  const survivors: string[] = [];
  if (regInputs.length === 1) {
    for (const [op, fn] of UNARY_CANDIDATES)
      if (observations.every((o) => same(o.out, tryCall(() => fn(o.in[0])))))
        survivors.push(op);
  } else {
    for (const [op, fn] of BINARY_CANDIDATES) {
      if (observations.every((o) => same(o.out, tryCall(() => fn(o.in[0], o.in[1])))))
        survivors.push(op);
      else if (
        observations.every((o) => same(o.out, tryCall(() => fn(o.in[1], o.in[0]))))
      )
        survivors.push(`${op} (swapped)`);
    }
  }

  if (survivors.length === 0) {
    report.unfittable++;
    return;
  }

  report.fitted.push({ name, operator: survivors[0] });

  // A handler whose expansion was allowed to assume a domain that FIRES on
  // integer probes has no business matching an operator on those same probes:
  // if it does, the vector either was not drawn or was cancelled, and the
  // budget spent claiming the domain bought nothing.
  const firing = Object.entries(domains).filter(
    ([n, d]) => srcNames.includes(n) && domainFires(d),
  );
  if (firing.length > 0) {
    report.violations.push(
      `${name}: matches \`${survivors[0]}\` on the probe grid despite ` +
        `firing domains on ${firing.map(([n]) => n).join(", ")} — ` +
        `the domain-restricted term is missing or cancels`,
    );
  }
}

function tryCall(fn: () => any): any {
  try {
    return fn();
  } catch {
    return Symbol.for("mba-fit-check.error");
  }
}

/**
 * Run the check and report it through the compiler's log, throwing on anything
 * that would produce a wrong program.
 *
 * The split is deliberate.  A handler that turns out to be identifiable is a
 * missed opportunity and is reported as a count; a handler that computes the
 * wrong value, or that depends on an operand it promised not to depend on, is a
 * bug that would ship — those stop the build.
 */
export function runMBAFitCheck(compiler: Compiler): void {
  if (Object.keys(compiler.MBA_OPS).length === 0) return;

  const started = Date.now();
  const report = mbaFitCheck(compiler);

  const fitted = report.fitted.length;
  compiler.log(
    `mbaFitCheck: ${report.total} handlers — ${report.unfittable} match no ` +
      `operator, ${fitted} identifiable, ${report.skipped} beyond a ` +
      `two-operand classifier (${Date.now() - started}ms)`,
  );
  if (fitted > 0 && compiler.options.verbose) {
    for (const f of report.fitted.slice(0, 12))
      compiler.log(`  identifiable: ${f.name} = ${f.operator}`);
  }

  if (report.violations.length > 0) {
    throw new Error(
      `mbaFitCheck found ${report.violations.length} broken handler(s):\n` +
        report.violations.map((v) => `  • ${v}`).join("\n"),
    );
  }
}
