import { compileAndSerialize } from "./compiler.ts";
import type { Options } from "./options.ts";

async function obfuscate(source, options: Options = {}) {
  const result = compileAndSerialize(source, options);

  return result;
}

export const JsConfuserVM = {
  obfuscate,
};
export default JsConfuserVM;
