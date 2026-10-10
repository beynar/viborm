/**
 * Runs the probe corpus (`probes/<area>/<item>.probe.mjs`, contract in
 * `probes/README.md`) against one viborm tarball installed in a temporary
 * consumer, each probe in its own bounded Node process.
 *
 *   node scripts/probe-corpus.mjs [--tarball <path> | --version <x.y.z>]
 *     [--only <id or glob>] [--md <out.md>] [--json <out.json>]
 *     [--expect pass] [--timeout <ms>]
 *
 * Without `--tarball` or `--version` it packs this checkout (run
 * `pnpm package:build` first; `VIBORM_PACKAGE_TARBALL` names a tarball
 * instead). `VIBORM_PROBE_PG_URL` and `VIBORM_PROBE_MYSQL_URL` reach the
 * probes that need those services; the others are skipped.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createPackedConsumer,
  packedArchive,
  repositoryRoot,
} from "../tests/package/packed-consumer.mjs";
import {
  ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
  startBoundedProcess,
} from "./bounded-process.mjs";

const PROBE_SUFFIX = ".probe.mjs";
const SELF_TEST_AREA = "runner";
// The drivers probes import, linked from this checkout's install.
const DRIVERS = [
  "better-sqlite3",
  "@electric-sql/pglite",
  "pg",
  "postgres",
  "mysql2",
  "@libsql/client",
  "@neondatabase/serverless",
];
const NEED_URLS = { pg: "pgUrl", mysql: "mysqlUrl" };
const STATUSES = new Set(["pass", "fail"]);
const LOG_TAIL_LINES = 20;
const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/g;
const GLOB_STAR = /\*/g;
const TABLE_PIPE = /\|/g;

const globMatcher = (pattern) =>
  new RegExp(
    `^${pattern.replace(REGEX_SPECIAL, "\\$&").replace(GLOB_STAR, "[^/]*")}$`
  );

