import * as t from "@babel/types";
import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import traverseImport from "@babel/traverse";
import { ok } from "assert";
import { shuffle } from "./random.ts";
import type { Options } from "./options.ts";
import { minify } from "./minify.ts";
const traverse = (traverseImport.default ||
  traverseImport) as typeof traverseImport.default;

export async function obfuscateRuntime(runtime: string, options: Options) {
  let ast: t.File;
  try {
    ast = parse(runtime, {
      sourceType: "unambiguous",
    });
  } catch (error) {
    throw new Error("VM-Runtime final parsing failed", { cause: error });
  }

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

  let generated: string;
  try {
    generated = generate(ast).code;
  } catch (error) {
    throw new Error("VM-Runtime final generation failed", { cause: error });
  }

  if (options.minify) {
    try {
      generated = await minify(generated);
    } catch (error) {
      throw new Error("VM-Runtime final minification failed", { cause: error });
    }
  }

  return generated;
}
