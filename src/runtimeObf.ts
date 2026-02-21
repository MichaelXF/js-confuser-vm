import * as t from "@babel/types";
import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { choice, shuffle } from "./random.ts";
import type { Options } from "./options.ts";
import { escapeRegex } from "./utilts.ts";
import { minify } from "./minify.ts";
const traverse = traverseImport.default;

export async function obfuscateRuntime(runtime: string, options: Options) {
  const ast = parse(runtime, {
    sourceType: "unambiguous",
  });

  // shuffle order of opcode handlers

  if (options.shuffleOpcodes) {
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
  }

  let generated = generate(ast).code;

  if (options.minify) {
    generated = await minify(generated);
  }

  return generated;
}
