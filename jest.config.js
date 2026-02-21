export default {
  extensionsToTreatAsEsm: [".ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "\\.ts$": "./jest-strip-types.js",
  },
};
