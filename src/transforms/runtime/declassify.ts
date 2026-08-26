import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import type { Compiler } from "../../compiler.ts";
import { getSwitchStatement } from "../../utils/ast-utils.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// ── Class model ──────────────────────────────────────────────────────────
// Generic discovery of "function constructor + prototype methods" classes
// inside the VM runtime source, e.g. `function Frame(...) { this.x = ...; }`
// plus `Frame.prototype.method = function (...) {...}`. Nothing here is
// hardcoded to the current class names (Upvalue/Closure/VM) so the pass keeps
// working if runtime.ts evolves.

export interface ClassInfo {
  name: string;
  ctorFn: t.FunctionDeclaration;
  fields: Set<string>;
  methods: Map<string, t.FunctionExpression>;
}

export interface ClassModel {
  classes: Map<string, ClassInfo>;
}

export function collectThisFields(ctorFn: t.FunctionDeclaration): Set<string> {
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

// Matches `Name.prototype.method = <fn>` and hands back its three parts.
function matchPrototypeMethod(
  stmt: t.Statement,
): { className: string; methodName: string; fn: t.FunctionExpression } | null {
  if (!t.isExpressionStatement(stmt)) return null;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr) || expr.operator !== "=") return null;

  const left = expr.left;
  if (
    !t.isMemberExpression(left) ||
    left.computed ||
    !t.isIdentifier(left.property)
  )
    return null;

  const obj = left.object;
  if (
    !t.isMemberExpression(obj) ||
    obj.computed ||
    !t.isIdentifier(obj.object) ||
    !t.isIdentifier(obj.property, { name: "prototype" })
  )
    return null;

  if (!t.isFunctionExpression(expr.right)) return null;

  return {
    className: obj.object.name,
    methodName: left.property.name,
    fn: expr.right,
  };
}

export function buildClassModel(ast: t.File): ClassModel {
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
    const match = matchPrototypeMethod(stmt);
    if (!match) continue;
    const classInfo = classes.get(match.className);
    if (!classInfo) continue;
    classInfo.methods.set(match.methodName, match.fn);
  }

  return { classes };
}

// ── Declassify ───────────────────────────────────────────────────────────
// Rewrites the runtime's function-constructor "classes" into bare object
// factories plus standalone functions, then hides everything the boot section
// doesn't name inside the run function.
//
//   function VM(a, b) { this.a = a; ... }               -> function VM(a, b) { return { a: a, ... }; }
//   VM.prototype._operand = function () { ...this... }  -> function VM_operand(vm) { ...vm... }
//   this._operand()                                     -> VM_operand(vm)
//   uv._close()                                         -> Upvalue_close(uv)
//   new Upvalue(regs, slot)                             -> Upvalue(regs, slot)
//
// The point is what disappears. There is no `.prototype` left to monkey-patch
// from a console, no constructor name for a heap snapshot to group instances
// under, and every helper that isn't reachable from boot becomes a local of
// the run function — out of reach without a breakpoint.

export interface DeclassifiedClass {
  name: string;
  ctorFn: t.FunctionDeclaration;
  // The object literal the factory hands back. Decoy/fake fields are seeded
  // here so they exist from construction instead of transitioning the object's
  // shape the first time a method writes one.
  objectLiteral: t.ObjectExpression;
  fields: Set<string>;
}

export interface DeclassifiedFn {
  name: string;
  fn: t.FunctionDeclaration;
  // Parameter that took over from `this`; null for the factories themselves.
  selfName: string | null;
  owner: DeclassifiedClass;
  // True once the declaration has been relocated inside the run function.
  moved: boolean;
}

export interface DeclassifyResult {
  runFn: t.FunctionDeclaration;
  runFnName: string;
  // Name of run's `this` replacement. The handler table closes over it.
  vmName: string;
  classes: DeclassifiedClass[];
  fns: DeclassifiedFn[];
  fields: Set<string>;
}

export function collectUsedNames(node: t.Node): Set<string> {
  const names = new Set<string>();
  t.traverseFast(node, (n) => {
    if (t.isIdentifier(n)) names.add(n.name);
  });
  return names;
}

export function makeUniqueNamer(taken: Set<string>): (base: string) => string {
  return (base: string) => {
    let name = base;
    let counter = 2;
    while (taken.has(name)) name = base + counter++;
    taken.add(name);
    return name;
  };
}

