import { obfuscate, evalCode } from "../test-utils";

// try..finally
test("Variant #1: finally runs after the try body completes normally", async () => {
  const { code } = await obfuscate(`
    var log = [];
    try {
      log[log.length] = "try";
    } finally {
      log[log.length] = "finally";
    }
    log[log.length] = "after";
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["try", "finally", "after"]);
});

test("Variant #2: finally runs while an exception propagates to an outer catch", async () => {
  const { code } = await obfuscate(`
    var log = [];
    try {
      try {
        log[log.length] = "try";
        throw "boom";
      } finally {
        log[log.length] = "finally";
      }
    } catch (e) {
      log[log.length] = "caught-" + e;
    }
    window.TEST_OUTPUT = log;
  `);

  // finally runs BEFORE the outer catch sees the re-raised exception
  expect(await evalCode(code)).toEqual(["try", "finally", "caught-boom"]);
});

test("Variant #3: uncaught exception still runs finally then propagates to host", async () => {
  const { code } = await obfuscate(`
    var ran = false;
    window.SET_RAN = function () { ran = true; };
    function go() {
      try {
        throw new Error("nope");
      } finally {
        window.SET_RAN();
      }
    }
    try {
      go();
    } catch (e) {
      window.TEST_OUTPUT = ran + ":" + e.message;
    }
  `);

  expect(await evalCode(code)).toBe("true:nope");
});

// try..catch..finally
test("Variant #4: catch then finally both run on a thrown error", async () => {
  const { code } = await obfuscate(`
    var log = [];
    try {
      log[log.length] = "try";
      throw "x";
    } catch (e) {
      log[log.length] = "catch";
    } finally {
      log[log.length] = "finally";
    }
    log[log.length] = "after";
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["try", "catch", "finally", "after"]);
});

test("Variant #5: only try and finally run when nothing is thrown", async () => {
  const { code } = await obfuscate(`
    var log = [];
    try {
      log[log.length] = "try";
    } catch (e) {
      log[log.length] = "catch";
    } finally {
      log[log.length] = "finally";
    }
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["try", "finally"]);
});

// try..finally + return
test("Variant #6: finally runs before a return inside the try body", async () => {
  const { code } = await obfuscate(`
    var log = [];
    function f() {
      try {
        log[log.length] = "try";
        return "from-try";
      } finally {
        log[log.length] = "finally";
      }
    }
    var r = f();
    log[log.length] = r;
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["try", "finally", "from-try"]);
});

test("Variant #7: a return inside finally overrides the try's return value", async () => {
  const { code } = await obfuscate(`
    function f() {
      try {
        return "try";
      } finally {
        return "finally";
      }
    }
    window.TEST_OUTPUT = f();
  `);

  expect(await evalCode(code)).toBe("finally");
});

test("Variant #8: the try's return value is captured before finally mutates locals", async () => {
  const { code } = await obfuscate(`
    function f() {
      var x = 1;
      try {
        return x;
      } finally {
        x = 99;
      }
    }
    window.TEST_OUTPUT = f();
  `);

  // Return value was evaluated (1) before the finally reassigned x.
  expect(await evalCode(code)).toBe(1);
});

