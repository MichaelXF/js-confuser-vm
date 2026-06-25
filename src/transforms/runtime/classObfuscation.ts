import { Compiler } from "../../compiler.ts";
import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import type { Binding, NodePath } from "@babel/traverse";
import {
  shuffle,
  getRandomInt,
  choice,
  chance,
} from "../../utils/random-utils.ts";
import { createNameGenerator } from "../../utils/name-utilts.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// ── Constant inlining ────────────────────────────────────────────────────
// Inlines top-level `var NAME = <literal>;` and `var NAME = { A: <literal>, ... };`
// declarations (e.g. MAIN_START_PC, OP, SENTINELS — all template-injected by
// the serializer before this AST is parsed). A declaration only qualifies
// when babel's own scope analysis proves the binding is never reassigned
// (`binding.constant`); for object declarations every reference must also be
// a plain, non-computed (or string-literal-keyed) property *read* — never a
// `delete`, member assignment/update, or the bare object escaping into some
// other expression (`Object.keys(OP)`, spread, `typeof OP`, etc.). Any
// reference that doesn't provably satisfy this aborts inlining for that
// object entirely; nothing is partially rewritten.

type LiteralNode =
  | t.NumericLiteral
  | t.StringLiteral
  | t.BooleanLiteral
  | t.NullLiteral;

function isLiteralValue(node: t.Node): node is LiteralNode {
  return (
    t.isNumericLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  );
}

// Returns a propName -> literal-value-node map, or null if the object isn't
// made up entirely of plain (non-computed, non-method, non-spread) literal
// properties — e.g. CONSTANTS/BYTECODE arrays never reach here since they
// aren't ObjectExpressions at all.
function getLiteralObjectMap(
  obj: t.ObjectExpression,
): Map<string, t.Expression> | null {
  const map = new Map<string, t.Expression>();
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed || (prop as any).method)
      return null;
    const key = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : null;
    if (key === null || !isLiteralValue(prop.value)) return null;
    map.set(key, prop.value);
  }
  return map;
}

function removeTopLevelStatement(ast: t.File, stmt: t.Statement): void {
  const idx = ast.program.body.indexOf(stmt);
  if (idx !== -1) ast.program.body.splice(idx, 1);
}

function inlineScalarBinding(
  ast: t.File,
  binding: Binding,
  initNode: t.Expression,
  stmt: t.Statement,
): void {
  for (const refPath of binding.referencePaths) {
    refPath.replaceWith(t.cloneNode(initNode, true));
  }
  removeTopLevelStatement(ast, stmt);
}

// Validates every reference is a safe property read, then — only if ALL of
// them are — substitutes each with its literal value and drops the object.
function inlineObjectBinding(
  ast: t.File,
  binding: Binding,
  propMap: Map<string, t.Expression>,
  stmt: t.Statement,
): void {
  const replacements: {
    path: NodePath<t.MemberExpression>;
    value: t.Expression;
  }[] = [];

  for (const refPath of binding.referencePaths) {
    const memberPath = refPath.parentPath;
    if (
      !memberPath ||
      !memberPath.isMemberExpression() ||
      memberPath.node.object !== refPath.node
    ) {
      return; // object escaped as a bare value somewhere — unsafe, abort entirely
    }

    const member = memberPath.node;
    const propName =
      !member.computed && t.isIdentifier(member.property)
        ? member.property.name
        : member.computed && t.isStringLiteral(member.property)
          ? member.property.value
          : null;
    if (propName === null || !propMap.has(propName)) return; // dynamic/unknown access

    const parent = memberPath.parentPath;
    if (
      parent &&
      ((parent.isAssignmentExpression() && parent.node.left === member) ||
        (parent.isUpdateExpression() && parent.node.argument === member) ||
        (parent.isUnaryExpression({ operator: "delete" }) &&
          parent.node.argument === member))
    ) {
      return; // mutated through a member access — unsafe, abort entirely
    }

    replacements.push({ path: memberPath, value: propMap.get(propName)! });
  }

  for (const { path, value } of replacements) {
    path.replaceWith(t.cloneNode(value, true));
  }
  removeTopLevelStatement(ast, stmt);
}

