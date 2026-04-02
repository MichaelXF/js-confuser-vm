// Goes through the switch case for defined identifiers on the statement level
// Example:
// case OP.LOAD_CONST: {
//   var dst = this._operand();
//   frame.regs[dst] = this._constant();
//   break;
// }
// You find "dst" is defined in this scope.
// You first check the compiler to see if it's already assigned an index in compiler._internals mapping varName=>index
// If not found, use compiler._internals.globally.size as the new index (when options.randomizeOpcodes is off, when on, choose random between 0 and 65535), and add varName=>index to compiler._internals
// Then replace the VariableDeclaration to an AssignmentExpression setting left this._internals[index] = init;
// Then replace all identifiers of "dst" to this._internals[index] as well (Updates references)
// Final output:
// case OP.LOAD_CONST: {
//   this._internals[index] = this._operand();
//   frame.regs[this._internals[index]] = this._constant();
//   break;
// }

import { Compiler } from "../../compiler.ts";
import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { getRandomInt } from "../../utils/random-utils.ts";
import { U16_MAX } from "../../utils/op-utils.ts";

const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

export function makeInternalsAccess(index: number): t.MemberExpression {
  return t.memberExpression(
    t.memberExpression(t.thisExpression(), t.identifier("_internals")),
    t.numericLiteral(index),
    true, // computed
  );
}

function collectUsedIndices(compiler: Compiler): Set<number> {
  const used = new Set<number>();
  for (const v of compiler._internals.globally.values()) used.add(v);
  for (const opMap of compiler._internals.opcodes.values()) {
    for (const v of opMap.values()) used.add(v);
  }
  return used;
}

// Assign or look up the _internals slot index for a variable name within a
// specific opcode handler.
//
// _internals.opcodes[currentOpcode] is the source of truth for this opcode.
// _internals.globally holds the shared pool written on first sight.
//
// randomizeOpcodes OFF → always reuse / create in globally, mirror to opcodes.
// randomizeOpcodes ON  → first time a name is seen: create global slot.
//                        subsequent opcodes: 50% reuse global, 50% create an
//                        opcode-specific random slot (NOT written to globally).
function assignInternalsIndex(
  name: string,
  compiler: Compiler,
  currentOpcode: number,
): number {
  // Ensure per-opcode map exists
  let opcodeMap = compiler._internals.opcodes.get(currentOpcode);
  if (!opcodeMap) {
    opcodeMap = new Map();
    compiler._internals.opcodes.set(currentOpcode, opcodeMap);
  }

  // Already registered for this opcode — return immediately
  const existing = opcodeMap.get(name);
  if (existing !== undefined) return existing;

  const globalIndex = compiler._internals.globally.get(name);
  let index: number;

  if (!compiler.options.randomizeOpcodes) {
    // Non-random: always share the global sequential slot
    if (globalIndex === undefined) {
      index = compiler._internals.globally.size;
      compiler._internals.globally.set(name, index);
    } else {
      index = globalIndex;
    }
  } else if (globalIndex === undefined) {
    // First opcode to declare this variable — establish the global slot
    const used = collectUsedIndices(compiler);
    let candidate: number;
    do {
      candidate = getRandomInt(0, U16_MAX);
    } while (used.has(candidate));
    index = candidate;
    compiler._internals.globally.set(name, index);
  } else {
    // Already in global: 50% chance to reuse, 50% opcode-specific new slot
    if (Math.random() < 0.5) {
      index = globalIndex;
    } else {
      const used = collectUsedIndices(compiler);
      let candidate: number;
      do {
        candidate = getRandomInt(0, U16_MAX);
      } while (used.has(candidate));
      index = candidate;
      // Intentionally NOT written to globally — this slot is opcode-specific
    }
  }

  opcodeMap.set(name, index);
  return index;
}