test("Variant #9: finally runs before a return inside the catch block", async () => {
  const { code } = await obfuscate(`
    var log = [];
    function f() {
      try {
        throw "boom";
      } catch (e) {
        log[log.length] = "catch";
        return "from-catch";
      } finally {
        log[log.length] = "finally";
      }
    }
    var r = f();
    log[log.length] = r;
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["catch", "finally", "from-catch"]);
});

// try..finally + break / continue
test("Variant #10: finally runs when breaking out of a loop from the try body", async () => {
  const { code } = await obfuscate(`
    var log = [];
    for (var i = 0; i < 5; i++) {
      try {
        if (i === 2) break;
        log[log.length] = "body-" + i;
      } finally {
        log[log.length] = "finally-" + i;
      }
    }
    log[log.length] = "done";
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual([
    "body-0",
    "finally-0",
    "body-1",
    "finally-1",
    "finally-2",
    "done",
  ]);
});

test("Variant #11: finally runs on every continue iteration", async () => {
  const { code } = await obfuscate(`
    var log = [];
    for (var i = 0; i < 3; i++) {
      try {
        if (i === 1) continue;
        log[log.length] = "body-" + i;
      } finally {
        log[log.length] = "finally-" + i;
      }
    }
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual([
    "body-0",
    "finally-0",
    "finally-1",
    "body-2",
    "finally-2",
  ]);
});

test("Variant #12: labeled break out of an outer loop runs every crossed finally", async () => {
  const { code } = await obfuscate(`
    var log = [];
    outer: for (var i = 0; i < 3; i++) {
      try {
        for (var j = 0; j < 3; j++) {
          try {
            if (i === 1 && j === 1) break outer;
            log[log.length] = i + "," + j;
          } finally {
            log[log.length] = "inner-fin";
          }
        }
      } finally {
        log[log.length] = "outer-fin-" + i;
      }
    }
    log[log.length] = "end";
    window.TEST_OUTPUT = log;
  `);

  // Both the inner and outer finalizers must run as the labeled break unwinds.
  expect(await evalCode(code)).toEqual([
    "0,0",
    "inner-fin",
    "0,1",
    "inner-fin",
    "0,2",
    "inner-fin",
    "outer-fin-0",
    "1,0",
    "inner-fin",
    "inner-fin",
    "outer-fin-1",
    "end",
  ]);
});

//  Nested finalizers & overrides
test("Variant #13: nested finalizers run inner-to-outer as an exception unwinds", async () => {
  const { code } = await obfuscate(`
    var log = [];
    try {
      try {
        try {
          throw "deep";
        } finally {
          log[log.length] = "fin-1";
        }
      } finally {
        log[log.length] = "fin-2";
      }
    } catch (e) {
      log[log.length] = "caught-" + e;
    }
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["fin-1", "fin-2", "caught-deep"]);
});

test("Variant #14: an exception thrown inside finally overrides the pending one", async () => {
  const { code } = await obfuscate(`
    var result = "none";
    try {
      try {
        throw "original";
      } finally {
        throw "replacement";
      }
    } catch (e) {
      result = e;
    }
    window.TEST_OUTPUT = result;
  `);

  expect(await evalCode(code)).toBe("replacement");
});

test("Variant #15: return threads through a finalizer in a deeper call frame", async () => {
  const { code } = await obfuscate(`
    var log = [];
    function inner() {
      try {
        return "inner-ret";
      } finally {
        log[log.length] = "inner-fin";
      }
    }
    function outer() {
      try {
        return inner();
      } finally {
        log[log.length] = "outer-fin";
      }
    }
    var r = outer();
    log[log.length] = r;
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["inner-fin", "outer-fin", "inner-ret"]);
});

test("Variant #16: finally runs after an exception thrown in a called function", async () => {
  const { code } = await obfuscate(`
    var log = [];
    function boom() { throw "from-fn"; }
    try {
      try {
        boom();
      } finally {
        log[log.length] = "finally";
      }
    } catch (e) {
      log[log.length] = "caught-" + e;
    }
    window.TEST_OUTPUT = log;
  `);

  expect(await evalCode(code)).toEqual(["finally", "caught-from-fn"]);
});

test("Variant #17: pending exception is re-raised after a normally-completing finally", async () => {
  const { code } = await obfuscate(`
    var log = [];
    try {
      for (var i = 0; i < 3; i++) {
        try {
          throw "boom-" + i;
        } finally {
          log[log.length] = "fin-" + i;
        }
      }
    } catch (e) {
      log[log.length] = "caught-" + e;
    }
    window.TEST_OUTPUT = log;
  `);

  // i=0 throws; its finally runs then the exception re-raises, aborting the
  // loop before i=1 — so only "fin-0" runs, then the outer catch sees it.
  expect(await evalCode(code)).toEqual(["fin-0", "caught-boom-0"]);
});

test("Variant #18: break inside finally swallows the pending exception", async () => {
  const { code } = await obfuscate(`
    var log = [];
    function run() {
      for (var i = 0; i < 3; i++) {
        try {
          throw "boom";
        } finally {
          log[log.length] = "fin";
          break;
        }
      }
      log[log.length] = "after-loop";
    }
    run();
    window.TEST_OUTPUT = log;
  `);

  // The break in finally is an abrupt completion that discards the throw.
  expect(await evalCode(code)).toEqual(["fin", "after-loop"]);
});

test("Variant #19: finally observes and rethrows, value computed in try", async () => {
  const { code } = await obfuscate(`
    function f(n) {
      var out = [];
      try {
        out[out.length] = "start";
        if (n < 0) throw "neg";
        out[out.length] = "ok";
        return out;
      } finally {
        out[out.length] = "cleanup";
      }
    }
    var a = f(1);
    window.TEST_OUTPUT = a;
  `);

  expect(await evalCode(code)).toEqual(["start", "ok", "cleanup"]);
});