function containsNode(root: t.Node, target: t.Node): boolean {
  let found = false;
  t.traverseFast(root, (n) => {
    if (n === target) found = true;
  });
  return found;
}

function containsThis(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (n) => {
    if (t.isThisExpression(n)) found = true;
  });
  return found;
}

// Swap every `this` belonging to `fn` for `selfName`. Arrow functions inherit
// `this`, so we keep descending into them; every other function boundary
// rebinds `this` and is left alone — the callable shell built by MAKE_CLOSURE
// reads its own receiver and must keep doing so.
function replaceThisWith(fn: t.Function, selfName: string): void {
  const block = fn.body as t.BlockStatement;
  const skip = (path: { skip: () => void }) => path.skip();
  traverse(t.blockStatement(block.body), {
    noScope: true,
    FunctionDeclaration: skip,
    FunctionExpression: skip,
    ObjectMethod: skip,
    ClassMethod: skip,
    ThisExpression(path) {
      path.replaceWith(t.identifier(selfName));
    },
  });
}

// Every reason we'd refuse to declassify, checked before anything is mutated
// so a bail-out leaves the AST exactly as the earlier passes produced it.
function findUnsafeReason(ast: t.File, model: ClassModel): string | null {
  const methodOwners = new Map<string, string[]>();
  for (const cls of model.classes.values()) {
    for (const methodName of cls.methods.keys()) {
      const owners = methodOwners.get(methodName) ?? [];
      owners.push(cls.name);
      methodOwners.set(methodName, owners);
    }
  }

  for (const [methodName, owners] of methodOwners) {
    if (owners.length > 1) {
      return `method "${methodName}" is defined by ${owners.join(
        " and ",
      )}, so a call site's receiver type can't be resolved by name`;
    }
  }

  let reason: string | null = null;

  traverse(ast, {
    MemberExpression(path) {
      if (reason) return;
      const { node } = path;
      if (node.computed || !t.isIdentifier(node.property)) return;
      if (!methodOwners.has(node.property.name)) return;

      // `X.prototype.method = ...` — the definitions this pass removes.
      const obj = node.object;
      if (
        t.isMemberExpression(obj) &&
        !obj.computed &&
        t.isIdentifier(obj.property, { name: "prototype" })
      )
        return;

      // Anything other than an immediate call means the method escapes as a
      // value (`arr.map(this._read)`), which a receiver-to-argument rewrite
      // cannot follow.
      const parent = path.parentPath;
      if (!parent?.isCallExpression() || parent.node.callee !== node) {
        reason = `method "${node.property.name}" is read without being called`;
      }
    },
    Identifier(path) {
      if (reason) return;
      const cls = model.classes.get(path.node.name);
      if (!cls) return;
      if (cls.ctorFn.id === path.node) return; // its own declaration

      const parent = path.parentPath;
      if (!parent) return;

      // `new C(...)` / `C(...)` are what we rewrite, `C.prototype...` is what
      // we delete. Any other appearance means the constructor is used as a
      // value, where dropping `new` could change behavior.
      if (
        (parent.isNewExpression() || parent.isCallExpression()) &&
        parent.node.callee === path.node
      )
        return;
      if (
        parent.isMemberExpression() &&
        !parent.node.computed &&
        t.isIdentifier(parent.node.property, { name: "prototype" })
      )
        return;

      reason = `constructor "${path.node.name}" escapes as a value`;
    },
  });

  return reason;
}

