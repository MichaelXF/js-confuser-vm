import JsConfuserVM from "../src";

export async function obfuscate(source, overrideOptions) {
  const options = overrideOptions ?? global.VM_OPTIONS ?? {};
  return JsConfuserVM.obfuscate(source, options);
}

export async function evalCode(code, windowProperties = {}) {
  var window = { TEST_OUTPUT: null, ...windowProperties };
  window.window = window;
  eval(code);

  return window.TEST_OUTPUT;
}
