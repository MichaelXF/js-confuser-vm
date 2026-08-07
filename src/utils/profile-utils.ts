export function now() {
  return performance?.now() || Date.now();
}

export const getByteSize =
  typeof Buffer !== "undefined" && Buffer.byteLength
    ? (str) => Buffer.byteLength(str, "utf8")
    : (() => {
        const enc = new TextEncoder();
        return (str) => enc.encode(str).length;
      })();