// function C(a) { this.x = a; }  ->  function C(a) { return { x: a }; }
//
// Falls back to a statement-by-statement form when the body is anything more
// than a run of distinct `this.<field> = <expr>` writes, so evaluation order is
// never rearranged just to build a literal.
function lowerConstructor(
  cls: ClassInfo,
  unique: (base: string) => string,
): DeclassifiedClass {
  const fn = cls.ctorFn;
  const body = fn.body.body;

  const props: t.ObjectProperty[] = [];
  const seen = new Set<string>();
  let allSimple = body.length > 0;

  for (const stmt of body) {
    if (!t.isExpressionStatement(stmt)) {
      allSimple = false;
      break;
    }
    const expr = stmt.expression;
    if (!t.isAssignmentExpression(expr) || expr.operator !== "=") {
      allSimple = false;
      break;
    }
    const left = expr.left;
    if (
      !t.isMemberExpression(left) ||
      left.computed ||
      !t.isThisExpression(left.object) ||
      !t.isIdentifier(left.property) ||
      seen.has(left.property.name) || // a second write to one field is ordered
      containsThis(expr.right) // reads its own half-built instance
    ) {
      allSimple = false;
      break;
    }
    seen.add(left.property.name);
    const prop = t.objectProperty(
      t.identifier(left.property.name),
      expr.right as t.Expression,
    );
    // Keep the field documentation attached to the field it documents.
    prop.leadingComments = stmt.leadingComments ?? null;
    props.push(prop);
  }

  let objectLiteral: t.ObjectExpression;
  if (allSimple) {
    objectLiteral = t.objectExpression(props);
    fn.body.body = [t.returnStatement(objectLiteral)];
  } else {
    const objName = unique("o");
    objectLiteral = t.objectExpression([]);
    replaceThisWith(fn, objName);
    fn.body.body = [
      t.variableDeclaration("var", [
        t.variableDeclarator(t.identifier(objName), objectLiteral),
      ]),
      ...body,
      t.returnStatement(t.identifier(objName)),
    ];
  }

  return { name: cls.name, ctorFn: fn, objectLiteral, fields: cls.fields };
}

// Short stand-in for `this`, derived from the class name so nothing here is
// tied to the runtime's current class list: VM -> vm, Upvalue -> up.
function pickSelfName(className: string, fns: t.Function[]): string {
  const used = new Set<string>();
  for (const fn of fns) for (const name of collectUsedNames(fn)) used.add(name);

  const base = (className.slice(0, 2) || "s").toLowerCase();
  let name = base;
  let counter = 2;
  while (used.has(name)) name = base + counter++;
  return name;
}

// Which declarations can sink into the run function: everything whose every
// reference already sits inside run, or inside another declaration that is
// itself sinking. Iterated to a fixed point, because the answer for one
// function depends on the answer for its callers.
function computeMovable(
  ast: t.File,
  runFn: t.FunctionDeclaration,
  byName: Map<string, DeclassifiedFn>,
): void {
  const declNodes = new Set<t.Node>();
  for (const entry of byName.values()) declNodes.add(entry.fn);

  const RUN = "\0run";
  const TOP = "";

  // container -> names it references
  const referencedBy = new Map<string, Set<string>>();
  const scan = (label: string, nodes: t.Node[]) => {
    const names = referencedBy.get(label) ?? new Set<string>();
    for (const node of nodes) {
      t.traverseFast(node, (n) => {
        if (t.isIdentifier(n) && byName.has(n.name)) names.add(n.name);
      });
    }
    referencedBy.set(label, names);
  };

  scan(
    RUN,
    runFn.body.body.filter((stmt) => !declNodes.has(stmt)),
  );
  for (const entry of byName.values()) {
    if (entry.fn === runFn) continue;
    scan(entry.name, entry.fn.body.body);
  }
  scan(
    TOP,
    ast.program.body.filter((stmt) => !declNodes.has(stmt)),
  );

  for (const entry of byName.values()) entry.moved = entry.fn !== runFn;

  let changed = true;
  while (changed) {
    changed = false;
    for (const [container, names] of referencedBy) {
      const containerStays =
        container !== RUN && !(byName.get(container)?.moved ?? false);
      if (!containerStays) continue;
      for (const name of names) {
        const target = byName.get(name);
        if (target?.moved) {
          target.moved = false;
          changed = true;
        }
      }
    }
  }
}

