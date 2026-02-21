import { parentPort, workerData } from "worker_threads";
import { readFileSync } from "fs";
import * as path from "path";
import * as vm from "vm";
import { virtualize } from "../src/index.js";

interface TestResult {
  file: string;
  id: string;
  passed: boolean;
  error?: string;
}

const { harnessCode, TEST_DIR, files } = workerData as {
  harnessCode: string;
  TEST_DIR: string;
  files: string[];
};

function processFile(file: string): TestResult[] {
  const relFile = path.relative(TEST_DIR, file);
  const testCode = readFileSync(file, "utf8");
  const isNegative = /@negative/i.test(testCode);

  const sandbox = {
    ...globalThis,
    ES5Harness: undefined as any,
    $ERROR: undefined as any,
    $PRINT: undefined as any,
    fnExists: undefined as any,
    fnSupports: undefined as any,
    NotEarlyError: undefined as any,
    runTestCase: undefined as any,
    __results__: [] as any[],
  };

  const ctx = vm.createContext(sandbox);

  try {
    vm.runInContext(harnessCode, ctx, { timeout: 1000 });
  } catch (e: any) {
    return [{ file: relFile, id: "harness-error", passed: false, error: `Harness setup failed: ${e.message}` }];
  }

  let virtualizedCode: string;
  try {
    virtualizedCode = virtualize(testCode).code;
  } catch (e: any) {
    if (isNegative) return [{ file: relFile, id: "tc1", passed: true }];
    return [{ file: relFile, id: "compile-error", passed: false, error: `virtualize() threw: ${e.message}` }];
  }

  try {
    vm.runInContext(virtualizedCode, ctx, { timeout: 5000 });
    vm.runInContext(`__results__ = ES5Harness.runAll();`, ctx, { timeout: 1000 });

    const testResults = (ctx as any).__results__ as Array<{
      id: string;
      passed: boolean;
      error: Error | null;
    }>;

    if (testResults.length === 0) {
      if (isNegative) return [{ file: relFile, id: "tc1", passed: false, error: "Expected error but none thrown" }];
      return [];
    }

    return testResults.map((r) => ({
      file: relFile,
      id: r.id,
      passed: r.passed,
      error: r.error?.message,
    }));
  } catch (e: any) {
    if (isNegative) return [{ file: relFile, id: "tc1", passed: true }];
    return [{ file: relFile, id: "runtime-error", passed: false, error: `Runtime threw: ${e.message}` }];
  }
}

for (let i = 0; i < files.length; i++) {
  parentPort!.postMessage({ fileIndex: i, results: processFile(files[i]) });
}
