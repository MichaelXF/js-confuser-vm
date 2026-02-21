const OPTIONS_MATRIX = [
  { displayName: "default", VM_OPTIONS: {} },
  { displayName: "randomizeOpcodes", VM_OPTIONS: { randomizeOpcodes: true } },
  { displayName: "shuffleOpcodes", VM_OPTIONS: { shuffleOpcodes: true } },
  { displayName: "encodeBytecode", VM_OPTIONS: { encodeBytecode: true } },
  { displayName: "selfModifying", VM_OPTIONS: { selfModifying: true } },
  { displayName: "timingChecks", VM_OPTIONS: { timingChecks: true } },
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
