export function alphabeticalGenerator(index: number) {
  let name = "";
  while (index > 0) {
    var t = (index - 1) % 52;
    var thisChar =
      t >= 26 ? String.fromCharCode(65 + t - 26) : String.fromCharCode(97 + t);
    name = thisChar + name;
    index = ((index - t) / 52) | 0;
  }
  if (!name) {
    name = "_";
  }
  return name;
}

export const RESERVED_WORDS = new Set([
  "if",
  "in",
  "do",
  "for",
  "let",
  "new",
  "try",
  "var",
  "case",
  "else",
  "null",
  "with",
  "break",
  "catch",
  "class",
  "const",
  "super",
  "throw",
  "while",
  "yield",
  "delete",
  "export",
  "import",
  "public",
  "return",
  "switch",
  "default",
  "finally",
  "private",
  "continue",
  "debugger",
  "function",
  "arguments",
  "protected",
  "instanceof",
  "await",
  "async",

  // new key words and other fun stuff :P
  "NaN",
  "undefined",
  "true",
  "false",
  "typeof",
  "this",
  "static",
  "void",
  "of",

  "undefined",
  "null",
  "NaN",
  "Infinity",
  "eval",
  "arguments",

  "toString",
  "valueOf",
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

// Returns a function that hands out successive short identifiers (a, b, ...,
// z, aa, ab, ...) from alphabeticalGenerator, skipping anything in
// RESERVED_WORDS or extraSkip. Each call returns a distinct name.
export function createNameGenerator(
  extraSkip: Iterable<string> = [],
): () => string {
  const skip = new Set<string>(RESERVED_WORDS);
  for (const name of extraSkip) skip.add(name);

  let index = 1;
  return function next(): string {
    let name: string;
    do {
      name = alphabeticalGenerator(index++);
    } while (skip.has(name));
    return name;
  };
}
