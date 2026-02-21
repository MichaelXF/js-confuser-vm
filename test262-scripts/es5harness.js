// harness/es5harness.js
// This file is prepended to every test before execution.
// It must be valid ES5 itself.

var ES5Harness = (function () {
  var registeredTests = [];

  return {
    registerTest: function (test) {
      registeredTests.push(test);
    },

    // Called by the runner after the test file is eval'd
    runAll: function () {
      var results = [];
      for (var i = 0; i < registeredTests.length; i++) {
        var t = registeredTests[i];
        var passed = false;
        var error = null;
        try {
          var result = t.test.call({});
          // Convention: return true = pass, return falsy = fail
          passed = result === true;
          if (!passed) error = new Error("Test returned falsy: " + result);
        } catch (e) {
          passed = false;
          error = e;
        }
        results.push({ id: t.id, passed: passed, error: error });
      }
      // Reset for next test file
      registeredTests = [];
      return results;
    },
  };
})();

// Globals some tests call directly
function $ERROR(message) {
  throw new Error(message);
}

function $PRINT(value) {
  // no-op or console.log for debugging
}

function fnExists(fn) {
  return typeof fn === "function";
}

function fnSupports(fn, prop) {
  return typeof fn === "function" && prop in fn;
}

// Some tests use these
var NotEarlyError = new Error("NotEarlyError");

// Used by the majority of test262 ES5 tests instead of ES5Harness.registerTest
var __runTestCaseId__ = 0;
function runTestCase(fn) {
  ES5Harness.registerTest({
    id: "tc" + (++__runTestCaseId__),
    test: fn,
  });
}
