import { obfuscate, evalCode } from "../test-utils";

// ── For..Of ───────────────────────────────────────────────────────

test("Variant #1: For-of — array elements in order", async () => {
  const { code } = await obfuscate(`
    var out = [];
    for (var x of [1, 2, 3]) {
      out.push(x);
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1,2,3");
});

test("Variant #2: For-of — string iterates by code point", async () => {
  const { code } = await obfuscate(`
    var out = "";
    for (var c of "abc") {
      out += c + ".";
    }
    window.TEST_OUTPUT = out;
  `);

  expect(await evalCode(code)).toBe("a.b.c.");
});

test("Variant #3: For-of — empty iterable produces no iterations", async () => {
  const { code } = await obfuscate(`
    var count = 0;
    for (var x of []) {
      count++;
    }
    window.TEST_OUTPUT = count;
  `);

  expect(await evalCode(code)).toBe(0);
});

test("Variant #4: For-of — const declaration", async () => {
  const { code } = await obfuscate(`
    var sum = 0;
    for (const n of [10, 20, 30]) {
      sum += n;
    }
    window.TEST_OUTPUT = sum;
  `);

  expect(await evalCode(code)).toBe(60);
});

test("Variant #5: For-of — body without a block", async () => {
  const { code } = await obfuscate(`
    var sum = 0;
    for (var x of [1, 2, 3]) sum += x;
    window.TEST_OUTPUT = sum;
  `);

  expect(await evalCode(code)).toBe(6);
});

test("Variant #6: For-of — break exits the loop", async () => {
  const { code } = await obfuscate(`
    var out = [];
    for (var x of [1, 2, 3, 4]) {
      if (x === 3) break;
      out.push(x);
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1,2");
});

test("Variant #7: For-of — continue advances the iterator", async () => {
  const { code } = await obfuscate(`
    var out = [];
    for (var x of [1, 2, 3, 4]) {
      if (x % 2) continue;
      out.push(x);
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("2,4");
});

test("Variant #8: For-of — labeled continue targets the outer loop", async () => {
  const { code } = await obfuscate(`
    var out = [];
    outer: for (var a of [1, 2]) {
      for (var b of [1, 2]) {
        if (b === 2) continue outer;
        out.push(a + "-" + b);
      }
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1-1,2-1");
});

test("Variant #9: For-of — labeled break exits the outer loop", async () => {
  const { code } = await obfuscate(`
    var out = [];
    outer: for (var a of [1, 2, 3]) {
      for (var b of [1, 2]) {
        if (a === 2) break outer;
        out.push(a + ":" + b);
      }
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1:1,1:2");
});

test("Variant #10: For-of — assigns to an already-declared variable", async () => {
  const { code } = await obfuscate(`
    var out = [], x;
    for (x of [7, 8]) {
      out.push(x);
    }
    window.TEST_OUTPUT = out.join(",") + "|" + x;
  `);

  expect(await evalCode(code)).toBe("7,8|8");
});

test("Variant #11: For-of — assigns to a member expression", async () => {
  const { code } = await obfuscate(`
    var target = {};
    var out = [];
    for (target.k of [5, 6]) {
      out.push(target.k);
    }
    window.TEST_OUTPUT = out.join(",") + "|" + target.k;
  `);

  expect(await evalCode(code)).toBe("5,6|6");
});

test("Variant #12: For-of — Map yields entry pairs", async () => {
  const { code } = await obfuscate(`
    var m = new Map([["a", 1], ["b", 2]]);
    var out = [];
    for (var entry of m) {
      out.push(entry[0] + entry[1]);
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("a1,b2");
});

test("Variant #13: For-of — Set de-duplicates", async () => {
  const { code } = await obfuscate(`
    var out = [];
    for (var v of new Set([1, 1, 2])) {
      out.push(v);
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1,2");
});

test("Variant #14: For-of — a custom @@iterator is honored", async () => {
  const { code } = await obfuscate(`
    var counter = 0;
    var iterable = {};
    iterable[Symbol.iterator] = function () {
      var i = 0;
      return {
        next: function () {
          counter++;
          if (i < 3) return { value: i++, done: false };
          return { value: undefined, done: true };
        }
      };
    };
    var out = [];
    for (var v of iterable) {
      out.push(v);
    }
    window.TEST_OUTPUT = out.join(",") + "|" + counter;
  `);

  expect(await evalCode(code)).toBe("0,1,2|4");
});

test("Variant #15: For-of — return from inside the loop", async () => {
  const { code } = await obfuscate(`
    function find() {
      for (var x of [1, 2, 3]) {
        if (x === 2) return "got" + x;
      }
      return "none";
    }
    window.TEST_OUTPUT = find();
  `);

  expect(await evalCode(code)).toBe("got2");
});

test("Variant #16: For-of — a throw inside the loop reaches the catch", async () => {
  const { code } = await obfuscate(`
    var out = [];
    try {
      for (var x of [1, 2, 3]) {
        if (x === 2) throw new Error("stop");
        out.push(x);
      }
    } catch (e) {
      out.push("caught");
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1,caught");
});

test("Variant #17: For-of — nested loops over the same array", async () => {
  const { code } = await obfuscate(`
    var out = [];
    for (var a of [1, 2]) {
      for (var b of [1, 2]) {
        out.push(a * 10 + b);
      }
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("11,12,21,22");
});

test("Variant #18: For-of — iterating a live array reflects mutation", async () => {
  const { code } = await obfuscate(`
    var arr = [1, 2];
    var out = [];
    for (var x of arr) {
      out.push(x);
      if (x === 1) arr.push(3);
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("1,2,3");
});

test("Variant #19: For-of — a non-iterable value throws a TypeError", async () => {
  const { code } = await obfuscate(`
    var message = "no throw";
    try {
      for (var x of 42) {}
    } catch (e) {
      message = e instanceof TypeError ? "TypeError" : "other";
    }
    window.TEST_OUTPUT = message;
  `);

  expect(await evalCode(code)).toBe("TypeError");
});

test("Variant #20: For-of — the iterator variable survives the loop body's calls", async () => {
  const { code } = await obfuscate(`
    function double(n) { return n * 2; }
    var out = [];
    for (var x of [1, 2, 3]) {
      out.push(double(x));
    }
    window.TEST_OUTPUT = out.join(",");
  `);

  expect(await evalCode(code)).toBe("2,4,6");
});
