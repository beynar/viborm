import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
} from "./bounded-process.mjs";

const UNAVAILABLE_ON_WINDOWS_PATTERN = /unavailable on Windows/;
const MAXIMUM_RSS_PATTERN = /no greater than 1536/;
const MAXIMUM_HEAP_PATTERN = /no greater than 768/;
const ORDINARY_CEILING_REFUSAL_PATTERN =
  /no greater than the ordinary project ceiling of 1536 MiB/;
const PGLITE_CEILING_REFUSAL_PATTERN =
  /no greater than the isolated live-PGlite provider ceiling of 2560 MiB/;
const TYPECHECK_CEILING_REFUSAL_PATTERN =
  /no greater than the whole-estate native typecheck ceiling of 8192 MiB/;
const UNALLOWLISTED_CEILING_PATTERN = /must be one of the ceilings exported/;
const ORDINARY_CEILING_LINE_PATTERN =
  /sampled ceiling 1536 MiB, ordinary project/;
const PGLITE_CEILING_LINE_PATTERN =
  /sampled ceiling 2560 MiB, isolated live-PGlite provider/;

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

test("no ordinary caller can reach the 2560 MiB PGlite allowance", () => {
  // Not by typing a flag.
  assert.throws(
    () => parseRssLimitArgument(["--rss-limit-mb=2560"], {}),
    MAXIMUM_RSS_PATTERN
  );
  // Not through the environment.
  assert.throws(
    () => parseRssLimitArgument([], { VIBORM_PROCESS_GROUP_RSS_MB: "2560" }),
    MAXIMUM_RSS_PATTERN
  );
  // Not by asking for the number in code without naming a ceiling.
  assert.throws(
    () => resolveProcessGroupRssCeiling({ rssLimitMb: 2560 }),
    ORDINARY_CEILING_REFUSAL_PATTERN
  );
  // Not by forging a ceiling that looks exactly like the allowlisted one:
  // membership is by identity of the named export, not by shape.
  assert.throws(
    () =>
      resolveProcessGroupRssCeiling({
        rssCeiling: { limitMb: 2560, name: "isolated live-PGlite provider" },
        rssLimitMb: 2560,
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
        rssLimitMb: 2560,
        stdio: "ignore",
        wallLimitMs: 10_000,
      }),
    ORDINARY_CEILING_REFUSAL_PATTERN
  );
});

test("the allowlisted typecheck ceiling reaches 8192 MiB and stops there", () => {
  assert.equal(WHOLE_ESTATE_TYPECHECK_RSS_CEILING.limitMb, 8192);
  assert.deepEqual(
    resolveProcessGroupRssCeiling({
      rssCeiling: WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
    }),
    { limitMb: 8192, name: "whole-estate native typecheck" }
  );
  assert.throws(
    () =>
      resolveProcessGroupRssCeiling({
        rssCeiling: WHOLE_ESTATE_TYPECHECK_RSS_CEILING,
        rssLimitMb: 8193,
      }),
    TYPECHECK_CEILING_REFUSAL_PATTERN
  );
  // A look-alike literal is refused here exactly as for the PGlite ceiling.
  assert.throws(
    () =>
      resolveProcessGroupRssCeiling({
        rssCeiling: { limitMb: 8192, name: "whole-estate native typecheck" },
      }),
    UNALLOWLISTED_CEILING_PATTERN
  );
});

test("the allowlisted PGlite ceiling reaches 2560 MiB and stops there", () => {
  assert.equal(ISOLATED_PGLITE_PROVIDER_RSS_CEILING.limitMb, 2560);
  assert.deepEqual(
    resolveProcessGroupRssCeiling({
      rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    }),
    { limitMb: 2560, name: "isolated live-PGlite provider" }
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
        rssLimitMb: 2561,
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
    limitMb: 2560,
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

const PACKAGE_BAIL = /name: "package",[\s\S]*?bail: 1,/;

for (const mode of ["sync", "async"]) {
  test(`${mode} timed-out package smoke fails fast with its compiler in the aggregate group`, async () => {
    assert.match(readFileSync("vitest.workspace.ts", "utf8"), PACKAGE_BAIL);
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "viborm-package-timeout-"))
    );
    try {
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
      const observation = join(root, "observation.json");
      const successor = join(root, "successor");
      const script = join(root, "smoke.mjs");
      writeFileSync(
        script,
        `import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const compiler = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ smoke: process.pid, compiler: compiler.pid, group }));
setInterval(() => {}, 1000);
`
      );
      writeFileSync(
        join(root, "timeout.test.ts"),
        `import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
it("fails a timed-out smoke", async () => {
  try {
    ${mode === "async" ? "await promisify(execFile)" : "execFileSync"}(process.execPath, [${JSON.stringify(script)}], { timeout: 1000, killSignal: "SIGKILL" });
  } catch (error) {
    const state = JSON.parse(readFileSync(${JSON.stringify(observation)}, "utf8"));
    const processes = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).trim().split("\\n").map(line => line.trim().split(/\\s+/));
    const compiler = processes.find(row => Number(row[0]) === state.compiler);
    state.orphanAlive = !!compiler && !compiler[2].startsWith("Z");
    state.compilerGroup = Number(compiler?.[1]);
    state.timeout = error.code;
    state.signal = error.signal;
    writeFileSync(${JSON.stringify(observation)}, JSON.stringify(state));
    throw error;
  }
});
it("must not start a successor", () => { writeFileSync(${JSON.stringify(successor)}, "started"); });
`
      );
      // Exercise project-level bail as installed, not a global CLI shortcut.
      const config = join(root, "vitest.config.mjs");
      writeFileSync(
        config,
        `export default { root: ${JSON.stringify(root)}, test: { pool: "forks", maxWorkers: 1, minWorkers: 1, fileParallelism: false } };`
      );
      const workspace = join(root, "vitest.workspace.mjs");
      writeFileSync(
        workspace,
        `export default [{ test: { root: ${JSON.stringify(root)}, name: "package", include: ["timeout.test.ts"], bail: 1 } }];`
      );
      const outcome = await startBoundedProcess({
        command: process.execPath,
        arguments: [
          resolve("node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          config,
          "--workspace",
          workspace,
          "--project",
          "package",
        ],
        heapLimitMb: 768,
        label: "package timeout ownership witness",
        stdio: "inherit",
        wallLimitMs: 15_000,
      }).completion;
      assert.notEqual(outcome.code, 0);
      assert.equal(outcome.stopReason, undefined);
      assert.equal(outcome.error, undefined);
      const state = JSON.parse(readFileSync(observation, "utf8"));
      if (mode === "sync") assert.equal(state.timeout, "ETIMEDOUT");
      assert.equal(state.signal, "SIGKILL");
      assert.equal(state.orphanAlive, true);
      assert.equal(state.compilerGroup, state.group);
      assert.throws(() => readFileSync(successor), { code: "ENOENT" });
      // Existing bounded-process teardown ignores zombies and verifies that no
      // live member of this original aggregate group survives completion.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
