export function evalCode(code) {
  var window = {
    TEST_OUTPUT: null,
  };
  window.window = window; // Ensure 'window' is available in the global scope for the eval
  eval(code);

  return window.TEST_OUTPUT;
}
