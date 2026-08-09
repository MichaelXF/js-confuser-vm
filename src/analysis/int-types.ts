// Integer type analysis for MBA
// ───────────────────────────────────────────────────────────────────────────
// Decides, per AST operation, whether it may be rewritten into int32 Mixed
// Boolean-Arithmetic.  Runs entirely OUTSIDE the Compiler: it consumes the
// parsed AST and produces a node → boolean map.  The bytecode pass joins that
// map back onto instructions through SOURCE_NODE_SYM, which the Compiler
// already stamps on every instruction it emits — so nothing here has to leak
// into compilation.
//
// ── Two tiers ────────────────────────────────────────────────────────────────
//
// Tier 0 — `& | ^` and `~`.  JavaScript SPECIFIES these to coerce their
//   operands with ToInt32 and produce an int32, whatever the operand types
//   were.  They need no analysis at all and are always eligible.
//
// Tier 1 — `+ - < > <= >= === !==` and unary `-`.  These are only eligible
//   when both operands are known to be integers, which is what the fixpoint
//   below establishes.  `+` in particular is string concatenation for
//   non-numbers, so the proof obligation is real.
//
// ── What the `mba` option does and does not waive ────────────────────────────
// The option promises that int32 WRAP-AROUND is acceptable, which removes the
// need for range analysis — `a + b` may be rewritten even when the sum would
// exceed 2^31.  It does NOT waive the obligation to prove the operands are
// integers in the first place, so that half is still analysed here.
//
// ── Why the fixpoint starts optimistic ───────────────────────────────────────
// Loop counters are circular: `var i = 0; i = i + 1;` is an integer only if
// `i` is already known to be one.  Starting every binding at `int` and
// demoting until stable resolves the cycle.  Demotion is monotone (int → any,
// never back), so it terminates in at most one pass per binding and the
// fixpoint is the correct answer rather than a guess.

import * as t from "@babel/types";
import traverseImport, { type NodePath, type Binding } from "@babel/traverse";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

/** Excludes a subtree from MBA entirely. */
const DIRECTIVE_NO_MBA = "@js-confuser-vm-no-mba";
/** Asserts a function's parameters are integers. */
const DIRECTIVE_INT = "@js-confuser-vm-int";

type VType = "int" | "any";

// Operators whose result is int32 by specification, regardless of input types.
const TIER0_BINARY = new Set(["&", "|", "^"]);
// Operators eligible once both operands are proven integral.
const TIER1_BINARY = new Set(["+", "-", "<", ">", "<=", ">=", "===", "!=="]);

// Operators that PRODUCE an integer, for the purposes of typing.  Note `*` is
// absent: an int32 product reaches 2^62, past the point where float64 holds
// integers exactly, so its low bits — the ones every MBA identity depends on —
// cannot be trusted without a range bound.
const INT_PRODUCING_BINARY = new Set(["&", "|", "^", "<<", ">>"]);
const INT_IF_BOTH_INT = new Set(["+", "-", "%"]);

// Compound assignments, split by what they imply about the result.
const INT_PRODUCING_ASSIGN = new Set(["&=", "|=", "^=", "<<=", ">>="]);
const INT_IF_RHS_INT_ASSIGN = new Set(["+=", "-=", "%="]);

export interface IntFacts {
  /**
   * True when this node's operation may be replaced by an int32 MBA
   * expression.  Nodes never seen by the analysis answer false, so a missing
   * entry always degrades to "leave it alone".
   */
  isMBASafe(node: t.Node): boolean;
  /** Diagnostic counts, surfaced by `verbose`. */
  stats: { tier0: number; tier1: number; rejected: number; excluded: number };
}

export const NO_INT_FACTS: IntFacts = {
  isMBASafe: () => false,
  stats: { tier0: 0, tier1: 0, rejected: 0, excluded: 0 },
};

