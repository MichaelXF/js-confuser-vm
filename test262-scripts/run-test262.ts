import { readFile } from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.resolve(__dirname, "../test262/test/suite");
const HARNESS_PATH = path.resolve(__dirname, "./es5harness.js");
const WORKER_URL = new URL("./test262-worker.ts", import.meta.url);
const NUM_WORKERS = os.cpus().length;
const FILE_TIMEOUT_MS = 10_000;

interface TestResult {
  file: string;
  id: string;
  passed: boolean;
  error?: string;
}

const [harnessCode, files] = await Promise.all([
  readFile(HARNESS_PATH, "utf8"),
  glob(`${TEST_DIR}/**/*.js`),
]);

console.log(
  `Running ${files.length} test files across ${NUM_WORKERS} workers...`,
);

function chunk<T>(arr: T[], n: number): T[][] {
  const size = Math.ceil(arr.length / n);
  return Array.from({ length: n }, (_, i) =>
    arr.slice(i * size, (i + 1) * size),
  ).filter((c) => c.length > 0);
}

const allResults: TestResult[][] = new Array(files.length);
let totalCompleted = 0;

await new Promise<void>((resolve) => {
  function record(globalIndex: number, results: TestResult[]) {
    allResults[globalIndex] = results;
    ++totalCompleted;
    if (totalCompleted % 50 === 0 || totalCompleted === files.length) {
      const pct = ((totalCompleted / files.length) * 100).toFixed(1);
      console.log(`Progress: ${totalCompleted}/${files.length} (${pct}%)`);
    }
    if (totalCompleted === files.length) resolve();
  }

  function spawnWorker(chunk: string[], startGlobalIndex: number) {
    let localDone = 0;
    let timer: NodeJS.Timeout;

    const worker = new Worker(WORKER_URL, {
      workerData: { harnessCode, TEST_DIR, files: chunk },
    });

    function armTimeout() {
      timer = setTimeout(() => {
        worker.terminate();
        record(startGlobalIndex + localDone, [
          {
            file: path.relative(TEST_DIR, chunk[localDone]),
            id: "timeout",
            passed: false,
            error: `Timed out after ${FILE_TIMEOUT_MS}ms`,
          },
        ]);
        localDone++;
        if (localDone < chunk.length) {
          spawnWorker(chunk.slice(localDone), startGlobalIndex + localDone);
        }
      }, FILE_TIMEOUT_MS);
    }

    worker.on(
      "message",
      ({
        fileIndex,
        results,
      }: {
        fileIndex: number;
        results: TestResult[];
      }) => {
        clearTimeout(timer);
        record(startGlobalIndex + fileIndex, results);
        localDone = fileIndex + 1;
        if (localDone < chunk.length) armTimeout();
      },
    );

    worker.on("error", (err: Error) => {
      clearTimeout(timer);
      for (let i = localDone; i < chunk.length; i++) {
        record(startGlobalIndex + i, [
          {
            file: path.relative(TEST_DIR, chunk[i]),
            id: "worker-crash",
            passed: false,
            error: err.message,
          },
        ]);
      }
    });

    armTimeout();
  }

  let offset = 0;
  for (const c of chunk(files, NUM_WORKERS)) {
    spawnWorker(c, offset);
    offset += c.length;
  }
});

const results: TestResult[] = allResults.flat();

let passed = 0;
let errors = {};

for (const r of results) {
  if (r.passed) {
    passed++;
    continue;
  }

  let errorKey = r.id;
  if (errorKey) {
    if (!errors[errorKey]) errors[errorKey] = 0;
    errors[errorKey]++;
  }
}

if (Object.keys(errors).length > 0) {
  console.log("Failures:");
  for (const r of results) {
    if (r.error?.includes("TryStatement")) continue;
    if (!r.passed) {
      console.log(`  [${r.id}] ${r.file}`);
      if (r.error) console.log(`    → ${r.error}`);
    }
  }
}

console.log("\n=== Test262 ES5 Results ===");
console.log(`Passed:  ${passed}`);
console.log(`Errors:  ${JSON.stringify(errors, null, 2)}`);
console.log(`Total:   ${results.length}`);
console.log(
  "Percentage: " + ((passed / results.length) * 100).toFixed(2) + "%",
);
process.exit(0);