function inlineConstants(ast: t.File, _compiler: Compiler): void {
  traverse(ast, {
    Program(programPath) {
      // Force a fresh scope crawl: earlier runtime passes (antiInstrumentation,
      // specializedOpcodes, ...) clone/push raw AST nodes (switch cases that
      // reference SENTINELS/OP) without going through path-based mutation, so
      // a cached scope from any prior traverse() on this same ast could be
      // missing those references.
      programPath.scope.crawl();

      for (const stmt of [...ast.program.body]) {
        if (!t.isVariableDeclaration(stmt) || stmt.declarations.length !== 1)
          continue;
        const decl = stmt.declarations[0];
        if (!t.isIdentifier(decl.id) || !decl.init) continue;

        const binding = programPath.scope.getBinding(decl.id.name);
        if (!binding || binding.path.node !== decl) continue; // shadowed/ambiguous
        if (!binding.constant || binding.constantViolations.length > 0)
          continue;

        if (isLiteralValue(decl.init)) {
          inlineScalarBinding(ast, binding, decl.init, stmt);
        } else if (t.isObjectExpression(decl.init)) {
          const propMap = getLiteralObjectMap(decl.init);
          if (propMap) inlineObjectBinding(ast, binding, propMap, stmt);
        }
      }
    },
  });
}

// ── Class model ──────────────────────────────────────────────────────────
// Generic discovery of "function constructor + prototype methods" classes
// inside the VM runtime source, e.g. `function Frame(...) { this.x = ...; }`
// plus `Frame.prototype.method = function (...) {...}`. Nothing here is
// hardcoded to the current class names (Upvalue/Closure/Frame/VM) so the
// pass keeps working if runtime.ts evolves.

interface ClassInfo {
  name: string;
  ctorFn: t.FunctionDeclaration;
  fields: Set<string>;
  methods: Map<string, t.FunctionExpression>;
}

interface ClassModel {
  classes: Map<string, ClassInfo>;
}

function collectThisFields(ctorFn: t.FunctionDeclaration): Set<string> {
  const fields = new Set<string>();
  traverse(t.blockStatement(ctorFn.body.body), {
    noScope: true,
    AssignmentExpression(path) {
      const { node } = path;
      const left = node.left;
      if (
        node.operator === "=" &&
        t.isMemberExpression(left) &&
        t.isThisExpression(left.object) &&
        !left.computed &&
        t.isIdentifier(left.property)
      ) {
        fields.add(left.property.name);
      }
    },
  });
  return fields;
}

function buildClassModel(ast: t.File): ClassModel {
  const classes = new Map<string, ClassInfo>();

  // Pass 1: top-level `function Name(...) { this.x = ...; }` constructors.
  for (const stmt of ast.program.body) {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id) continue;
    const fields = collectThisFields(stmt);
    if (fields.size === 0) continue; // not a constructor-shaped function
    classes.set(stmt.id.name, {
      name: stmt.id.name,
      ctorFn: stmt,
      fields,
      methods: new Map(),
    });
  }

  // Pass 2: `Name.prototype.method = function (...) {...}` assignments.
  for (const stmt of ast.program.body) {
    if (!t.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!t.isAssignmentExpression(expr) || expr.operator !== "=") continue;

    const left = expr.left;
    if (
      !t.isMemberExpression(left) ||
      left.computed ||
      !t.isIdentifier(left.property)
    )
      continue;

    const obj = left.object;
    if (
      !t.isMemberExpression(obj) ||
      obj.computed ||
      !t.isIdentifier(obj.object) ||
      !t.isIdentifier(obj.property, { name: "prototype" })
    )
      continue;

    const classInfo = classes.get(obj.object.name);
    if (!classInfo || !t.isFunctionExpression(expr.right)) continue;

    classInfo.methods.set(left.property.name, expr.right);
  }

  return { classes };
}

// ── Property renaming ───────────────────────────────────────────────────
// Renames are applied globally by name (not per-instance/per-type) because
// within this single closed file every dot/string-literal-keyed access to
// one of these names refers to the same logical field across all classes
// that own it (verified safe by detectUnsafeRenamePatterns below). This
// sidesteps needing a full points-to/alias analysis to know what a given
// receiver expression's runtime type is.

const RENAME_DENYLIST = new Set([
  // Reserved / inherited JS identifiers that must never be renamed.
  "prototype",
  "constructor",
  "length",
  "name",
  "call",
  "apply",
  "bind",
  "toString",
  "valueOf",
  "then",
  "catch",
  "finally",
  // PropertyDescriptor keys (used literally by Object.defineProperty calls
  // for getter/setter support — not one of our own class fields).
  "value",
  "get",
  "set",
  "writable",
  "enumerable",
  "configurable",
]);

