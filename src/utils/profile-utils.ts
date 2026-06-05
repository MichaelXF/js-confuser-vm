export function now() {
  return performance?.now() || Date.now();
}
