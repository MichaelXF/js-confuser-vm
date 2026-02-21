import * as t from "@babel/types";
import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { shuffle } from "./random.ts";
const traverse = traverseImport.default;

export function obfuscateRuntime(runtime: string): string {
  const ast = parse(runtime, {
    sourceType: "unambiguous",
  });

  // shuffle order of opcode handlers

  let switchStatement: t.SwitchStatement | null = null;
  traverse(ast, {
    SwitchStatement(path) {
      if (
        path.node.leadingComments?.some((comment) =>
          comment.value.includes("@SWITCH"),
        )
      ) {
        switchStatement = path.node;
        path.stop();
      }
    },
  });

  ok(switchStatement, "Could not find opcode handlers switch statement");

  // simply shuffle the order of the cases

  switchStatement.cases = shuffle(switchStatement.cases);

  const generated = generate(ast).code;

  return generated;
}