export function applyInternalVariablesToSwitchCase(
  node: t.SwitchCase,
  compiler: Compiler,
  currentOpcode: number,
) {
  // Work with the actual body array (block body or flat consequent)
  let bodyArr: t.Statement[];
  if (node.consequent.length === 1 && t.isBlockStatement(node.consequent[0])) {
    bodyArr = (node.consequent[0] as t.BlockStatement).body;
  } else {
    bodyArr = node.consequent as t.Statement[];
  }

  // Single traversal: declarations and references handled in one pass.
  //
  // Declaration (Identifier is VariableDeclarator.id):
  //   → register/look-up slot, replace entire VariableDeclaration with
  //     AssignmentExpression (bare for ForStatement.init, else ExpressionStatement).
  //
  // Reference (any other Identifier):
  //   → look up opcodes[currentOpcode] (source of truth) and replace if found.
  //     This handles cross-statement refs produced by micro-opcode splitting.
  const syntheticFile = t.file(t.program(bodyArr as t.Statement[]));
  const illegalNames = new Set<string>(); // Nested closure names are skipped

  traverse(syntheticFile, {
    Identifier(path) {
      const name = path.node.name;
      if (illegalNames.has(name)) return;

      // Skip non-computed property names: obj.name
      if (
        t.isMemberExpression(path.parent) &&
        !path.parent.computed &&
        path.parent.property === path.node
      ) {
        return;
      }

      // Skip non-computed object-property keys: { name: value }
      if (
        t.isObjectProperty(path.parent) &&
        !path.parent.computed &&
        path.parent.key === path.node
      ) {
        return;
      }

      // Don't descend into nested function scopes
      if (
        path.find(
          (p) =>
            p.isFunctionDeclaration() ||
            p.isFunctionExpression() ||
            p.isArrowFunctionExpression(),
        )
      ) {
        return;
      }

      // ── Declaration binding ──────────────────────────────────────────────
      if (t.isVariableDeclarator(path.parent) && path.parent.id === path.node) {
        // Verify it's not referenced in nested closure (illegal)
        const binding = path.scope.getBinding(name);
        if (
          binding?.referencePaths.some((rp) =>
            rp.findParent(
              (p) =>
                p.isFunctionDeclaration() ||
                p.isFunctionExpression() ||
                p.isArrowFunctionExpression(),
            ),
          )
        ) {
          illegalNames.add(name);
          return;
        }

        const index = assignInternalsIndex(name, compiler, currentOpcode);
        const init = (path.parent as t.VariableDeclarator).init;

        const assignment = t.assignmentExpression(
          "=",
          makeInternalsAccess(index),
          init ?? t.identifier("undefined"),
        );

        // Two levels up: VariableDeclarator → VariableDeclaration
        const varDeclPath = path.parentPath!.parentPath!;

        if (
          t.isForStatement(varDeclPath.parent) &&
          varDeclPath.parent.init === varDeclPath.node
        ) {
          // ForStatement.init accepts an Expression directly
          varDeclPath.replaceWith(assignment);
        } else {
          varDeclPath.replaceWith(t.expressionStatement(assignment));
        }
        return;
      }

      // ── Reference ───────────────────────────────────────────────────────
      // Source of truth for this opcode is its own per-opcode map
      const opcodeMap = compiler._internals.opcodes.get(currentOpcode);
      const index = opcodeMap?.get(name);
      if (index !== undefined) {
        path.replaceWith(makeInternalsAccess(index));
        path.skip();
      }
    },
  });
}

// This takes the AST and finds the runtime switch statement via the leading
// comment "@SWITCH" then applies the above transformation to each switch case.
export function applyInteralVariablesToRuntime(
  ast: t.File,
  compiler: Compiler,
) {
  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(
    switchStatement,
    "Could not find @SWITCH statement for internal variables",
  );

  for (const sc of (switchStatement as t.SwitchStatement).cases) {
    const test = sc.test;
    let currentOpcode: number | null = null;

    if (
      test &&
      t.isMemberExpression(test) &&
      t.isIdentifier(test.object, { name: "OP" }) &&
      t.isIdentifier(test.property)
    ) {
      // case OP.LOAD_CONST: → resolve via compiler.OP
      const opName = (test.property as t.Identifier).name;
      const val = compiler.OP[opName as keyof typeof compiler.OP];
      if (val !== undefined) currentOpcode = val as number;
    } else if (test && t.isNumericLiteral(test)) {
      // Already a numeric literal (e.g. generated micro-opcode cases)
      currentOpcode = test.value;
    }

    if (currentOpcode === null) continue;

    applyInternalVariablesToSwitchCase(sc, compiler, currentOpcode);
  }
}
