import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBoundedProcessPlatform,
  DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  formatBoundedResourceLine,
  ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
  nodeOptionsWithHeapLimit,
  ORDINARY_PROCESS_GROUP_RSS_CEILING,
  parseHeapLimitArgument,
  parseLiveProcessGroupMemberCount,
  parseProcessGroupRssKb,
  parseRssLimitArgument,
  resolveProcessGroupRssCeiling,
  startBoundedProcess,
  vitestArgumentsWithSingleWorker,
} from "./bounded-process.mjs";

const UNAVAILABLE_ON_WINDOWS_PATTERN = /unavailable on Windows/;
const MAXIMUM_RSS_PATTERN = /no greater than 1536/;
const MAXIMUM_HEAP_PATTERN = /no greater than 768/;
const ORDINARY_CEILING_REFUSAL_PATTERN =
  /no greater than the ordinary project ceiling of 1536 MiB/;
const PGLITE_CEILING_REFUSAL_PATTERN =
  /no greater than the isolated live-PGlite provider ceiling of 1792 MiB/;
const UNALLOWLISTED_CEILING_PATTERN = /must be one of the ceilings exported/;
const ORDINARY_CEILING_LINE_PATTERN =
  /sampled ceiling 1536 MiB, ordinary project/;
const PGLITE_CEILING_LINE_PATTERN =
  /sampled ceiling 1792 MiB, isolated live-PGlite provider/;

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
  // The ceiling may only ever be LOWERED. Raising it is refused: that is the
  // memory-safety contract in memory.md, AGENTS.md and tests/README.md.
  assert.deepEqual(
    parseRssLimitArgument([], { VIBORM_PROCESS_GROUP_RSS_MB: "900" }),
    { forwardedArguments: [], rssLimitMb: 900 }
  );
  assert.throws(
    () =>
      parseRssLimitArgument([
        `--rss-limit-mb=${DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB + 1}`,
      ]),
    MAXIMUM_RSS_PATTERN
  );
});

test("the ordinary ceiling is 1536 MiB and may only ever be lowered", () => {
  assert.equal(DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB, 1536);
  assert.equal(
    ORDINARY_PROCESS_GROUP_RSS_CEILING.limitMb,
    DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB
  );
  assert.deepEqual(resolveProcessGroupRssCeiling(), {
    limitMb: 1536,
    name: "ordinary project",
  });
  assert.deepEqual(resolveProcessGroupRssCeiling({ rssLimitMb: 900 }), {
    limitMb: 900,
    name: "ordinary project",
  });
  assert.throws(
    () => resolveProcessGroupRssCeiling({ rssLimitMb: 1537 }),
    ORDINARY_CEILING_REFUSAL_PATTERN
  );
});

test("no ordinary caller can reach the 1792 MiB PGlite allowance", () => {
  // Not by typing a flag.
  assert.throws(
    () => parseRssLimitArgument(["--rss-limit-mb=1792"], {}),
    MAXIMUM_RSS_PATTERN
  );
  // Not through the environment.
  assert.throws(
    () => parseRssLimitArgument([], { VIBORM_PROCESS_GROUP_RSS_MB: "1792" }),
    MAXIMUM_RSS_PATTERN
  );
  // Not by asking for the number in code without naming a ceiling.
  assert.throws(
    () => resolveProcessGroupRssCeiling({ rssLimitMb: 1792 }),
    ORDINARY_CEILING_REFUSAL_PATTERN
  );
  // Not by forging a ceiling that looks exactly like the allowlisted one:
  // membership is by identity of the named export, not by shape.
  assert.throws(
    () =>
      resolveProcessGroupRssCeiling({
        rssCeiling: { limitMb: 1792, name: "isolated live-PGlite provider" },
        rssLimitMb: 1792,
      }),
    UNALLOWLISTED_CEILING_PATTERN
  );
  assert.throws(
    () =>
      resolveProcessGroupRssCeiling({
        rssCeiling: { ...ISOLATED_PGLITE_PROVIDER_RSS_CEILING },
      }),
    UNALLOWLISTED_CEILING_PATTERN
  );
  // And the launcher itself refuses before it spawns anything.
  assert.throws(
    () =>
      startBoundedProcess({
        arguments: ["-e", ""],
        command: process.execPath,
        label: "ordinary caller",
        rssLimitMb: 1792,
        stdio: "ignore",
        wallLimitMs: 10_000,
      }),
    ORDINARY_CEILING_REFUSAL_PATTERN
  );
});

test("the allowlisted PGlite ceiling reaches 1792 MiB and stops there", () => {
  assert.equal(ISOLATED_PGLITE_PROVIDER_RSS_CEILING.limitMb, 1792);
  assert.deepEqual(
    resolveProcessGroupRssCeiling({
      rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    }),
    { limitMb: 1792, name: "isolated live-PGlite provider" }
  );
  // Lowering stays available on the allowlisted path too.
  assert.deepEqual(
    resolveProcessGroupRssCeiling({
      rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
      rssLimitMb: 1024,
    }),
    { limitMb: 1024, name: "isolated live-PGlite provider" }
  );
  // The allowance is a ceiling, not a door: it cannot be raised either.
  assert.throws(
    () =>
      resolveProcessGroupRssCeiling({
        rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
        rssLimitMb: 1793,
      }),
    PGLITE_CEILING_REFUSAL_PATTERN
  );
});

test("the resource line names the ceiling that was applied", () => {
  const ordinary = formatBoundedResourceLine("[test:all] provider-sqlite3", {
    peakGroupRssKb: 1024 * 100,
    rssCeiling: resolveProcessGroupRssCeiling(),
    wallMs: 1234,
  });
  assert.equal(
    ordinary,
    "[test:all] provider-sqlite3: 1.23s wall, 100.0 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB, ordinary project). Teardown verified."
  );
  assert.match(ordinary, ORDINARY_CEILING_LINE_PATTERN);
  assert.match(
    formatBoundedResourceLine("[test:all] provider-pglite", {
      peakGroupRssKb: 1024 * 1700,
      rssCeiling: resolveProcessGroupRssCeiling({
        rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
      }),
      wallMs: 1234,
    }),
    PGLITE_CEILING_LINE_PATTERN
  );
});

test("a bounded run reports the ceiling it enforced", async () => {
  const run = startBoundedProcess({
    arguments: ["-e", ""],
    command: process.execPath,
    label: "PGlite ceiling witness",
    rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    stdio: "ignore",
    wallLimitMs: 10_000,
  });

  const outcome = await run.completion;
  assert.equal(outcome.code, 0);
  assert.deepEqual(outcome.rssCeiling, {
    limitMb: 1792,
    name: "isolated live-PGlite provider",
  });
  // The printed line is derived from the enforced ceiling, so the two cannot
  // drift apart.
  assert.match(
    formatBoundedResourceLine("[test:all] provider-pglite", outcome),
    PGLITE_CEILING_LINE_PATTERN
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
