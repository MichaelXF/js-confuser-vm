import { compileAndSerialize } from "./compiler.ts";

export function virtualize(source) {
  return compileAndSerialize(source);
}
