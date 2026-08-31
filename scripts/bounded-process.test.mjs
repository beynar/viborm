import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBoundedProcessPlatform,
  DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  nodeOptionsWithHeapLimit,
  parseHeapLimitArgument,
  parseLiveProcessGroupMemberCount,
  parseProcessGroupRssKb,
  parseRssLimitArgument,
  startBoundedProcess,
  vitestArgumentsWithSingleWorker,
} from "./bounded-process.mjs";

const UNAVAILABLE_ON_WINDOWS_PATTERN = /unavailable on Windows/;
const MAXIMUM_RSS_PATTERN = /no greater than 1536/;
const MAXIMUM_HEAP_PATTERN = /no greater than 768/;

test("fails closed where process-tree bounds cannot be verified", () => {
  assert.doesNotThrow(() => assertBoundedProcessPlatform("darwin"));
  assert.throws(
    () => assertBoundedProcessPlatform("win32"),
    UNAVAILABLE_ON_WINDOWS_PATTERN
  );
});

test("process-group RSS sums every member and ignores other groups", () => {
  assert.equal(parseProcessGroupRssKb(" 42 100\n 7 900\n 42 250\n", 42), 350);
});

test("process-group teardown ignores zombie-only groups", () => {
  assert.equal(
    parseLiveProcessGroupMemberCount(" 42 Z\n 7 S\n 42 Z+\n", 42),
    0
  );
  assert.equal(
    parseLiveProcessGroupMemberCount(" 42 Z\n 42 S+\n 7 R\n", 42),
    1
  );
});

test("heap replacement preserves unrelated Node options", () => {
  assert.equal(
    nodeOptionsWithHeapLimit("--trace-warnings --max-old-space-size=4096", 768),
    "--trace-warnings --max-old-space-size=768"
  );
});

test("RSS limit defaults to the project cap and is configurable", () => {
  assert.deepEqual(parseRssLimitArgument(["run"], {}), {
    forwardedArguments: ["run"],
    rssLimitMb: DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  });
  assert.deepEqual(parseRssLimitArgument(["--rss-limit-mb=900", "run"], {}), {
    forwardedArguments: ["run"],
    rssLimitMb: 900,
  });
  assert.throws(
    () => parseRssLimitArgument(["--rss-limit-mb=1537"], {}),
    MAXIMUM_RSS_PATTERN
  );
});

test("heap limits may be lowered but never raised above the caller cap", () => {
  assert.deepEqual(
    parseHeapLimitArgument(["run"], { defaultMb: 768, maxMb: 768 }),
    { forwardedArguments: ["run"], heapLimitMb: 768 }
  );
  assert.deepEqual(
    parseHeapLimitArgument(["--heap-limit-mb=512", "run"], {
      defaultMb: 768,
      maxMb: 768,
    }),
    { forwardedArguments: ["run"], heapLimitMb: 512 }
  );
  assert.throws(
    () =>
      parseHeapLimitArgument(["--heap-limit-mb=769"], {
        defaultMb: 768,
        maxMb: 768,
      }),
    MAXIMUM_HEAP_PATTERN
  );
});

test("Vitest arguments end with the enforced single-worker policy", () => {
  assert.deepEqual(vitestArgumentsWithSingleWorker(["run"]), [
    "run",
    "--maxWorkers=1",
    "--minWorkers=1",
    "--no-file-parallelism",
  ]);
});

test("the sampled RSS ceiling terminates the complete child group", async () => {
  const run = startBoundedProcess({
    arguments: [
      "-e",
      "const blocks=[];setInterval(()=>blocks.push(Buffer.alloc(1024*1024,1)),5)",
    ],
    command: process.execPath,
    heapLimitMb: 64,
    label: "RSS limit witness",
    rssLimitMb: 48,
    stdio: "ignore",
    wallLimitMs: 10_000,
  });

  const outcome = await run.completion;
  assert.equal(outcome.stopReason, "rss");
  assert.ok(outcome.peakGroupRssKb > 48 * 1024);
  assert.notEqual(outcome.code, 0);
});

test("RSS teardown verifies a group whose leader and worker exit together", async () => {
  const worker = [
    "const blocks = []",
    'process.on("SIGTERM", () => process.exit(0))',
    "setInterval(() => blocks.push(Buffer.alloc(1024 * 1024, 1)), 5)",
  ].join(";");
  const leader = [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "inherit" })`,
    "setInterval(() => {}, 1000)",
  ].join(";");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = startBoundedProcess({
      arguments: ["-e", leader],
      command: process.execPath,
      heapLimitMb: 64,
      label: "RSS group teardown witness",
      rssLimitMb: 48,
      stdio: "ignore",
      wallLimitMs: 10_000,
    });

    const outcome = await run.completion;
    assert.equal(outcome.stopReason, "rss");
    assert.equal(outcome.error, undefined);
  }
});

test("normal leader exit still tears down inherited descendants", async () => {
  const run = startBoundedProcess({
    arguments: [
      "-e",
      [
        'const { spawn } = require("node:child_process")',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" })',
        "child.unref()",
      ].join(";"),
    ],
    command: process.execPath,
    heapLimitMb: 64,
    label: "descendant teardown witness",
    rssLimitMb: 128,
    stdio: ["ignore", "pipe", "pipe"],
    wallLimitMs: 10_000,
  });

  const outcome = await run.completion;
  assert.equal(outcome.stopReason, undefined);
  assert.equal(outcome.code, 0);
  assert.ok(outcome.wallMs < 5000);
});
