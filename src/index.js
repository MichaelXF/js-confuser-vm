import { compileAndSerialize } from "./compiler";

export function virtualize(source) {
  const output = compileAndSerialize(source);

  return {
    code: output,
  };
}
