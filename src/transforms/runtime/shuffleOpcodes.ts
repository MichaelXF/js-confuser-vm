import * as t from "@babel/types";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { shuffle } from "../utils/random-utils.ts";
const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

// Randomly reorder the switch cases inside the @SWITCH statement so the
// opcode handler order varies per build.
export function applyShuffleOpcodes(ast: t.File): void {
  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (path.node.leadingComments?.some((c) => c.value.includes("@SWITCH"))) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(switchStatement, "Could not find opcode handlers switch statement");

  switchStatement.cases = shuffle(switchStatement.cases);
}
