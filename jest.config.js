const OPTIONS_MATRIX = [
  { displayName: "default", VM_OPTIONS: {} },
  { displayName: "randomizeOpcodes", VM_OPTIONS: { randomizeOpcodes: true } },
  { displayName: "shuffleOpcodes", VM_OPTIONS: { shuffleOpcodes: true } },
  { displayName: "encodeBytecode", VM_OPTIONS: { encodeBytecode: true } },
  { displayName: "selfModifying", VM_OPTIONS: { selfModifying: true } },
  { displayName: "timingChecks", VM_OPTIONS: { timingChecks: true } },
  { displayName: "macroOpcodes", VM_OPTIONS: { macroOpcodes: true } },
  { displayName: "microOpcodes", VM_OPTIONS: { microOpcodes: true } },
  {
    displayName: "specializedOpcodes",
    VM_OPTIONS: { specializedOpcodes: true },
  },
  {
    displayName: "aliasedOpcodes",
    VM_OPTIONS: { aliasedOpcodes: true },
  },
  {
    displayName: "concealConstants",
    VM_OPTIONS: { concealConstants: true },
  },
  {
    displayName: "all",
    VM_OPTIONS: {
      randomizeOpcodes: true,
      shuffleOpcodes: true,
      encodeBytecode: true,
      selfModifying: true,
      timingChecks: true,
      macroOpcodes: true,
      microOpcodes: true,
      specializedOpcodes: true,
      aliasedOpcodes: true,
      concealConstants: true,
    },
  },
];

export default {
  projects: OPTIONS_MATRIX.map(({ displayName, VM_OPTIONS }) => ({
    displayName,
    extensionsToTreatAsEsm: [".ts"],
    moduleFileExtensions: ["ts", "js", "json"],
    transform: { "\\.ts$": "./jest-strip-types.js" },
    globals: { VM_OPTIONS },
  })),
};
