import { generate } from "@babel/generator";
import { parse, type ParseResult } from "@babel/parser";
import type * as t from "@babel/types";
import type { Options } from "./options.ts";
import { applyMacroOpcodes } from "./transforms/runtime/macroOpcodes.ts";
import { applyShuffleOpcodes } from "./transforms/runtime/shuffleOpcodes.ts";
import { applyMinify } from "./transforms/runtime/minify.ts";
import { Compiler } from "./compiler.ts";
import { applySpecializedOpcodes } from "./transforms/runtime/specializedOpcodes.ts";
import { applyAliasedOpcodes } from "./transforms/runtime/aliasedOpcodes.ts";
import type * as b from "./types.ts";

export async function obfuscateRuntime(
  runtime: string,
  bytecode: b.Bytecode,
  options: Options,
  compiler?: Compiler,
) {
  let ast: t.File;
  try {
    ast = parse(runtime, { sourceType: "unambiguous" });
  } catch (error) {
    throw new Error("VM-Runtime final parsing failed", { cause: error });
  }

  // Specialized opcode cases must be applied BEFORE shuffleOpcodes
  if (options.specializedOpcodes) {
    applySpecializedOpcodes(ast, bytecode, compiler);
  }

  // Macro opcode cases must be applied BEFORE shuffleOpcodes
  if (options.macroOpcodes && Object.keys(compiler.MACRO_OPS).length > 0) {
    applyMacroOpcodes(ast, compiler);
  }

  // Aliased opcode cases must be applied BEFORE shuffleOpcodes
  if (options.aliasedOpcodes) {
    applyAliasedOpcodes(ast, compiler);
  }

  // Shuffle opcode handle order
  if (options.shuffleOpcodes) {
    applyShuffleOpcodes(ast);
  }

  let generated: string;
  try {
    generated = generate(ast).code;
  } catch (error) {
    throw new Error("VM-Runtime final generation failed", { cause: error });
  }

  // Minify code?
  if (options.minify) {
    try {
      generated = await applyMinify(generated);
    } catch (error) {
      throw new Error("VM-Runtime final minification failed", { cause: error });
    }
  }

  return generated;
}