export function analyzeIntTypes(ast: t.File): IntFacts {
  // ── Pass 1: index every node's path, and every node's source span ──────────
  // Paths are needed because resolving an Identifier's type means resolving its
  // binding, which needs the scope at that position.
  const pathOf = new Map<t.Node, NodePath>();
  const spans: { start: number; end: number; node: t.Node }[] = [];

  traverse(ast, {
    enter(path) {
      pathOf.set(path.node, path);
      const { start, end } = path.node;
      if (typeof start === "number" && typeof end === "number")
        spans.push({ start, end, node: path.node });
    },
  });

  // ── Pass 2: resolve comment directives to the subtrees they govern ─────────
  // Matching on offsets rather than `leadingComments` deliberately: Babel may
  // attach a comment as the PREVIOUS sibling's trailing comment instead, and
  // which one you get depends on surrounding whitespace.  A directive governs
  // the node that starts soonest after it; ties go to the outermost node, so
  // annotating a function covers its whole body.
  const excludedRanges: { start: number; end: number }[] = [];
  const forcedIntFns = new Set<t.Node>();

  const governedNode = (commentEnd: number): t.Node | null => {
    let best: { start: number; end: number; node: t.Node } | null = null;
    for (const s of spans) {
      if (s.start < commentEnd) continue;
      if (
        !best ||
        s.start < best.start ||
        (s.start === best.start && s.end > best.end)
      )
        best = s;
    }
    return best ? best.node : null;
  };

  for (const comment of ast.comments ?? []) {
    const end = (comment as { end?: number }).end;
    if (typeof end !== "number") continue;
    const isNoMBA = comment.value.includes(DIRECTIVE_NO_MBA);
    const isInt = comment.value.includes(DIRECTIVE_INT);
    if (!isNoMBA && !isInt) continue;

    const node = governedNode(end);
    if (!node) continue;
    if (isNoMBA) {
      excludedRanges.push({ start: node.start!, end: node.end! });
    } else if (t.isFunction(node) || t.isFunctionDeclaration(node)) {
      forcedIntFns.add(node);
    }
  }

  const isExcluded = (node: t.Node): boolean => {
    const { start, end } = node;
    if (typeof start !== "number" || typeof end !== "number") return false;
    return excludedRanges.some((r) => start >= r.start && end <= r.end);
  };

  // ── Pass 3: collect bindings ───────────────────────────────────────────────
  const bindings = new Set<Binding>();
  traverse(ast, {
    Scopable(path) {
      const table = path.scope.bindings;
      for (const name of Object.keys(table)) bindings.add(table[name]);
    },
  });

  // Optimistic seed.  A binding we can never reason about is pinned to `any`
  // up front so the fixpoint below never has to revisit it.
  const bindingType = new Map<Binding, VType>();
  for (const b of bindings) {
    let seed: VType = "int";
    if (b.kind === "param") {
      // Without call-site analysis a parameter could receive anything.  The
      // @js-confuser-vm-int directive is the way to assert otherwise — worth
      // having, because in small scripts most arithmetic lives inside
      // functions and this is where the analysis would otherwise give up.
      const fnNode = b.scope.path.node;
      if (!forcedIntFns.has(fnNode)) seed = "any";
    } else if (!b.path.isVariableDeclarator()) {
      // Function/class declarations, catch params, imports — not integers.
      seed = "any";
    }
    bindingType.set(b, seed);
  }

  // ── Expression typing ──────────────────────────────────────────────────────
  const typeOf = (node: t.Node | null | undefined): VType => {
    if (!node) return "any";

    switch (node.type) {
      case "NumericLiteral": {
        const v = node.value;
        return Number.isInteger(v) && Math.abs(v) <= 2147483648 ? "int" : "any";
      }

      case "Identifier": {
        const path = pathOf.get(node);
        if (!path) return "any";
        const binding = path.scope.getBinding(node.name);
        if (!binding || !bindings.has(binding)) return "any";
        return bindingType.get(binding) ?? "any";
      }

      case "UnaryExpression":
        if (node.operator === "~") return "int";
        if (node.operator === "-" || node.operator === "+")
          return typeOf(node.argument);
        return "any";

      case "BinaryExpression": {
        if (INT_PRODUCING_BINARY.has(node.operator)) return "int";
        // `>>>` yields uint32, which differs from int32 above 2^31 — the one
        // operator where the two domains genuinely disagree.
        if (INT_IF_BOTH_INT.has(node.operator))
          return typeOf(node.left) === "int" && typeOf(node.right) === "int"
            ? "int"
            : "any";
        return "any";
      }

      case "UpdateExpression":
        return typeOf(node.argument);

      case "AssignmentExpression": {
        if (node.operator === "=") return typeOf(node.right);
        if (INT_PRODUCING_ASSIGN.has(node.operator)) return "int";
        if (INT_IF_RHS_INT_ASSIGN.has(node.operator))
          return typeOf(node.left) === "int" && typeOf(node.right) === "int"
            ? "int"
            : "any";
        return "any";
      }

      case "ConditionalExpression":
        return typeOf(node.consequent) === "int" &&
          typeOf(node.alternate) === "int"
          ? "int"
          : "any";

      case "SequenceExpression":
        return typeOf(node.expressions[node.expressions.length - 1]);

      case "ParenthesizedExpression":
        return typeOf(node.expression);

      case "MemberExpression":
        // `.length` is the one property read worth trusting; it is what makes
        // ordinary `for (i = 0; i < xs.length; i++)` loops analysable.
        return !node.computed &&
          t.isIdentifier(node.property, { name: "length" })
          ? "int"
          : "any";

      default:
        return "any";
    }
  };

  // What a single write to a binding implies about that binding's type.
  const writeType = (path: NodePath): VType => {
    const node = path.node;
    if (t.isAssignmentExpression(node)) {
      if (node.operator === "=") return typeOf(node.right);
      if (INT_PRODUCING_ASSIGN.has(node.operator)) return "int";
      if (INT_IF_RHS_INT_ASSIGN.has(node.operator)) return typeOf(node.right);
      return "any";
    }
    // `i++` / `--i` keep an integer an integer.
    if (t.isUpdateExpression(node)) return "int";
    // for-in binds strings; for-of and destructuring bind anything.
    return "any";
  };

  // ── Pass 4: fixpoint ───────────────────────────────────────────────────────
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of bindings) {
      if (bindingType.get(b) !== "int") continue;

      let ok = true;
      if (b.path.isVariableDeclarator()) {
        const init = (b.path.node as t.VariableDeclarator).init;
        // A declarator with no initialiser is fine on its own — the writes
        // below decide the type.
        if (init && typeOf(init) === "any") ok = false;
      }
      if (ok) {
        for (const violation of b.constantViolations) {
          if (writeType(violation) === "any") {
            ok = false;
            break;
          }
        }
      }

      if (!ok) {
        bindingType.set(b, "any");
        changed = true;
      }
    }
  }

  // ── Pass 5: mark operations ────────────────────────────────────────────────
  const facts = new WeakMap<t.Node, boolean>();
  const stats = { tier0: 0, tier1: 0, rejected: 0, excluded: 0 };

  const mark = (node: t.Node, tier: 0 | 1, eligible: boolean) => {
    if (isExcluded(node)) {
      stats.excluded++;
      facts.set(node, false);
      return;
    }
    facts.set(node, eligible);
    if (!eligible) stats.rejected++;
    else if (tier === 0) stats.tier0++;
    else stats.tier1++;
  };

  traverse(ast, {
    BinaryExpression(path) {
      const op = path.node.operator;
      if (TIER0_BINARY.has(op)) return mark(path.node, 0, true);
      if (TIER1_BINARY.has(op))
        return mark(
          path.node,
          1,
          typeOf(path.node.left) === "int" && typeOf(path.node.right) === "int",
        );
    },

    UnaryExpression(path) {
      const op = path.node.operator;
      if (op === "~") return mark(path.node, 0, true);
      if (op === "-")
        return mark(path.node, 1, typeOf(path.node.argument) === "int");
    },

    // `i++` and `x += n` compile to the same ADD/SUB opcodes and carry their
    // own node, so they are eligible on the same terms.
    UpdateExpression(path) {
      mark(path.node, 1, typeOf(path.node.argument) === "int");
    },

    AssignmentExpression(path) {
      const op = path.node.operator;
      if (op !== "+=" && op !== "-=") return;
      mark(
        path.node,
        1,
        typeOf(path.node.left) === "int" && typeOf(path.node.right) === "int",
      );
    },
  });

  return {
    isMBASafe: (node: t.Node) => facts.get(node) === true,
    stats,
  };
}