// Bails out of renaming entirely if the file contains a pattern where a
// property name could leak through a path our by-name renamer can't track
// (destructuring, spreading, or generic enumeration of an object's keys).
// None of these exist in the current runtime.ts, but this keeps the pass
// safe if it changes.
function detectUnsafeRenamePatterns(ast: t.File): boolean {
  let unsafe = false;
  traverse(ast, {
    ObjectPattern() {
      unsafe = true;
    },
    SpreadElement(path) {
      if (t.isObjectExpression(path.parent) || t.isObjectPattern(path.parent)) {
        unsafe = true;
      }
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property) &&
        ((t.isIdentifier(callee.object, { name: "Object" }) &&
          ["keys", "values", "entries", "assign"].includes(
            callee.property.name,
          )) ||
          (t.isIdentifier(callee.object, { name: "JSON" }) &&
            callee.property.name === "stringify"))
      ) {
        unsafe = true;
      }
    },
  });
  return unsafe;
}

// Returns true if `obj` is a "plain struct" literal — every property is a
// plain, non-computed, non-method key (Identifier or string literal) with no
// spread. This is the same shape test as getLiteralObjectMap, minus the
// literal-value requirement, since struct fields are usually assigned from
// local variables (e.g. `{ paramCount: paramCount, regCount: regCount }`).
function isPlainStructObject(obj: t.ObjectExpression): boolean {
  return (
    obj.properties.length > 0 &&
    obj.properties.every(
      (p) =>
        t.isObjectProperty(p) &&
        !p.computed &&
        !(p as any).method &&
        (t.isIdentifier(p.key) || t.isStringLiteral(p.key)),
    )
  );
}

// Collects field names from ad-hoc "struct" object literals used internally by
// the VM runtime as records — fn descriptors (paramCount/regCount/startPc/...),
// upvalue descriptors (isLocal/_index), exception-handler records
// (handlerPc/exceptionReg/...), for-in iterator state (_keys/i), etc. These
// aren't classes (no constructor function builds them), so buildClassModel
// never sees their fields; this is what lets renameClassProperties cover them
// too. PropertyDescriptor-shaped literals passed to Object.defineProperty /
// getOwnPropertyDescriptor (get/set/value/writable/enumerable/configurable)
// are implicitly excluded since every one of those keys is in RENAME_DENYLIST.
// Any object whose shape isn't this simple (computed/method/spread keys) is
// skipped outright rather than partially harvested.
function collectStructFieldNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  traverse(ast, {
    ObjectExpression(path) {
      if (!isPlainStructObject(path.node)) return;
      for (const prop of path.node.properties) {
        if (!t.isObjectProperty(prop)) continue;
        const key = t.isIdentifier(prop.key)
          ? prop.key.name
          : t.isStringLiteral(prop.key)
            ? prop.key.value
            : null;
        if (key) names.add(key);
      }
    },
  });
  return names;
}

function collectCandidateNames(model: ClassModel, ast: t.File): Set<string> {
  const names = new Set<string>();
  for (const cls of model.classes.values()) {
    for (const field of cls.fields) {
      if (!RENAME_DENYLIST.has(field)) names.add(field);
    }
    for (const method of cls.methods.keys()) {
      if (!RENAME_DENYLIST.has(method)) names.add(method);
    }
  }
  for (const field of collectStructFieldNames(ast)) {
    if (!RENAME_DENYLIST.has(field)) names.add(field);
  }
  return names;
}

// Generated names must avoid RENAME_DENYLIST too — otherwise a short generated
// name (e.g. "get") could collide with one of those reserved property names
// and corrupt unrelated, intentionally-untouched accesses (PropertyDescriptor
// shapes, Function.prototype.call/bind, ...).
function generateMangledNames(candidates: Set<string>): Map<string, string> {
  const ordered = shuffle(Array.from(candidates));
  const nextName = createNameGenerator(RENAME_DENYLIST);
  const map = new Map<string, string>();
  for (const nameOriginal of ordered) map.set(nameOriginal, nextName());
  return map;
}

function renameClassProperties(
  ast: t.File,
  model: ClassModel,
  compiler: Compiler,
): void {
  if (detectUnsafeRenamePatterns(ast)) {
    compiler.log(
      "classObfuscation: unsafe property-access pattern detected, skipping rename",
    );
    return;
  }

  const candidates = collectCandidateNames(model, ast);
  if (candidates.size === 0) return;

  const mangleMap = generateMangledNames(candidates);

  traverse(ast, {
    MemberExpression(path) {
      const prop = path.node.property;
      if (
        !path.node.computed &&
        t.isIdentifier(prop) &&
        mangleMap.has(prop.name)
      ) {
        prop.name = mangleMap.get(prop.name)!;
      } else if (
        path.node.computed &&
        t.isStringLiteral(prop) &&
        mangleMap.has(prop.value)
      ) {
        prop.value = mangleMap.get(prop.value)!;
      }
    },
    // Struct literal keys (the writes side of collectStructFieldNames) — the
    // MemberExpression visitor above only catches reads, so without this an
    // object's declared keys would stay original while every read of them
    // got mangled, breaking the runtime.
    ObjectProperty(path) {
      const { node } = path;
      if (node.computed || (node as any).method) return;
      const key = node.key;
      if (t.isIdentifier(key) && mangleMap.has(key.name)) {
        key.name = mangleMap.get(key.name)!;
      } else if (t.isStringLiteral(key) && mangleMap.has(key.value)) {
        path.node.key = t.identifier(mangleMap.get(key.value)!);
      }
    },
  });
}

