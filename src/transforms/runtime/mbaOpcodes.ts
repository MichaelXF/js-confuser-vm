import * as t from "@babel/types";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";
import { getSwitchStatement, parseStatement } from "../../utils/ast-utils.ts";
import { mbaToAST, mbaVarNames, modInverse32 } from "../../utils/mba-utils.ts";
import { getRandomInt } from "../../utils/random-utils.ts";

// Pick the scramble constants for one frame-bound handler, and the inverse that
// undoes them for `regCount`.
//
// `v = (imul(regCount, mul) ^ xor) | 1` is always odd, so it always has an
// inverse mod 2^32. Redrawing until `v` is large keeps both baked words opaque:
// a small multiplicand would invert to a well-known magic constant, and v === 1
// would make the whole binding a no-op.
function frameKeyConstants(regCount: number) {
  const MIN_MAGNITUDE = 0xffff;
  for (let attempt = 0; ; attempt++) {
    // An odd multiplier keeps imul a bijection, so distinct register counts
    // stay distinct.
    const mul = (getRandomInt(1, 0x7fffffff) * 2 + 1) | 0;
    const xor = getRandomInt(1, 0x7fffffff) | 0;
    const v = ((Math.imul(regCount, mul) ^ xor) | 1) | 0;
    const inverse = modInverse32(v);
    if (
      attempt > 32 ||
      (Math.abs(v) > MIN_MAGNITUDE && Math.abs(inverse) > MIN_MAGNITUDE)
    )
      return { mul, xor, inverse };
  }
}

// mbaOpcodes (runtime side)
// ───────────────────────────────────────────────────────────────────────────
// Emits a switch case for every entry the mbaExpand bytecode pass registered in
// compiler.MBA_OPS.  Each case reads the same operands the original opcode did
// — the bytecode is unchanged apart from the opcode number — and computes the
// result through that entry's synthesized MBA identity:
//
//   case <MBA_ADD_1>: {
//     var dst = this._operand();
//     var a = regs[base + this._operand()];
//     var b = regs[base + this._operand()];
//     regs[base + dst] = ((((a ^ b) | 0) + ((a & b) * 2)) | 0);
//     break;
//   }
//
// Tier 0 entries (`& | ^`, `~`) additionally normalise their operands with
// `~~` first, because JavaScript lets those operators take any value and the
// identity is only exact once the inputs are genuinely int32.
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
    const binary = def.arity === 3;

    const body: t.Statement[] = [
      parseStatement("var dst = this._operand();"),
      parseStatement("var a = regs[base + this._operand()];"),
    ];
    if (binary) body.push(parseStatement("var b = regs[base + this._operand()];"));

    if (def.normalize) {
      body.push(parseStatement("a = ~~a;"));
      if (binary) body.push(parseStatement("b = ~~b;"));
    }

    // Frame binding. `v` is a scrambled odd value derived from the EXECUTING
    // frame's register count; `c` is the modular inverse of the value this
    // handler's own function is expected to have. Multiplying by both is the
    // identity — but only in a frame with the matching register count.
    //
    // The scramble is what keeps the baked constants opaque: a raw register
    // count is small, and the inverse of a small number is a recognisable
    // constant (modInverse32(3) is 0xAAAAAAAB), while a count of 0 would
    // collapse to a no-op. Mixing through a random multiply and XOR first puts
    // `v` anywhere in the 32-bit range.
    if (mbaVarNames(def.expr).includes("v")) {
      const regCount = compiler.fnDescriptors[def.fnId!]?.regCount ?? 0;
      const { mul, xor, inverse } = frameKeyConstants(regCount);
      body.push(
        parseStatement(
          `var v = (Math.imul(regs[fp + SLOTS.FRAME_SIZE] - HEADER_SIZE, ${mul}) ^ ${xor}) | 1;`,
        ),
      );
      body.push(parseStatement(`var c = ${inverse};`));
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
          mbaToAST(def.expr, (name) => t.identifier(name)),
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
