import { compileAndSerialize } from "./compiler.ts";
import type { Options } from "./options.ts";
import { DEFAULT_OPTIONS } from "./options.ts";
import { disassembleCommentBlock } from "./disassembler.ts";

async function obfuscate(source, options: Options = DEFAULT_OPTIONS) {
  const result = compileAndSerialize(source, options);

  return result;
}

async function disassemble(bytecodeComments: string) {
  return disassembleCommentBlock(bytecodeComments);
}

export const JsConfuserVM = {
  obfuscate,
  disassemble,
};
export default JsConfuserVM;
