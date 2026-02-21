import { parentPort, workerData } from "worker_threads";
import { readFileSync, readdirSync } from "fs";
import * as path from "path";
import * as vm from "vm";
import { fileURLToPath } from "url";
import JsConfuserVM from "../src/index.ts";

interface TestResult {
  file: string;
  id: string;
  passed: boolean;
  error?: string;
}

const { TEST_DIR, files } = workerData as {
  TEST_DIR: string;
  files: string[];
};

// Build the harness once at worker startup.
// 1. All files from test262/test/harness/ in sorted order (jQuery included) —
//    each is run independently so browser-only files that throw are skipped silently.
// 2. Our custom es5harness.js runs last, overriding runTestCase / $ERROR / etc.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.resolve(__dirname, "../test262/test/harness");
const CUSTOM_HARNESS = readFileSync(
  path.resolve(__dirname, "./es5harness.js"),
  "utf8",
);

const harnessFiles = readdirSync(HARNESS_DIR)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => ({
    name: f,
    code: readFileSync(path.join(HARNESS_DIR, f), "utf8"),
  }));

async function processFile(file: string): Promise<TestResult[]> {
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

  // Load each upstream harness file individually so a browser-only file
  // (gs.js referencing testDescrip, sth.js using $, etc.) can't poison the
  // whole context — its error is silently swallowed.
  for (const { code } of harnessFiles) {
    try {
      vm.runInContext(code, ctx, { timeout: 500 });
    } catch (_) {}
  }
  // Custom harness runs last so it can override runTestCase, $ERROR, etc.
  try {
    vm.runInContext(CUSTOM_HARNESS, ctx, { timeout: 1000 });
  } catch (e: any) {
    return [
      {
        file: relFile,
        id: "harness-error",
        passed: false,
        error: `Custom harness setup failed: ${e.message}`,
      },
    ];
  }

  let virtualizedCode: string;
  try {
    virtualizedCode = (await JsConfuserVM.obfuscate(testCode)).code;
  } catch (e: any) {
    if (isNegative) return [{ file: relFile, id: "tc1", passed: true }];
    return [
      {
        file: relFile,
        id: "compile-error",
        passed: false,
        error: `virtualize() threw: ${e.message}`,
      },
    ];
  }

  try {
    vm.runInContext(virtualizedCode, ctx, { timeout: 5000 });
    vm.runInContext(`__results__ = ES5Harness.runAll();`, ctx, {
      timeout: 1000,
    });

    const testResults = (ctx as any).__results__ as Array<{
      id: string;
      passed: boolean;
      error: Error | null;
    }>;

    if (testResults.length === 0) {
      if (isNegative)
        return [
          {
            file: relFile,
            id: "tc1",
            passed: false,
            error: "Expected error but none thrown",
          },
        ];
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
    return [
      {
        file: relFile,
        id: "runtime-error",
        passed: false,
        error: `Runtime threw: ${e.message}`,
      },
    ];
  }
}

for (let i = 0; i < files.length; i++) {
  parentPort!.postMessage({
    fileIndex: i,
    results: await processFile(files[i]),
  });
}