export function applyDeclassify(ast: t.File, compiler: Compiler): void {
  const bail = (reason: string) => {
    compiler.log(`declassify: ${reason}, skipping`);
  };

  const model = buildClassModel(ast);
  if (model.classes.size === 0) return bail("no constructor-shaped functions");

  const switchNode = getSwitchStatement(ast);
  if (!switchNode)
    return bail("no @SWITCH statement to anchor the run function");

  // The run function is the one holding the dispatch switch. It stays at the
  // top level (the boot section calls it) and becomes the home for everything
  // that sinks out of the top level.
  let runMethodName: string | null = null;
  for (const cls of model.classes.values()) {
    for (const [methodName, fnExpr] of cls.methods) {
      if (containsNode(fnExpr, switchNode)) runMethodName = methodName;
    }
  }
  if (!runMethodName)
    return bail("the @SWITCH statement is not inside a prototype method");

  const unsafe = findUnsafeReason(ast, model);
  if (unsafe) return bail(unsafe);

  // ── Nothing above this line mutates the AST ────────────────────────────
  const unique = makeUniqueNamer(collectUsedNames(ast));

  const classes: DeclassifiedClass[] = [];
  const byClassName = new Map<string, DeclassifiedClass>();
  for (const cls of model.classes.values()) {
    const lowered = lowerConstructor(cls, unique);
    classes.push(lowered);
    byClassName.set(cls.name, lowered);
  }

  const selfNames = new Map<string, string>();
  for (const cls of model.classes.values()) {
    selfNames.set(
      cls.name,
      pickSelfName(cls.name, [cls.ctorFn, ...cls.methods.values()]),
    );
  }

  // `Name.prototype.method = function (...)` -> `function Name_method(self, ...)`
  const fns: DeclassifiedFn[] = [];
  const byName = new Map<string, DeclassifiedFn>();
  const methodToFn = new Map<string, DeclassifiedFn>();
  const nextBody: t.Statement[] = [];
  let runFn: t.FunctionDeclaration | null = null;
  let runVmName = "";

  for (const stmt of ast.program.body) {
    const match = matchPrototypeMethod(stmt);
    const owner = match ? byClassName.get(match.className) : undefined;
    const known =
      match && model.classes.get(match.className)?.methods.get(match.methodName);
    if (!match || !owner || known !== match.fn) {
      nextBody.push(stmt);
      continue;
    }

    const selfName = selfNames.get(match.className)!;
    const fnName = unique(
      `${match.className}_${match.methodName.replace(/^_+/, "")}`,
    );
    const decl = t.functionDeclaration(
      t.identifier(fnName),
      [t.identifier(selfName), ...(match.fn.params as t.Identifier[])],
      match.fn.body,
    );
    decl.leadingComments = stmt.leadingComments ?? null;

    const entry: DeclassifiedFn = {
      name: fnName,
      fn: decl,
      selfName,
      owner,
      moved: false,
    };
    fns.push(entry);
    byName.set(fnName, entry);
    methodToFn.set(match.methodName, entry);
    nextBody.push(decl);

    if (match.methodName === runMethodName) {
      runFn = decl;
      runVmName = selfName;
    }
  }
  ast.program.body = nextBody;

  if (!runFn)
    return bail("lost track of the run function while extracting methods");

  // The factories join the same pool: from here on they are ordinary
  // functions, so parameter shuffling and relocation treat them alike.
  for (const cls of classes) {
    const entry: DeclassifiedFn = {
      name: cls.ctorFn.id!.name,
      fn: cls.ctorFn,
      selfName: null,
      owner: cls,
      moved: false,
    };
    fns.push(entry);
    byName.set(entry.name, entry);
  }

  // `new C(...)` -> `C(...)`. A factory returns an object, so `new` would
  // still work; dropping it is what removes the last constructor tell.
  traverse(ast, {
    NewExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !byClassName.has(callee.name)) return;
      path.replaceWith(
        t.callExpression(callee, path.node.arguments as t.Expression[]),
      );
    },
  });

  // `recv.method(args)` -> `Name_method(recv, args)`. Receiver-first keeps
  // evaluation order identical: the receiver was already the first thing
  // evaluated in a method call.
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed) return;
      if (!t.isIdentifier(callee.property)) return;
      const target = methodToFn.get(callee.property.name);
      if (!target) return;
      path.node.callee = t.identifier(target.name);
      path.node.arguments.unshift(callee.object as t.Expression);
    },
  });

  for (const entry of fns) {
    if (entry.selfName) replaceThisWith(entry.fn, entry.selfName);
  }

  // Sink everything the boot section doesn't name into the run function.
  computeMovable(ast, runFn, byName);
  const moved: t.FunctionDeclaration[] = [];
  ast.program.body = ast.program.body.filter((stmt) => {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id) return true;
    const entry = byName.get(stmt.id.name);
    if (!entry || !entry.moved || entry.fn !== stmt) return true;
    moved.push(stmt);
    return false;
  });
  runFn.body.body.unshift(...moved);

  const fields = new Set<string>();
  for (const cls of classes) for (const field of cls.fields) fields.add(field);

  compiler.declassify = {
    runFn,
    runFnName: runFn.id!.name,
    vmName: runVmName,
    classes,
    fns,
    fields,
  };

  compiler.log(
    `declassify: ${classes.length} classes lowered, ${fns.length} functions freed, ` +
      `${moved.length} hidden inside ${runFn.id!.name}()`,
  );
}
