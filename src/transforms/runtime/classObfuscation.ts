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
import { NOISE_SLOT_PREFIX } from "../../utils/frame-layout.ts";
import {
  buildClassModel,
  collectUsedNames,
  type ClassInfo,
  type ClassModel,
  type DeclassifiedClass,
  type DeclassifiedFn,
  type DeclassifyResult,
} from "./declassify.ts";

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
//
// The one exception is a missing NOISE_* key: those frame slots are optional by
// design, so they inline to `void 0` instead of aborting, which is what switches
// their runtime blocks off. Any other missing key is a typo, and still aborts.

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
    if (propName === null) return; // computed key — the property read is unknowable
    if (!propMap.has(propName) && !propName.startsWith(NOISE_SLOT_PREFIX))
      return; // missing key that isn't an optional frame slot — abort

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

    replacements.push({
      path: memberPath,
      value:
        propMap.get(propName) ?? t.unaryExpression("void", t.numericLiteral(0)),
    });
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
      // specializedOpcodes, declassify, ...) clone/push raw AST nodes (switch
      // cases that reference SENTINELS/OP) without going through path-based
      // mutation, so a cached scope from any prior traverse() on this same ast
      // could be missing those references.
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
// (handlerPc/exceptionReg/...), for-in iterator state (_keys/i), and — once
// declassify has run — the bare objects the class factories hand back. These
// aren't classes (no constructor function builds them), so buildClassModel
// never sees their fields; this is what lets the renamer cover them too.
// PropertyDescriptor-shaped literals passed to Object.defineProperty /
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

