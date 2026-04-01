import * as path from "path";
import { glob } from "glob";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.resolve(__dirname, "../test262/test/suite");
const WORKER_URL = new URL("./test262-worker.ts", import.meta.url);
const NUM_WORKERS = os.cpus().length;
const FILE_TIMEOUT_MS = 10_000;

interface TestResult {
  file: string;
  id: string;
  passed: boolean;
  error?: string;
}

const files = await glob(`${TEST_DIR}/**/*.js`);

console.log(
  `Running ${files.length} test files across ${NUM_WORKERS} workers...`,
);

interface Chunk {
  items: string[];
  offset: number;
}

function chunk(files: string[], chunkSize: number): Chunk[] {
  const size = Math.ceil(files.length / chunkSize);
  const chunks: Chunk[] = [];

  for (var i = 0; i < files.length; i += size) {
    let items = files.slice(i, i + size);

    chunks.push({ items, offset: i });
  }

  return chunks;
}

const allResults: TestResult[][] = new Array(files.length);
let totalFilesCompleted = 0;
let chunksDone = 0;
let lastProgressAt = Date.now();

function createChunk(chunk: Chunk, chunkIndex: number): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(
      () => {
        markDone();
        reject("Chunk timed out after 5 minutes");
      },
      1000 * 60 * 5,
    ); // Chunk has a max of 5 minutes to complete, just in case

    var isDone = false;
    var retryCount = 0;

    function markDone() {
      if (isDone) return;
      isDone = true;

      chunksDone++;
      if (chunksDone === NUM_WORKERS - 1) {
        reject("Finished.");
      }
    }

    function record(fileIndex: number, results: TestResult[]) {
      if (!running) return;
      if (allResults[chunk.offset + fileIndex]) return;

      allResults[chunk.offset + fileIndex] = results || [];
      totalFilesCompleted += 1;

      if (totalFilesCompleted >= files.length - 1) {
        reject("Finished.");
        running = false;
        return;
      }

      if (
        totalFilesCompleted % 50 === 0 ||
        Date.now() - lastProgressAt > 1000 * 5
      ) {
        lastProgressAt = Date.now();
        console.log(
          `Completed ${totalFilesCompleted} / ${files.length} tests... (${((totalFilesCompleted / files.length) * 100).toFixed(2)}%)`,
        );
      }

      if (fileIndex >= chunk.items.length - 1) {
        markDone();
      }
    }

    let localDone = 0;

    function spawnWorker(offset = 0) {
      let timer: NodeJS.Timeout;

      armTimeout();

      let worker = new Worker(WORKER_URL, {
        workerData: { TEST_DIR, files: chunk.items.slice(offset) },
      });

      function armTimeout() {
        timer = setTimeout(() => {
          worker.terminate();
          worker = null;

          record(localDone, [
            {
              file: chunk.items[localDone],
              id: "timeout",
              passed: false,
              error: `Timed out after ${FILE_TIMEOUT_MS}ms`,
            },
          ]);
          localDone++;

          if (retryCount++ < 5) {
            console.log(
              "Chunk",
              chunkIndex,
              "timed out, creating new worker to continue...",
            );
            retryFrom(localDone);
          } else {
            console.log(
              "Chunk",
              chunkIndex,
              "timed out, failing remaining tests",
            );
            markRemainingError(
              new Error(`Worker timed out after ${FILE_TIMEOUT_MS}ms`),
            );
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
          record(offset + fileIndex, results);
          localDone = offset + fileIndex + 1;
          if (localDone <= chunk.items.length) armTimeout();
        },
      );

      worker.on("error", (err: Error) => {
        clearTimeout(timer);

        markRemainingError(err);
      });

      function markRemainingError(err) {
        for (let i = localDone; i < chunk.items.length; i++) {
          record(i, [
            {
              file: chunk.items[i],
              id: "worker-crash",
              passed: false,
              error: err.message,
            },
          ]);
        }
        markDone();
      }

      function retryFrom(localDone) {
        if (localDone < chunk.items.length) {
          spawnWorker(localDone);
        }
      }
    }

    spawnWorker();
  });
}

const chunks = chunk(files, NUM_WORKERS);

let running = true;
try {
  await Promise.all(chunks.map((chunk, i) => createChunk(chunk, i)));
} catch (err) {
  console.error("Failed to complete all chunks", err);
}
running = false;

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
      console.log(`  [${r.id}] ${r.file || ""}`);
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