/** The child half: imports one probe and writes its outcome to `resultFile`. */
async function runOne(file, resultFile, ctxJson, idPattern) {
  const ctx = JSON.parse(ctxJson);
  let meta;
  let outcome;
  try {
    const probe = await import(pathToFileURL(file).href);
    meta = probe.meta;
    if (typeof meta?.id !== "string" || !Array.isArray(meta.needs)) {
      throw new Error("The probe exports no `meta` with an `id` and `needs`.");
    }
    const unknown = meta.needs.filter((need) => !(need in NEED_URLS));
    if (unknown.length > 0) {
      throw new Error(`Unknown needs: ${unknown.join(", ")}`);
    }
    const missing = meta.needs.filter((need) => !ctx[NEED_URLS[need]]);
    if (idPattern && !globMatcher(idPattern).test(meta.id)) {
      outcome = { status: "excluded" };
    } else if (missing.length > 0) {
      outcome = {
        status: "skip",
        evidence: `needs ${missing.map((need) => `VIBORM_PROBE_${need.toUpperCase()}_URL`).join(", ")}`,
      };
    } else {
      // Names a probe that is killed before it settles.
      writeFileSync(resultFile, JSON.stringify({ meta }));
      const result = await probe.default(ctx);
      if (
        !STATUSES.has(result?.status) ||
        typeof result.evidence !== "string"
      ) {
        throw new Error(
          `The probe returned ${JSON.stringify(result)}, not { status: 'pass' | 'fail', evidence: string }.`
        );
      }
      outcome = { status: result.status, evidence: result.evidence };
    }
  } catch (error) {
    outcome = {
      status: "error",
      evidence:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  writeFileSync(resultFile, JSON.stringify({ meta, ...outcome }));
  // A probe may leave pools or timers open; its outcome is already written.
  process.exit(0);
}

/** Every probe file under `probes/`, as `area/item` paths. */
function discover(probesRoot, pathPattern) {
  const paths = [];
  for (const area of readdirSync(probesRoot, { withFileTypes: true })) {
    if (!area.isDirectory()) continue;
    // The runner's self-test probes run only when a path pattern names them.
    if (
      area.name === SELF_TEST_AREA &&
      !pathPattern?.startsWith(`${SELF_TEST_AREA}/`)
    ) {
      continue;
    }
    for (const file of readdirSync(join(probesRoot, area.name))) {
      if (!file.endsWith(PROBE_SUFFIX)) continue;
      const path = `${area.name}/${file.slice(0, -PROBE_SUFFIX.length)}`;
      if (!pathPattern || globMatcher(pathPattern).test(path)) paths.push(path);
    }
  }
  return paths.sort();
}

function acquireTarball(options, into) {
  if (options.tarball) return resolve(options.tarball);
  if (options.version) {
    const output = execFileSync(
      "npm",
      [
        "pack",
        `viborm@${options.version}`,
        "--json",
        "--pack-destination",
        into,
      ],
      { cwd: into, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return join(into, JSON.parse(output)[0].filename);
  }
  return packedArchive(into);
}

function logTail(logFile) {
  const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

async function runProbe(consumerRoot, fixtureRoot, path, ctx, options) {
  const scratch = join(fixtureRoot, "probe-tmp", path.replace("/", "--"));
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  const resultFile = join(scratch, ".result.json");
  const logFile = join(scratch, ".output.log");
  const log = openSync(logFile, "w");
  const run = startBoundedProcess({
    command: process.execPath,
    arguments: [
      import.meta.filename,
      "--probe-child",
      join(consumerRoot, "probes", `${path}${PROBE_SUFFIX}`),
      resultFile,
      JSON.stringify({ ...ctx, tmpDir: join(scratch, "tmp") }),
      options.idPattern,
    ],
    label: `Probe ${path}`,
    // One isolated process may hold one PGlite database.
    rssCeiling: ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
    stdio: ["ignore", log, log],
    wallLimitMs: options.timeout,
  });
  const completion = await run.completion;
  closeSync(log);
  const written = existsSync(resultFile)
    ? JSON.parse(readFileSync(resultFile, "utf8"))
    : {};
  const result = written.status
    ? written
    : {
        meta: written.meta,
        status: "error",
        evidence: [
          completion.stopReason === "wall"
            ? `Timed out after ${options.timeout} ms without a result.`
            : `Stopped (${completion.stopReason ?? `exit code ${completion.code}`}) without a result.`,
          logTail(logFile),
        ]
          .filter(Boolean)
          .join("\n"),
      };
  return {
    path,
    id: result.meta?.id ?? path,
    title: result.meta?.title ?? "",
    plan: result.meta?.plan ?? "",
    needs: result.meta?.needs ?? [],
    source: result.meta?.source ?? "",
    status: result.status,
    evidence: result.evidence,
    wallMs: Math.round(completion.wallMs),
  };
}

const firstLine = (text) => text.split("\n")[0];
const cell = (text) => text.replace(TABLE_PIPE, "\\|");

function markdown(report) {
  const lines = [
    `# Probe corpus — viborm ${report.version}`,
    "",
    "| id | title | plan | status | evidence |",
    "|---|---|---|---|---|",
    ...report.probes.map(
      (probe) =>
        `| ${cell(probe.id)} | ${cell(probe.title)} | ${cell(probe.plan)} | ${probe.status} | ${cell(firstLine(probe.evidence))} |`
    ),
    "",
    "## Details",
  ];
  for (const probe of report.probes) {
    lines.push(
      "",
      `### ${probe.id} — ${probe.title}`,
      "",
      `- probe: \`probes/${probe.path}${PROBE_SUFFIX}\``,
      `- plan: ${probe.plan}`,
      `- source: ${probe.source}`,
      `- needs: ${probe.needs.join(", ") || "nothing"}`,
      `- status: **${probe.status}** (${probe.wallMs} ms)`,
      "",
      "```text",
      probe.evidence,
      "```"
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      tarball: { type: "string" },
      version: { type: "string" },
      only: { type: "string" },
      md: { type: "string" },
      json: { type: "string" },
      expect: { type: "string" },
      timeout: { type: "string", default: "120000" },
    },
  });
  options.timeout = Number(options.timeout);
  if (options.tarball && options.version) {
    throw new Error("Pass --tarball or --version, not both.");
  }
  if (options.expect !== undefined && options.expect !== "pass") {
    throw new Error("--expect takes only `pass`.");
  }
  if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0) {
    throw new Error("--timeout takes a positive number of milliseconds.");
  }

  const probesRoot = join(repositoryRoot, "probes");
  const pathPattern = options.only?.includes("/") ? options.only : undefined;
  options.idPattern = pathPattern ? "" : (options.only ?? "");
  const paths = discover(probesRoot, pathPattern);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-probes-"));
  try {
    const consumerRoot = join(fixtureRoot, "consumer");
    createPackedConsumer(
      consumerRoot,
      acquireTarball(options, fixtureRoot),
      "viborm-probe-corpus",
      DRIVERS
    );
    cpSync(probesRoot, join(consumerRoot, "probes"), { recursive: true });
    const { version } = JSON.parse(
      readFileSync(
        join(consumerRoot, "node_modules", "viborm", "package.json"),
        "utf8"
      )
    );
    const ctx = {
      pgUrl: process.env.VIBORM_PROBE_PG_URL,
      mysqlUrl: process.env.VIBORM_PROBE_MYSQL_URL,
      version,
    };
    const probes = [];
    for (const path of paths) {
      const probe = await runProbe(
        consumerRoot,
        fixtureRoot,
        path,
        ctx,
        options
      );
      if (probe.status === "excluded") continue;
      probes.push(probe);
      process.stdout.write(
        `${probe.status.padEnd(5)}  ${probe.id.padEnd(12)}  ${path.padEnd(32)}  ${firstLine(probe.evidence).slice(0, 80)}\n`
      );
    }
    if (probes.length === 0) {
      throw new Error(`No probe matches ${options.only ?? "the corpus"}.`);
    }
    const report = { version, probes };
    const counts = Object.groupBy(probes, (probe) => probe.status);
    process.stdout.write(
      `viborm ${version}: ${Object.entries(counts)
        .map(([status, list]) => `${list.length} ${status}`)
        .join(", ")}\n`
    );
    if (options.md) writeFileSync(resolve(options.md), markdown(report));
    if (options.json) {
      writeFileSync(
        resolve(options.json),
        `${JSON.stringify(report, null, 2)}\n`
      );
    }
    const unmet = probes.filter(
      (probe) => probe.status !== "pass" && probe.status !== "skip"
    );
    if (options.expect === "pass" && unmet.length > 0) {
      process.stderr.write(
        `--expect pass: ${unmet.map((probe) => `${probe.id} ${probe.status}`).join(", ")}\n`
      );
      process.exitCode = 1;
    }
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

if (process.argv[2] === "--probe-child") {
  await runOne(...process.argv.slice(3));
} else {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