// After declassify the method names are gone from the property namespace —
// they're plain function bindings now, renamed separately by
// renameFreeFunctions. What's left is the field set (which includes the fake
// fields injected below) plus every struct literal in the file.
function collectDeclassifiedNames(
  result: DeclassifyResult,
  ast: t.File,
): Set<string> {
  const names = new Set<string>();
  for (const cls of result.classes) {
    for (const field of cls.fields) {
      if (!RENAME_DENYLIST.has(field)) names.add(field);
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

function renameProperties(
  ast: t.File,
  candidates: Set<string>,
  compiler: Compiler,
): void {
  if (detectUnsafeRenamePatterns(ast)) {
    compiler.log(
      "classObfuscation: unsafe property-access pattern detected, skipping rename",
    );
    return;
  }

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

// ── Fake parameters ─────────────────────────────────────────────────────
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

// Folds a group of fake parameter references into one value worth assigning,
// so the result never reads as an obvious no-op (`if (x) {}`, a bare `x;`)
// that a trivial dead-code pass strips on sight.
function buildFakeValue(refs: t.Expression[]): t.Expression {
  if (refs.length === 1) return refs[0];
  if (chance(50)) return t.arrayExpression(refs);
  return refs.reduce((acc, cur) =>
    t.logicalExpression(choice(["||", "&&"]), acc, cur),
  );
}

function randomPermutation(n: number): number[] {
  return shuffle(Array.from({ length: n }, (_, i) => i));
}

// ── Parameter reordering (pre-declassify shape) ─────────────────────────
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
  // group gets stashed onto a real, brand-new `this` field, registered into
  // classInfo.fields so it flows through the existing field-renaming pass
  // exactly like a real property. They're never all written in one giveaway
  // statement at the top, either: they're split across however many 1-2-fake
  // groups it takes to exhaust them, each group gets its own field and its
  // own statement, and each statement lands at a random point in the body.
  let fakeParamCounter = 0;
  let fakeFieldCounter = 0;

  function buildFakeUsageStatement(
    refs: t.Expression[],
    classInfo: ClassInfo,
  ): t.Statement {
    const fieldName = `_fake${++fakeFieldCounter}`;
    classInfo.fields.add(fieldName);
    return t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(t.thisExpression(), t.identifier(fieldName)),
        buildFakeValue(refs),
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

// ── Parameter reordering (post-declassify shape) ────────────────────────
// Once declassify has run, every factory and every former method is a plain
// function binding, so call sites are matched by *binding* instead of by
// property name. That removes the ambiguity bail-out the shape above needs
// (two classes sharing a method name) and makes the receiver — now just the
// first argument — one more parameter free to be shuffled out of position 0.

interface FreeCandidate {
  entry: DeclassifiedFn;
  paramCount: number;
  callSites: t.CallExpression[];
  usesArguments: boolean;
  unsafe: boolean;
}

function referencesArguments(fn: t.FunctionDeclaration): boolean {
  let found = false;
  t.traverseFast(fn, (n) => {
    if (t.isIdentifier(n, { name: "arguments" })) found = true;
  });
  return found;
}

// Skips the two positions where an identifier is a name rather than a
// reference. Our generated function names are unique across the file so this
// can't actually fire today, but it keeps the by-name matching honest.
function isNamePosition(path: NodePath<t.Identifier>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  if (
    parent.isMemberExpression() &&
    parent.node.property === path.node &&
    !parent.node.computed
  )
    return true;
  return (
    parent.isObjectProperty() &&
    parent.node.key === path.node &&
    !parent.node.computed
  );
}

function reorderFreeFunctions(ast: t.File, result: DeclassifyResult): void {
  const byName = new Map<string, FreeCandidate>();
  for (const entry of result.fns) {
    if (!hasOnlyPlainIdentifierParams(entry.fn.params)) continue;
    byName.set(entry.name, {
      entry,
      paramCount: entry.fn.params.length,
      callSites: [],
      usesArguments: referencesArguments(entry.fn),
      unsafe: false,
    });
  }
  if (byName.size === 0) return;

  traverse(ast, {
    Identifier(path) {
      const candidate = byName.get(path.node.name);
      if (!candidate) return;

      const parent = path.parentPath;
      if (!parent) return;
      if (parent.isFunctionDeclaration() && parent.node.id === path.node)
        return; // its own declaration
      if (isNamePosition(path)) return;

      if (!parent.isCallExpression() || parent.node.callee !== path.node) {
        candidate.unsafe = true; // escapes as a value — can't track its arity
        return;
      }

      const args = parent.node.arguments;
      if (args.some((a) => t.isSpreadElement(a) || t.isArgumentPlaceholder(a))) {
        candidate.unsafe = true;
        return;
      }

      // Partial calls exist by design: `this._constant()` leaves both operand
      // params defaulted, and after declassify that's `VM_constant(vm)`
      // against three params. Pad them out to full arity so the permutation
      // can't rebind a real argument to the wrong slot. Skipped if the
      // function can observe `arguments.length`.
      if (args.length < candidate.paramCount && !candidate.usesArguments) {
        while (args.length < candidate.paramCount) {
          args.push(t.unaryExpression("void", t.numericLiteral(0)));
        }
      }
      if (args.length !== candidate.paramCount) {
        candidate.unsafe = true;
        return;
      }
      candidate.callSites.push(parent.node);
    },
  });

  let fakeParamCounter = 0;
  let fakeFieldCounter = 0;

  // Decoy fields are seeded into the factory's object literal so the shape is
  // final at construction — a method writing a brand-new property on the hot
  // path would otherwise transition the object's hidden class mid-run.
  function seedDecoyField(owner: DeclassifiedClass, fieldName: string): void {
    owner.objectLiteral.properties.push(
      t.objectProperty(t.identifier(fieldName), randomFakeLiteral()),
    );
  }

  // A fake statement must land before the function's first top-level return,
  // otherwise it's unreachable and reads as exactly the dead code it is.
  function insertLimit(body: t.Statement[]): number {
    const idx = body.findIndex((s) => t.isReturnStatement(s));
    return idx === -1 ? body.length : idx;
  }

  function injectFakeParams(candidate: FreeCandidate): void {
    const { entry } = candidate;
    const fakeCount = getRandomInt(1, 4);
    const fakeNames: string[] = [];

    for (let i = 0; i < fakeCount; i++) {
      const name = `fake_${++fakeParamCounter}`;
      fakeNames.push(name);
      const insertAt = getRandomInt(0, entry.fn.params.length);
      (entry.fn.params as t.Identifier[]).splice(
        insertAt,
        0,
        t.identifier(name),
      );
      for (const site of candidate.callSites) {
        site.arguments.splice(insertAt, 0, randomFakeLiteral());
      }
      candidate.paramCount++;
    }

    shuffle(fakeNames);
    const body = entry.fn.body.body;
    let i = 0;
    while (i < fakeNames.length) {
      const groupSize = Math.min(getRandomInt(1, 2), fakeNames.length - i);
      const refs = fakeNames
        .slice(i, i + groupSize)
        .map((n): t.Expression => t.identifier(n));
      i += groupSize;

      const fieldName = `_fake${++fakeFieldCounter}`;
      entry.owner.fields.add(fieldName);
      const value = buildFakeValue(refs);

      if (entry.selfName === null) {
        // A factory has no receiver to write through — the fake rides along
        // as one more property of the object it builds.
        entry.owner.objectLiteral.properties.push(
          t.objectProperty(t.identifier(fieldName), value),
        );
        continue;
      }

      seedDecoyField(entry.owner, fieldName);
      body.splice(
        getRandomInt(0, insertLimit(body)),
        0,
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.memberExpression(
              t.identifier(entry.selfName),
              t.identifier(fieldName),
            ),
            value,
          ),
        ),
      );
    }
  }

  for (const candidate of byName.values()) {
    if (candidate.unsafe) continue;

    injectFakeParams(candidate);

    const perm = randomPermutation(candidate.paramCount);
    const params = candidate.entry.fn.params as t.Identifier[];
    candidate.entry.fn.params = perm.map((i) => params[i]);

    for (const site of candidate.callSites) {
      const origArgs = site.arguments.slice();
      site.arguments = perm.map((i) => origArgs[i]) as typeof site.arguments;
    }
  }
}

// The functions declassify hid inside the run function keep their readable
// `VM_pushFrame`-style names right up until here, so every pass in between
// stays debuggable. They are bindings, not properties, so renaming them is a
// scope question, not an alias-analysis one — and their generated names are
// unique across the file, which is what makes the flat identifier sweep below
// sound. The top-level survivors (the factories, the run function, the boot
// helpers) keep their names: they're `var`s on the global object in a browser,
// where a one-letter name is a live collision risk with the guest program's
// own globals.
function renameFreeFunctions(ast: t.File, result: DeclassifyResult): void {
  const targets = result.fns.filter((f) => f.moved);
  if (targets.length === 0) return;

  const nextName = createNameGenerator(collectUsedNames(ast));
  const map = new Map<string, string>();
  for (const entry of shuffle(targets.slice())) map.set(entry.name, nextName());

  traverse(ast, {
    Identifier(path) {
      const renamed = map.get(path.node.name);
      if (!renamed || isNamePosition(path)) return;
      path.node.name = renamed;
    },
  });

  for (const entry of targets) entry.name = map.get(entry.name)!;
}

// Shuffles each factory's object literal. Safe only while every initializer is
// side-effect free and independent of the others, which is what the purity
// test below establishes — a value that reads a variable assigned by an
// earlier property would change meaning if it moved.
function isPureInitializer(node: t.Node): boolean {
  if (t.isIdentifier(node)) return true;
  if (t.isNullLiteral(node)) return true;
  if (
    t.isNumericLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node)
  )
    return true;
  if (t.isArrayExpression(node)) return node.elements.length === 0;
  if (t.isObjectExpression(node)) return node.properties.length === 0;
  if (t.isUnaryExpression(node) && node.operator === "void")
    return isPureInitializer(node.argument);
  return false;
}

function shuffleObjectFields(result: DeclassifyResult): void {
  for (const cls of result.classes) {
    const props = cls.objectLiteral.properties;
    if (props.length < 2) continue;
    const shufflable = props.every(
      (p) => t.isObjectProperty(p) && !p.computed && isPureInitializer(p.value),
    );
    if (!shufflable) continue;
    shuffle(props);
  }
}

// ── Statement shuffling ─────────────────────────────────────────────────

function hasComment(node: t.Node, text: string): boolean {
  const all = [
    ...((node as any).leadingComments ?? []),
    ...((node as any).innerComments ?? []),
    ...((node as any).trailingComments ?? []),
  ];
  return all.some((c) => c.value.includes(text));
}

// Names bound by `var VMPrototype = VM.prototype;` — handlerTable writes its
// handler table through an alias like this, so assignments through one have to
// be grouped with the other prototype methods (below) rather than left in the
// declaration group alongside the alias they depend on.
function collectPrototypeAliases(body: t.Statement[]): Set<string> {
  const aliases = new Set<string>();
  for (const stmt of body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      const init = decl.init;
      if (
        t.isIdentifier(decl.id) &&
        t.isMemberExpression(init) &&
        !init.computed &&
        t.isIdentifier(init.property, { name: "prototype" })
      ) {
        aliases.add(decl.id.name);
      }
    }
  }
  return aliases;
}

function isPrototypeAssignment(
  stmt: t.Statement,
  aliases: Set<string>,
): boolean {
  if (!t.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr)) return false;
  const left = expr.left;
  if (!t.isMemberExpression(left)) return false;
  if (t.isIdentifier(left.object) && aliases.has(left.object.name)) return true;
  return (
    t.isMemberExpression(left.object) &&
    t.isIdentifier(left.object.property, { name: "prototype" })
  );
}

