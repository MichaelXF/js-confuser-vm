import JsConfuserVM from "../src";

/**
 *
 * @param {string} source
 * @param {Parameters<import('../src/index.ts')["default"]["obfuscate"]>[1]} overrideOptions
 * @returns
 */
export async function obfuscate(source, overrideOptions) {
  const options = overrideOptions ?? global.VM_OPTIONS ?? {};
  return JsConfuserVM.obfuscate(source, options);
}

// eval()s in non-strict mode (This file is JavaScript, unlike JS-Confuser's version of this)
export async function evalCode(code, windowProperties = {}) {
  var window = { TEST_OUTPUT: null, ...windowProperties };
  window.window = window;
  eval(code);

  return window.TEST_OUTPUT;
}