// ── Parameter reordering ────────────────────────────────────────────────
// For each eligible constructor/method, a single random permutation is
// applied to both its declared parameter list and the argument list of
// every call site that matches it — including call sites synthesized by
// earlier runtime passes (specializedOpcodes/antiInstrumentation), since
// this pass runs last and walks the fully-assembled AST.

interface ReorderCandidate {
  matchName: string;
  isCtor: boolean;
  fn: t.FunctionDeclaration | t.FunctionExpression;
  paramCount: number;
  callSites: (t.CallExpression | t.NewExpression)[];
  unsafe: boolean;
  classInfo: ClassInfo;
}

// No minimum here: even a 0/1-real-param constructor (e.g. Closure(fn)) is a
// valid fake-parameter-injection target — injectFakeParams below pads it out
// with enough fakes that permuting it afterwards is meaningful too.
function hasOnlyPlainIdentifierParams(
  params: (t.Identifier | t.Pattern | t.RestElement)[],
): params is t.Identifier[] {
  return params.every((p) => t.isIdentifier(p));
}

function collectReorderCandidates(model: ClassModel): ReorderCandidate[] {
  const candidates: ReorderCandidate[] = [];

  // A method name is only safe to match by name (regardless of receiver)
  // if exactly one class in the model defines it.
  const methodNameCount = new Map<string, number>();
  for (const cls of model.classes.values()) {
    for (const methodName of cls.methods.keys()) {
      methodNameCount.set(
        methodName,
        (methodNameCount.get(methodName) ?? 0) + 1,
      );
    }
  }

  for (const cls of model.classes.values()) {
    if (hasOnlyPlainIdentifierParams(cls.ctorFn.params)) {
      candidates.push({
        matchName: cls.name,
        isCtor: true,
        fn: cls.ctorFn,
        paramCount: cls.ctorFn.params.length,
        callSites: [],
        unsafe: false,
        classInfo: cls,
      });
    }

    for (const [methodName, fnExpr] of cls.methods) {
      if ((methodNameCount.get(methodName) ?? 0) !== 1) continue; // ambiguous name
      if (!hasOnlyPlainIdentifierParams(fnExpr.params)) continue;
      candidates.push({
        matchName: methodName,
        isCtor: false,
        fn: fnExpr,
        paramCount: fnExpr.params.length,
        callSites: [],
        unsafe: false,
        classInfo: cls,
      });
    }
  }

  return candidates;
}

function randomPermutation(n: number): number[] {
  return shuffle(Array.from({ length: n }, (_, i) => i));
}

// Dummy value handed to a fake parameter at a call site. The value is never
// read by real logic, so any cheap-to-construct literal works; varying the
// kind across call sites just avoids a tell-tale repeated literal.
function randomFakeLiteral(): t.Expression {
  switch (getRandomInt(0, 5)) {
    case 0:
      return t.objectExpression([]);
    case 1:
      return t.arrayExpression([]);
    case 2:
      return t.numericLiteral(getRandomInt(0, 99));
    case 3:
      return t.stringLiteral(choice(["x", "y", "z", "q", "k"]));
    case 4:
      return t.identifier("undefined");
    default:
      return t.nullLiteral();
  }
}

