import { Compiler } from "../../compiler.ts";
import * as t from "@babel/types";
import { shuffle } from "../../utils/random-utils.ts";

function hasComment(node: t.Node, text: string): boolean {
  const all = [
    ...((node as any).leadingComments ?? []),
    ...((node as any).innerComments ?? []),
    ...((node as any).trailingComments ?? []),
  ];
  return all.some((c) => c.value.includes(text));
}

function isPrototypeAssignment(stmt: t.Statement): boolean {
  if (!t.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr)) return false;
  const left = expr.left;
  return (
    t.isMemberExpression(left) &&
    t.isMemberExpression(left.object) &&
    t.isIdentifier((left.object as t.MemberExpression).property, {
      name: "prototype",
    })
  );
}

export function applyClassObfuscation(ast: t.File, _compiler: Compiler): void {
  const body = ast.program.body;

  // Split at the first statement that carries the @BOOT comment.
  // Everything from that statement onward is the boot section and must stay last.
  let bootIdx = body.findIndex((stmt) => hasComment(stmt, "@BOOT"));
  if (bootIdx === -1) bootIdx = body.length;

  const shufflable = body.slice(0, bootIdx);
  const boot = body.slice(bootIdx);

  // Partition the shufflable section into two independent groups.
  // Group A: variable/function declarations (constructors, standalone vars).
  // Group B: prototype method assignments (X.prototype.Y = ...).
  // Both groups are shuffled independently; A always precedes B so that
  // constructors are defined before methods reference them.
  const varDecls: t.Statement[] = [];
  const methodDefs: t.Statement[] = [];

  for (const stmt of shufflable) {
    if (isPrototypeAssignment(stmt)) {
      methodDefs.push(stmt);
    } else {
      varDecls.push(stmt);
    }
  }

  shuffle(varDecls);
  shuffle(methodDefs);

  ast.program.body = [...varDecls, ...methodDefs, ...boot];
}
