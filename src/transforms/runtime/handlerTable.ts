import * as t from "@babel/types";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { Compiler } from "../../compiler.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Parse a single statement from source. Preferred over hand-building deep AST
// (t.variableDeclaration([t.variableDeclarator(...)])) — it keeps the injected
// runtime snippets readable and easy to change. Build-time perf is irrelevant.
function parseStatement(code: string): t.Statement {
  return parse(code, { sourceType: "script" }).program.body[0] as t.Statement;
}

function hasComment(node: t.Node, text: string): boolean {
  return ((node as any).leadingComments ?? []).some((c: t.Comment) =>
    c.value.includes(text),
  );
}

// Replace every switch-level `break;` with `return;` so a case body becomes a
// valid standalone function body. A `break` that belongs to a loop or nested
// switch *inside* the case keeps its own meaning, so we never descend into
// those constructs. (After the RETURN restructure in runtime.ts every case ends
// in a single trailing break, but handling mid-body breaks keeps this robust as
// the runtime evolves and as macro opcodes splice bodies together.)
function convertSwitchBreaks(stmts: t.Statement[]): void {
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (t.isBreakStatement(stmt) && !stmt.label) {
      stmts[i] = t.returnStatement();
    } else if (t.isIfStatement(stmt)) {
      stmt.consequent = convertInBranch(stmt.consequent);
      if (stmt.alternate) stmt.alternate = convertInBranch(stmt.alternate);
    } else if (t.isBlockStatement(stmt)) {
      convertSwitchBreaks(stmt.body);
    } else if (t.isTryStatement(stmt)) {
      convertSwitchBreaks(stmt.block.body);
      if (stmt.handler) convertSwitchBreaks(stmt.handler.body.body);
      if (stmt.finalizer) convertSwitchBreaks(stmt.finalizer.body);
    }
    // Loops (for/while/do-while) and nested switches own their `break` — skip.
  }
}

function convertInBranch(node: t.Statement): t.Statement {
  if (t.isBlockStatement(node)) {
    convertSwitchBreaks(node.body);
    return node;
  }
  const arr = [node];
  convertSwitchBreaks(arr);
  return arr[0];
}

// Pull out a case's statements, unwrapping the optional `{ ... }` block wrapper
// (case bodies in runtime.ts come in both forms). Cloned so the original switch
// node is left untouched until we replace it.
function caseBody(sc: t.SwitchCase): t.Statement[] {
  const raw =
    sc.consequent.length === 1 && t.isBlockStatement(sc.consequent[0])
      ? (sc.consequent[0] as t.BlockStatement).body
      : sc.consequent;
  return raw.map((s) => t.cloneNode(s, true) as t.Statement);
}

// Only hoist the frame/regs/base locals a given handler body actually reads —
// most handlers use one or two, so injecting all three bloats the output. We
// pre-scan the body's identifiers for those exact names. `base` derives from
// `frame`; when a body uses `base` but not `frame` we inline `this._currentFrame`
// rather than emit an otherwise-unused `frame` var.
function buildInjectedVars(body: t.Statement[]): t.Statement[] {
  const used = new Set<string>();
  t.traverseFast(t.blockStatement(body), (node) => {
    if (t.isIdentifier(node)) used.add(node.name);
  });

  const injected: t.Statement[] = [];
  if (used.has("frame"))
    injected.push(parseStatement("var frame = this._currentFrame;"));
  if (used.has("regs")) injected.push(parseStatement("var regs = this._regs;"));
  if (used.has("base")) {
    injected.push(
      parseStatement(
        used.has("frame")
          ? "var base = frame._base;"
          : "var base = this._currentFrame._base;",
      ),
    );
  }
  return injected;
}

// convertSwitchBreaks turns a trailing `break;` into `return;`; a bare return as
// the last statement of a function is implicit, so drop it to save bytes.
function dropTrailingReturn(body: t.Statement[]): void {
  const last = body[body.length - 1];
  if (last && t.isReturnStatement(last) && !last.argument) body.pop();
}

// Lift the @SWITCH opcode dispatch into a handler table:
//   VM.prototype[<opcode>] = function () { <injected vars>; <case body> };
// and replace the switch itself with a single dynamic dispatch `this[op]()`.
//
// Must run AFTER every pass that adds or clones switch cases (specialized /
// macro / aliased / anti-instrumentation / shuffle) and BEFORE classObfuscation
// so the lifted handler functions get obfuscated like the rest of the runtime
// (and so `OP.X` keys get inlined to numbers by classObfuscation's
// inlineConstants).
export function applyHandlerTable(ast: t.File, _compiler: Compiler): void {
  let handlers: t.Statement[] | null = null;

  traverse(ast, {
    SwitchStatement(path) {
      if (!path.node.leadingComments?.some((c) => c.value.includes("@SWITCH")))
        return;

      handlers = [];
      for (const sc of path.node.cases) {
        // default: (test === null) is dropped. Unknown opcodes now surface as a
        // TypeError from `this[op]()` rather than the old explicit Error — they
        // are unreachable for well-formed bytecode anyway.
        if (sc.test === null) continue;

        const body = caseBody(sc);
        convertSwitchBreaks(body);
        dropTrailingReturn(body);

        const fn = t.functionExpression(
          null,
          [],
          t.blockStatement([...buildInjectedVars(body), ...body]),
        );

        // The key is the case test verbatim: `OP.LOAD_CONST` for original ops
        // (classObfuscation later inlines OP -> a number), or a numeric literal
        // for synthetic specialized / macro / aliased ops.
        handlers.push(
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(
                t.memberExpression(
                  t.identifier("VM"),
                  t.identifier("prototype"),
                ),
                t.cloneNode(sc.test, true),
                true, // computed
              ),
              fn,
            ),
          ),
        );
      }

      // Replace the whole switch with a single dynamic dispatch. Uses `op` (not
      // `opcode`) so the TIMING_CHECKS tamper path, which reassigns `op`, still
      // routes through the handler table.
      path.replaceWith(parseStatement("this[op]();"));
      path.stop();
    },
  });

  ok(handlers, "Could not find @SWITCH statement for handler table");

  // Drop the handler assignments in just before the @BOOT section so they sit
  // alongside the other VM.prototype.* method definitions — classObfuscation's
  // statement shuffler then mixes them in with the rest.
  const body = ast.program.body;
  let bootIdx = body.findIndex((stmt) => hasComment(stmt, "@BOOT"));
  if (bootIdx === -1) bootIdx = body.length;
  body.splice(bootIdx, 0, ...handlers);
}
