import * as t from "@babel/types";
import traverseImport, { NodePath } from "@babel/traverse";
import { ok } from "assert";
import { parse } from "@babel/parser";
const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Converts the switch-case dispatch into a handler table:
//
// Before (in .run):
//   switch(op) { case OP.ADD: { ... break; } default: { ... } }
//
// After (in .init):
//   this[OP.ADD] = function(){ ... }
//   this["default"] = function(){ ... }
//
// After (in .run, replacing the switch):
//   if(!this[op]) this["default"]();
//   else this[op]();
//
export function applyHandlerTable(ast: t.File): void {
  // 1. Find the @SWITCH statement
  let switchPath: any = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchPath = path;
        path.stop();
      }
    },
  });

  ok(switchPath, "Could not find opcode handlers switch statement");
  const switchNode: t.SwitchStatement = switchPath.node;
  const discriminant = switchNode.discriminant; // `op`

  // 2. Find the @INIT method
  let initPath: NodePath<t.BlockStatement> = null;
  traverse(ast, {
    BlockStatement(path) {
      if (path.node.innerComments?.some((c) => c.value.includes("@INIT"))) {
        initPath = path;
        path.stop();
      }
    },
  });

  ok(initPath, "Could not find @INIT method");
  const initFn = initPath.parentPath;

  // 3. Build handler assignments for each case
  const handlerAssignments: t.ExpressionStatement[] = [];

  for (const switchCase of switchNode.cases) {
    // Strip trailing `break` from body
    let body = [...switchCase.consequent];

    if (body.length === 1 && t.isBlockStatement(body[0])) {
      body = body[0].body;
    }

    if (body.length > 0 && t.isBreakStatement(body[body.length - 1])) {
      body.pop();
    }

    body.unshift(
      ...parse(
        "var frame = this._currentFrame; var base = frame._base; var pc = frame._pc - 1; var regs = this._regs; ",
      ).program.body,
    );

    const block = t.blockStatement(body);

    traverse(block, {
      noScope: true,
      ThisExpression(path) {
        path.replaceWith(t.identifier("_this"));
      },
      Function(path) {
        path.skip();
      },
    });

    // Key: the case test, or "default" for the default case
    const key: t.Expression = switchCase.test
      ? switchCase.test
      : t.stringLiteral("default");

    // this[key] = function(){ ...body }
    const handlerFn = t.functionExpression(null, [], block);
    const assignment = t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(t.thisExpression(), key, true),
        handlerFn,
      ),
    );

    handlerAssignments.push(assignment);
  }

  // 4. Inject handler assignments into the @INIT body
  initPath.node.body = handlerAssignments;

  // 5. Replace the switch statement with handler dispatch:
  //    if(!this[op]) this["default"]();
  //    else this[op]();
  const thisLookup = t.memberExpression(t.thisExpression(), discriminant, true);
  const defaultCall = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.thisExpression(), t.stringLiteral("default"), true),
      [],
    ),
  );
  const handlerCall = t.expressionStatement(t.callExpression(thisLookup, []));

  const dispatch = t.ifStatement(
    t.unaryExpression("!", thisLookup),
    t.blockStatement([defaultCall]),
    t.blockStatement([handlerCall]),
  );

  switchPath.replaceWith(dispatch);
}
