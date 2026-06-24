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
import { applyAntiInstrumentation } from "./transforms/runtime/antiInstrumentation.ts";
import { applyClassObfuscation } from "./transforms/runtime/classObfuscation.ts";
import type * as b from "./types.ts";
import { getSwitchStatement } from "./utils/ast-utils.ts";
import { now } from "./utils/profile-utils.ts";

export async function buildRuntime(
  runtime: string,
  bytecode: b.Bytecode,
  options: Options,
  compiler: Compiler,
  generateBytecodeComment: () => string,
) {
  let ast: t.File;
  try {
    ast = parse(runtime, { sourceType: "unambiguous" });
  } catch (error) {
    throw new Error("VM-Runtime final parsing failed", { cause: error });
  }

  const switchStatement = getSwitchStatement(ast);
  const getHandlerCount = () => {
    return switchStatement.cases.length;
  };

  const timings: { [name: string]: number } = {};
  function runAndTime(pass: typeof applySpecializedOpcodes, name: string) {
    const startedAt = now();

    compiler.log(`Running runtime pass ${name}...`);

    pass(ast, compiler);

    const endedAt = now();
    const elapsedMs = endedAt - startedAt;
    timings[name] = elapsedMs;

    compiler.profileData.transforms[name] = {
      fileSize: null, // TODO: Add option as doing 'generate(ast).code.length' is slow
      transformTime: elapsedMs,
      handlerCount: getHandlerCount(),
    };

    compiler.log(
      `Runtime pass ${name} completed in ${Math.floor(elapsedMs)}ms`,
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

  // Anti-instrumentation cases must be applied BEFORE shuffleOpcodes
  if (options.antiInstrumentation) {
    runAndTime(applyAntiInstrumentation, "applyAntiInstrumentation");
  }

  // Shuffle opcode handle order
  if (options.shuffleOpcodes) {
    runAndTime(applyShuffleOpcodes, "applyShuffleOpcodes");
  }

  // Shuffle top-level var declarations and prototype method definitions
  if (options.classObfuscation) {
    runAndTime(applyClassObfuscation, "applyClassObfuscation");
  }

  compiler.profileData.handlerCount = getHandlerCount();

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
      let startedAt = now();
      compiler.log("Running minify...");
      generated = await applyMinify(generated);
      let elapsedMs = now() - startedAt;
      compiler.log(`Minify completed in ${Math.floor(elapsedMs)}ms`);

      compiler.profileData.transforms["minify"] = {
        transformTime: elapsedMs,
      };
    } catch (error) {
      throw new Error("VM-Runtime final minification failed", { cause: error });
    }
  }

  return generated;
}