function reorderParameters(ast: t.File, model: ClassModel): void {
  const candidates = collectReorderCandidates(model);
  if (candidates.length === 0) return;

  // ── Fake parameter injection ────────────────────────────────────────────
  // Adds 1-4 never-read params to each candidate's declaration, splicing a
  // dummy literal into every already-registered call site at the same index
  // so arity stays in sync. This runs before the permutation step below, so
  // the fakes get shuffled in amongst the real params for free.
  //
  // The fakes are then "used" so they don't read as obviously dead — every
  // group gets stashed onto a real, brand-new `this` field (never a no-op
  // like `if (x) {}` or a bare `x;`, which a trivial dead-code pass strips
  // on sight), registered into classInfo.fields so it flows through the
  // existing field-renaming pass exactly like a real property. They're never
  // all written in one giveaway statement at the top, either: they're split
  // across however many 1-2-fake groups it takes to exhaust them, each group
  // gets its own field and its own statement, and each statement lands at a
  // random point in the body.
  let fakeParamCounter = 0;
  let fakeFieldCounter = 0;

  function buildFakeUsageStatement(
    refs: t.Expression[],
    classInfo: ClassInfo,
  ): t.Statement {
    const value: t.Expression =
      refs.length > 1 && chance(50)
        ? t.arrayExpression(refs)
        : refs.length === 1
          ? refs[0]
          : refs.reduce((acc, cur) =>
              t.logicalExpression(choice(["||", "&&"]), acc, cur),
            );

    const fieldName = `_fake${++fakeFieldCounter}`;
    classInfo.fields.add(fieldName);
    return t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(t.thisExpression(), t.identifier(fieldName)),
        value,
      ),
    );
  }

  function injectFakeParams(c: ReorderCandidate): void {
    const fakeCount = getRandomInt(1, 4);
    const fakeNames: string[] = [];

    for (let i = 0; i < fakeCount; i++) {
      const name = `fake_${++fakeParamCounter}`;
      fakeNames.push(name);
      const insertAt = getRandomInt(0, c.fn.params.length);
      (c.fn.params as t.Identifier[]).splice(insertAt, 0, t.identifier(name));
      for (const site of c.callSites) {
        site.arguments.splice(insertAt, 0, randomFakeLiteral());
      }
      c.paramCount++;
    }

    shuffle(fakeNames);
    const body = c.fn.body.body;
    let i = 0;
    while (i < fakeNames.length) {
      const groupSize = Math.min(getRandomInt(1, 2), fakeNames.length - i);
      const refs = fakeNames
        .slice(i, i + groupSize)
        .map((n): t.Expression => t.identifier(n));
      i += groupSize;

      const stmt = buildFakeUsageStatement(refs, c.classInfo);
      body.splice(getRandomInt(0, body.length), 0, stmt);
    }
  }

  const ctorByName = new Map<string, ReorderCandidate>();
  const methodByName = new Map<string, ReorderCandidate>();
  for (const c of candidates) {
    (c.isCtor ? ctorByName : methodByName).set(c.matchName, c);
  }

  function validateAndRegister(
    c: ReorderCandidate,
    node: t.CallExpression | t.NewExpression,
  ): void {
    const args = node.arguments;
    if (args.some((a) => t.isSpreadElement(a) || t.isArgumentPlaceholder(a))) {
      c.unsafe = true;
      return;
    }
    // Only fully-positional (every param passed) or fully-defaulted (no args)
    // calls are safe to permute — a partial call would bind the wrong value
    // to the wrong (renamed-position) parameter.
    if (args.length !== 0 && args.length !== c.paramCount) {
      c.unsafe = true;
      return;
    }
    if (args.length === c.paramCount) c.callSites.push(node);
  }

  traverse(ast, {
    NewExpression(path) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee) && ctorByName.has(callee.name)) {
        validateAndRegister(ctorByName.get(callee.name)!, path.node);
      }
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property) &&
        methodByName.has(callee.property.name)
      ) {
        validateAndRegister(methodByName.get(callee.property.name)!, path.node);
      }
    },
  });

  for (const c of candidates) {
    if (c.unsafe) continue;

    injectFakeParams(c);

    const perm = randomPermutation(c.paramCount);
    const params = c.fn.params as t.Identifier[];
    c.fn.params = perm.map((i) => params[i]);

    for (const site of c.callSites) {
      const origArgs = site.arguments.slice();
      site.arguments = perm.map((i) => origArgs[i]) as typeof site.arguments;
    }
  }
}

// ── Statement shuffling (pre-existing behavior) ─────────────────────────

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

function shuffleStatementOrder(ast: t.File): void {
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

// ── Entry point ──────────────────────────────────────────────────────────

export function applyClassObfuscation(ast: t.File, compiler: Compiler): void {
  inlineConstants(ast, compiler);

  const model = buildClassModel(ast);

  // Reorder first: it matches call sites by their *original* method names.
  // Renaming mutates those same MemberExpression names, so it must run after,
  // not before — otherwise the reorder pass can no longer find call sites
  // like `this.captureUpvalue(...)` once they've become `this._i(...)`.
  reorderParameters(ast, model);
  renameClassProperties(ast, model, compiler);
  shuffleStatementOrder(ast);
}
