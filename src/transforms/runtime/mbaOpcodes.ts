import * as t from "@babel/types";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";
import { getSwitchStatement, parseStatement } from "../../utils/ast-utils.ts";
import {
  RAW_PREFIX,
  mbaToAST,
  mbaVarNames,
  selectorSource,
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

    // ── Merged: read the key, derive the selector ────────────────────────────
    // The key operand is read LAST, matching the order mbaExpand appends it in.
    if (def.select) {
      varNames.k = localName(taken);
      varNames.s = localName(taken);
      body.push(parseStatement(`var ${varNames.k} = this._operand();`));
      body.push(
        parseStatement(
          `var ${varNames.s} = ${selectorSource(varNames.k, def.select.key)};`,
        ),
      );
    }

    // ── Frame binding: scattered, not a prologue ─────────────────────────────
    // `v` is a scrambled odd value derived from the EXECUTING frame's SALT slot
    // — the identity word of whichever function is running — and `c` is the
    // modular inverse of the value this handler's own function carries.
    // Multiplying by both is the identity, but only inside that function.
    //
    // The salt is a full-entropy u32, which is the whole point of reading it
    // rather than the register count this used to use: a count is a small
    // integer, and one an interpreter oracle hands over for free, so binding to
    // it cost an attacker a search of a few hundred values. There is nothing to
    // search here, and nothing in the interpreter that recomputes it.
    //
    // The scramble on top keeps both baked words opaque — a salt of 1 would
    // otherwise invert to a recognisable constant — and mixing through a random
    // multiply and XOR puts `v` anywhere in the 32-bit range.
    //
    // Both the split into two statements and their scattered placement exist to
    // deny a canonicalizer a fixed `var v = …; var c = …;` prologue to key on.
    // `c` never gets a statement at all — it resolves straight to its literal
    // wherever the expression happens to mention it.
    if (allVars.includes("v")) {
      // Drawn by the bytecode pass that registered this handler, so the same
      // pair is available to the build-time fit check without re-deriving it.
      const frame = def.frame;
      ok(
        frame,
        `MBA handler ${compiler.OP_NAME[opcode]} is frame-bound but carries ` +
          `no key constants`,
      );
      const seed = localName(taken);
      varNames.v = localName(taken);
      literals.c = frame.inverse;

      scatter(body, [
        parseStatement(`var ${seed} = regs[fp + SLOTS.SALT];`),
        parseStatement(
          `var ${varNames.v} = (Math.imul(${seed}, ${frame.mul}) ^ ${frame.xor}) | 1;`,
        ),
      ]);
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