// The hidden helpers are function *declarations*, so they hoist to the top of
// the run function no matter where they physically sit. That makes every slot
// in the body a legal home for them — including past the dispatch loop, where
// nothing else could go. Only the declarations move; every other statement
// keeps its relative order, which is what keeps `var H = []` ahead of the
// handler-table assignments that write through it.
function shuffleRunLocals(runFn: t.FunctionDeclaration): void {
  const body = runFn.body.body;
  const decls = body.filter((s): s is t.FunctionDeclaration =>
    t.isFunctionDeclaration(s),
  );
  if (decls.length < 2) return;

  const rest = body.filter((s) => !t.isFunctionDeclaration(s));
  shuffle(decls);
  for (const decl of decls) rest.splice(getRandomInt(0, rest.length), 0, decl);
  runFn.body.body = rest;
}

function shuffleStatementOrder(
  ast: t.File,
  result: DeclassifyResult | null,
): void {
  const body = ast.program.body;

  // Split at the first statement that carries the @BOOT comment.
  // Everything from that statement onward is the boot section and must stay last.
  let bootIdx = body.findIndex((stmt) => hasComment(stmt, "@BOOT"));
  if (bootIdx === -1) bootIdx = body.length;

  const shufflable = body.slice(0, bootIdx);
  const boot = body.slice(bootIdx);

  // Partition the shufflable section into two independent groups.
  // Group A: variable/function declarations (constructors, standalone vars).
  // Group B: prototype method assignments (X.prototype.Y = ..., alias[K] = ...).
  // Both groups are shuffled independently; A always precedes B so that
  // constructors and prototype aliases are defined before methods reference them.
  // After declassify group B is empty — there are no prototypes left to assign.
  const aliases = collectPrototypeAliases(body);
  const varDecls: t.Statement[] = [];
  const methodDefs: t.Statement[] = [];

  for (const stmt of shufflable) {
    if (isPrototypeAssignment(stmt, aliases)) {
      methodDefs.push(stmt);
    } else {
      varDecls.push(stmt);
    }
  }

  shuffle(varDecls);
  shuffle(methodDefs);

  ast.program.body = [...varDecls, ...methodDefs, ...boot];

  if (result) shuffleRunLocals(result.runFn);
}

// ── Entry point ──────────────────────────────────────────────────────────

export function applyClassObfuscation(ast: t.File, compiler: Compiler): void {
  inlineConstants(ast, compiler);

  const declassified = compiler.declassify;

  if (declassified) {
    // Reorder first: it registers the fake fields that renaming has to cover.
    reorderFreeFunctions(ast, declassified);
    renameProperties(ast, collectDeclassifiedNames(declassified, ast), compiler);
    renameFreeFunctions(ast, declassified);
    shuffleObjectFields(declassified);
  } else {
    const model = buildClassModel(ast);

    // Reorder first: it matches call sites by their *original* method names.
    // Renaming mutates those same MemberExpression names, so it must run after,
    // not before — otherwise the reorder pass can no longer find call sites
    // like `this.captureUpvalue(...)` once they've become `this._i(...)`.
    reorderParameters(ast, model);
    renameProperties(ast, collectCandidateNames(model, ast), compiler);
  }

  shuffleStatementOrder(ast, declassified);
}
