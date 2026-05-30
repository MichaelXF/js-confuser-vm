import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import type { Options } from "./options.ts";
import { applyMacroOpcodes } from "./transforms/runtime/macroOpcodes.ts";
import { applyShuffleOpcodes } from "./transforms/runtime/shuffleOpcodes.ts";
import { applyMinify } from "./transforms/runtime/minify.ts";
import { Compiler } from "./compiler.ts";
import { applySpecializedOpcodes } from "./transforms/runtime/specializedOpcodes.ts";
import { applyAliasedOpcodes } from "./transforms/runtime/aliasedOpcodes.ts";
import { applyClassObfuscation } from "./transforms/runtime/classObfuscation.ts";
import type * as b from "./types.ts";

export async function obfuscateRuntime(
  runtime: string,
  bytecode: b.Bytecode,
  options: Options,
  compiler: Compiler,
  generateBytecodeComment,
) {
  let ast: t.File;
  try {
    ast = parse(runtime, { sourceType: "unambiguous" });
  } catch (error) {
    throw new Error("VM-Runtime final parsing failed", { cause: error });
  }

  const timings: { [name: string]: number } = {};
  function runAndTime(pass: typeof applySpecializedOpcodes, name: string) {
    const startedAt = performance.now();

    compiler.log(`Running runtime pass ${name}...`);

    pass(ast, compiler);

    const endedAt = performance.now();
    const elaspedMs = endedAt - startedAt;
    timings[name] = elaspedMs;

    compiler.log(
      `Runtime pass ${name} completed in ${Math.floor(elaspedMs)}ms`,
    );
  }

  // Specialized opcode cases must be applied BEFORE shuffleOpcodes
  if (options.specializedOpcodes) {
    runAndTime(applySpecializedOpcodes, "applySpecializedOpcodes");
  }

  // Macro opcode cases must be applied BEFORE shuffleOpcodes
  if (options.macroOpcodes && Object.keys(compiler.MACRO_OPS).length > 0) {
    runAndTime(applyMacroOpcodes, "applyMacroOpcodes");
  }

  // Aliased opcode cases must be applied BEFORE shuffleOpcodes
  if (options.aliasedOpcodes) {
    runAndTime(applyAliasedOpcodes, "applyAliasedOpcodes");
  }

  // Shuffle opcode handle order
  if (options.shuffleOpcodes) {
    runAndTime(applyShuffleOpcodes, "applyShuffleOpcodes");
  }

  // Shuffle top-level var declarations and prototype method definitions
  if (options.classObfuscation) {
    runAndTime(applyClassObfuscation, "applyClassObfuscation");
  }

  let generated: string;
  try {
    generated = generate(ast).code;
  } catch (error) {
    throw new Error("VM-Runtime final generation failed", { cause: error });
  }

  // Add comment here for more accurate opcode names
  generated = generateBytecodeComment() + "\n" + generated;

  // Minify code?
  if (options.minify) {
    try {
      let startedAt = performance.now();
      compiler.log("Running minify...");
      generated = await applyMinify(generated);
      let elaspedMs = performance.now() - startedAt;
      compiler.log(`Minify completed in ${Math.floor(elaspedMs)}`);
    } catch (error) {
      throw new Error("VM-Runtime final minification failed", { cause: error });
    }
  }

  return generated;
}
