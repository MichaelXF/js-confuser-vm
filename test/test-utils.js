import JsConfuserVM from "../src";

export async function obfuscate(source) {
  const options = global.VM_OPTIONS ?? {};
  return JsConfuserVM.obfuscate(source, options);
}

export function evalCode(code) {
  var window = {
    TEST_OUTPUT: null,
  };
  window.window = window; // Ensure 'window' is available in the global scope for the eval
  eval(code);

  return window.TEST_OUTPUT;
}
