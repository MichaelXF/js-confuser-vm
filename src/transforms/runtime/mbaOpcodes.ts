import * as t from "@babel/types";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";
import { getSwitchStatement, parseStatement } from "../../utils/ast-utils.ts";
import {
  RAW_PREFIX,
  mVar,
  mbaToAST,
  mbaVarNames,
  selectorWordSource,
} from "../../utils/mba-utils.ts";
import { chance, choice, getRandomInt } from "../../utils/random-utils.ts";

// A local name for a generated handler.  The `_` prefix is what keeps these
// clear of everything the run loop and handlerTable's buildInjectedVars care
// about (`regs`, `base`, `fp`, `op`, `pc`, …); collisions between two handlers
// are harmless, since these are `var`s that every case assigns before reading.
const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz".split("");
function localName(taken: Set<string>): string {
  for (;;) {
    let name = "_";
    for (let i = 0; i < 4; i++) name += choice(NAME_CHARS);
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

// Exact ToInt32 coercions.  All five are equivalent; the point of drawing one
// at random is that `a = ~~a; b = ~~b;` — emitted verbatim by every tier-0
// handler — is a two-line regex that identifies an MBA handler on sight,
// before anything about its body has been looked at.
const TRUNC_FORMS = ["~~$", "($ | 0)", "($ ^ 0)", "($ & -1)", "($ >> 0)"];
const trunc = (expr: string) => choice(TRUNC_FORMS).replace("$", expr);

// Splice `extra` into `host` at random positions, keeping `extra`'s own order.
// Each insertion point is at or after the previous one, so relative order
// survives while absolute position does not.
function scatter(host: t.Statement[], extra: t.Statement[]): void {
  let lo = 0;
  for (const stmt of extra) {
    const at = getRandomInt(lo, host.length);
    host.splice(at, 0, stmt);
    lo = at + 1;
  }
}

// mbaOpcodes (runtime side)
// ───────────────────────────────────────────────────────────────────────────
// Emits a switch case for every entry the mbaExpand bytecode pass registered in
// compiler.MBA_OPS.  Each case reads the operands the original opcode did and
// computes the result through that entry's synthesized MBA expression:
//
//   case <MBA_ADD_1>: {
//     var dst = this._operand();
//     var a = regs[base + this._operand()];
//     var b = regs[base + this._operand()];
//     regs[base + dst] = ((((a ^ b) | 0) + ((a & b) * 2)) | 0);
//     break;
//   }
//
// Tier 0 entries (`& | ^`, `~`) additionally coerce their operands to int32
// first, because JavaScript lets those operators take any value and the
// identity is only exact once the inputs are genuinely int32.
//
// Two entry kinds carry extra statements, and BOTH are deliberately emitted
// with their position randomized rather than as a fixed prologue:
//
//   FRAME-BOUND (def.fnId non-null) — binds the handler to one function's
//     register count, so it computes garbage in any other frame and cannot be
//     lifted out and probed with fabricated state.
//
//   MERGED (def.select present) — reads one extra key operand and derives a
//     selector bit from it, choosing which of two semantics runs.  This is the
//     one that costs a black-box classifier its whole method: the handler is
//     equal to no single operator, so sampling it over (a, b) identifies
//     nothing.  See mba-utils' "Key-selected semantics".
//
// Unlike specialized / macro / aliased opcodes this does NOT clone an existing
// case body — the whole point is that the body no longer resembles the operator
// it implements, so there is nothing to clone from.
//
// Must run BEFORE applyShuffleOpcodes so the generated cases get shuffled in
// with the rest, and before applyHandlerTable so they get lifted like any other
// handler (its buildInjectedVars scans for `regs` / `base`, which these use).
export function applyMBAOpcodes(ast: t.File, compiler: Compiler): void {
  const entries = Object.entries(compiler.MBA_OPS);
  if (entries.length === 0) return;

  const switchStatement = getSwitchStatement(ast);
  ok(switchStatement, "Could not find @SWITCH statement for MBA opcodes");

  for (const [opStr, def] of entries) {
    const opcode = Number(opStr);
    // Source operands, positionally.  A plain single- or two-operand handler
    // names them `a` / `b`; a SUPEROPERATOR names one per leaf of the fused
    // chain (see mbaSuperOps) and may read three to five.
    const srcNames = def.srcNames ?? (def.arity === 3 ? ["a", "b"] : ["a"]);
    const srcKinds = def.srcKinds ?? srcNames.map(() => "reg" as const);
    const taken = new Set(["dst", "regs", "base", "fp", ...srcNames]);

    // Statements that consume the bytecode stream.  Their ORDER is the
    // instruction's operand order and must not change; everything scattered
    // below is free of `_operand()` calls, so inserting it anywhere is safe.
    const body: t.Statement[] = [
      parseStatement("var dst = this._operand();"),
    ];

    // How the MBA expression's variables resolve at this use site: either to a
    // local this body declares, or straight to a baked literal.
    const varNames: Record<string, string> = {};
    const literals: Record<string, number> = {};

    // Sources whose RAW value the expression asks for — i.e. the value as it
    // came out of the register, before the tier-0 `~~`.  Only a domain null
    // vector wants this, and it wants it for a precise reason: the coercion is
    // what erases the fractional part it tests for, so reading the coerced
    // local would make the vector a constant zero.  See mba-utils'
    // "Domain-restricted identities".
    // Scanned across the bindings too, not just the result — a null vector is
    // just as likely to land inside one of them.
    const allVars = [
      ...mbaVarNames(def.expr),
      ...(def.bindings ?? []).flatMap(([, e]) => mbaVarNames(e)),
    ];
    const wantsRaw = new Set(
      allVars
        .filter((v) => v.startsWith(RAW_PREFIX))
        .map((v) => v.slice(RAW_PREFIX.length)),
    );

    // Tier 0 needs its operands coerced to int32.  Half the time that rides
    // along with the read, half the time it is a statement of its own — so
    // neither shape is the shape an MBA handler has.
    const foldNormalize = def.normalize && chance(50);
    const deferred: string[] = [];

    // A taint source is coerced no matter what the handler's tier is.
    //
    // Its register holds an arbitrary JS value — that is the entire point, and
    // for a function with nothing opaque in it the value is `undefined`. The
    // identity rules that consume it are exact over Z/2^32, but not all of them
    // reach that domain through a bitwise operator: `(x + t) - t` is an
    // identity for every int32 t and NaN for `undefined`. Coercing at the read
    // makes the operand int32 before any rule sees it, which is the precondition
    // the whole algebra is stated over.
    const taint = new Set(def.taintNames ?? []);

    const read = (name: string, kind: "reg" | "imm") => {
      // An immediate is a u32 straight out of the bytecode stream, while every
      // int32 operator in the expression works on SIGNED values — so a constant
      // with bit 31 set would arrive 2^32 too high.  The coercion is exact for
      // the small immediates too, and applying it unconditionally keeps
      // handlers from splitting into two populations told apart by whether
      // they coerce.
      if (kind === "imm") {
        body.push(parseStatement(`var ${name} = ${trunc("this._operand()")};`));
        return;
      }

      const source = "regs[base + this._operand()]";

      if (taint.has(name)) {
        body.push(parseStatement(`var ${name} = ${trunc(source)};`));
        return;
      }

      if (def.normalize && wantsRaw.has(name)) {
        // The operand can only be consumed once, so the raw value is captured
        // first and the coerced one derived from it.
        const rawLocal = localName(taken);
        varNames[RAW_PREFIX + name] = rawLocal;
        body.push(parseStatement(`var ${rawLocal} = ${source};`));
        body.push(parseStatement(`var ${name} = ${trunc(rawLocal)};`));
        return;
      }

      // With no coercion to apply, the raw value and the value ARE the same
      // local, so the alias costs nothing.
      if (wantsRaw.has(name)) varNames[RAW_PREFIX + name] = name;

      body.push(
        parseStatement(
          `var ${name} = ${foldNormalize ? trunc(source) : source};`,
        ),
      );
      if (def.normalize && !foldNormalize) deferred.push(name);
    };

    srcNames.forEach((name, i) => read(name, srcKinds[i]));

    for (const name of deferred)
      body.push(parseStatement(`${name} = ${trunc(name)};`));

    // ── Frame state: the decoded salt, and the binding derived from it ───────
    //
    // The SALT slot does not hold the executing function's identity word — it
    // holds E(salt) under the build's salt encoding.  E^-1 is inlined here, and
    // only here, so a plain salt recovered by emulating MAKE_CLOSURE still has
    // to be pushed back through the encoding before a fabricated frame agrees
    // with a real one.  See utils/encoding-utils.ts' createSaltEncoding.
    //
    // Two consumers, and both are optional:
    //
    //   `v` — the MULTIPLICATIVE binding.  A scrambled odd value derived from
    //     the salt, multiplied against `c`, the modular inverse of the value
    //     this handler's own function carries.  The product is 1 in that frame
    //     and an arbitrary word in every other, so the handler computes garbage
    //     anywhere else.  `c` never gets a statement at all — it resolves
    //     straight to its literal wherever the expression mentions it.
    //
    //   the SELECTOR — see the merged block below.  A handler uses one or the
    //     other, never both: the multiplicative binding hands an attacker a
    //     closed-form oracle (`imul(v, c) === 1` picks the salt out of a
    //     candidate set in one evaluation), which would immediately resolve a
    //     selector the salt is supposed to hide.  mbaExpand decides which.
    //
    // Emitted as ONE scatter so the decode cannot be placed after the value
    // that reads it, and scattered rather than written as a prologue so a
    // canonicalizer has no fixed `var v = …;` opening to key on.
    const wantsMul = allVars.includes("v");
    const wantsSalt = !!def.select?.key.useSalt || wantsMul;
    let saltLocal: string | null = null;
    if (wantsSalt) {
      const slotLocal = localName(taken);
      saltLocal = localName(taken);
      const decoded = compiler.SALT_ENCODING.decodeExpr(mVar(slotLocal));
      const frameStmts: t.Statement[] = [
        parseStatement(`var ${slotLocal} = regs[fp + SLOTS.SALT];`),
        t.variableDeclaration("var", [
          t.variableDeclarator(
            t.identifier(saltLocal),
            mbaToAST(decoded, (n) => t.identifier(n)),
          ),
        ]),
      ];

      if (wantsMul) {
        // Drawn by the bytecode pass that registered this handler, so the same
        // pair is available to the build-time fit check without re-deriving it.
        const frame = def.frame;
        ok(
          frame,
          `MBA handler ${compiler.OP_NAME[opcode]} is frame-bound but carries ` +
            `no key constants`,
        );
        varNames.v = localName(taken);
        literals.c = frame.inverse;
        frameStmts.push(
          parseStatement(
            `var ${varNames.v} = (Math.imul(${saltLocal}, ${frame.mul}) ^ ${frame.xor}) | 1;`,
          ),
        );
      }

      scatter(body, frameStmts);
    } else {
      ok(
        !wantsMul,
        `MBA handler ${compiler.OP_NAME[opcode]} references "v" without a salt`,
      );
    }

    // ── Merged: read the key, derive the selector ────────────────────────────
    // The key operand is read LAST, matching the order mbaExpand appends it in.
    //
    // What the selector is derived from is the point of it.  A key read straight
    // off the instruction is a per-site constant, so a fitter that probes one
    // site recovers that site's operator regardless of how the two semantics are
    // mixed.  Everything folded in here is a value the compiler knows and an
    // attacker does not: the frame's decoded salt, and — when the generating
    // pass offered one — a register whose value at this instruction it
    // established.  See mba-utils' "Salt-selected semantics".
    if (def.select) {
      varNames.k = localName(taken);
      varNames.s = localName(taken);
      const selWord = localName(taken);
      const mixExprs: string[] = [];
      if (def.select.key.useSalt) mixExprs.push(saltLocal!);
      // The key-mix source is read as an ordinary operand above; `keyMixName`
      // records which of them it is.
      if (def.keyMixName) mixExprs.push(def.keyMixName);

      body.push(parseStatement(`var ${varNames.k} = this._operand();`));
      body.push(
        parseStatement(
          `var ${selWord} = ${selectorWordSource(
            varNames.k,
            def.select.key,
            mixExprs,
          )};`,
        ),
      );
      body.push(
        parseStatement(
          `var ${varNames.s} = (${selWord} >>> ${def.select.key.shift}) & 1;`,
        ),
      );

      // The destination shift, from the same word. mbaExpand emitted `dst`
      // already XORed with this, so the two cancel in the right frame — and in
      // any other one the handler writes to a different, still legal register
      // rather than erroring. See DST_SHIFT_MASK.
      if (def.select.key.dstMask !== 0) {
        body.push(
          parseStatement(
            `dst = dst ^ (${selWord} & ${def.select.key.dstMask});`,
          ),
        );
      }
    }

    // ── Straight-line bindings ───────────────────────────────────────────────
    // An encoded-domain handler names its intermediates rather than inlining
    // them; see MBA_OPS.bindings.  Order is load-bearing (each reads the ones
    // before it), so these are appended rather than scattered.
    const resolve = (name: string): t.Expression => {
      if (name in literals) {
        const value = literals[name];
        return value < 0
          ? t.unaryExpression("-", t.numericLiteral(-value))
          : t.numericLiteral(value);
      }
      // Anything the body did not declare would be emitted as a bare
      // identifier and blow up at RUNTIME with a ReferenceError, long after the
      // build that caused it — most easily by naming a domain for a variable
      // the handler has no operand for.  Fail here instead.  A source name
      // resolves to itself (they seed `taken`); everything else has to have
      // been given a local.
      ok(
        name in varNames || taken.has(name),
        `MBA handler ${compiler.OP_NAME[opcode]} references undeclared ` +
          `variable "${name}"`,
      );
      return t.identifier(varNames[name] ?? name);
    };

    for (const [name, expr] of def.bindings ?? []) {
      const local = localName(taken);
      // Bound AFTER the expression is built, so a binding cannot refer to
      // itself — only to earlier ones.
      const built = mbaToAST(expr, resolve);
      varNames[name] = local;
      body.push(
        t.variableDeclaration("var", [
          t.variableDeclarator(t.identifier(local), built),
        ]),
      );
    }

    body.push(
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(
            t.identifier("regs"),
            t.binaryExpression("+", t.identifier("base"), t.identifier("dst")),
            true,
          ),
          mbaToAST(def.expr, resolve),
        ),
      ),
    );

    t.addComment(
      body[0],
      "leading",
      ` ${compiler.OP_NAME[opcode] ?? `MBA_${opcode}`}`,
      true,
    );
    body.push(t.breakStatement());

    switchStatement.cases.push(
      t.switchCase(t.numericLiteral(opcode), [t.blockStatement(body)]),
    );
  }
}
