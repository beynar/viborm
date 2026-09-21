/**
 * Assemble the final local release index from a directory of gate logs.
 *
 * Read-only over the gate directory and over the tree: it copies the raw logs
 * into the checkpoint, reads the identities from the owners that already state
 * them, and writes one `index.md` / `index.json` pair. It measures nothing —
 * the bundle and LOC tables come from the measurement files the two existing
 * readers produce (`measure-raptor3-baseline.mjs`,
 * `closure-final-recount.mjs`), so there is no second definition of a token
 * line, a charged file or a bundle here.
 *
 *   node scripts/closure-final-index.mjs --gate <dir> --out <dir> \
 *     [--measurement <baseline.json>] [--recount <recount.json>] [--label <text>]
 *
 * The gate directory is the integrator's: one `<stage>.log` per stage plus a
 * `summary.log` whose `=== <stage>` / `exit=<n>` pairs own the exit codes. A
 * stage with no recorded exit code is reported as `unrecorded`, never as zero;
 * a code the summary recorded under a name no log file carries is listed
 * separately rather than dropped. `summary.log` is the codes' owner, not a
 * stage of its own, so it is not walked as one.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import { calibrationSourceIdentity } from "../benchmarks/operation-pipeline-semantics.mjs";

const root = resolve(import.meta.dirname, "..");

function option(name, { required = false } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    if (required) throw new Error(`Missing required --${name}`);
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

const gateDirectory = resolve(root, option("gate", { required: true }));
const outDirectory = resolve(root, option("out", { required: true }));
const measurementFile = option("measurement");
const recountFile = option("recount");
const label = option("label") ?? basename(outDirectory);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) =>
  JSON.parse(readFileSync(resolve(root, file), "utf8"));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/* ------------------------------------------------------------------ stages */

const SUMMARY_HEADER = /^===/;
const SUMMARY_STAGE = /^===\s+(.+?)\s*$/;
const SUMMARY_EXIT = /^exit=(\d+)\s*$/;
const LOG_SUFFIX = /\.(?:log|txt)$/;
const TEARDOWN_VERIFIED = /Teardown verified\./;
const SUMMARY_LOG = "summary.log";

/**
 * `=== <stage>` / `exit=<n>` in the integrator's own summary log.
 *
 * A stage header is the WHOLE line after `===`, because the integrator's own
 * stages are multi-word (`native mysql2 (docker)`). Every header line resets
 * the open stage, so an `exit=<n>` can only ever belong to the header directly
 * above it: a header this reader failed to understand loses its own code
 * rather than lending it to the stage before.
 */
function recordedExitCodes(directory) {
  const summary = resolve(directory, SUMMARY_LOG);
  if (!existsSync(summary)) return {};
  const codes = {};
  let stage;
  for (const line of readFileSync(summary, "utf8").split("\n")) {
    if (SUMMARY_HEADER.test(line)) {
      const header = SUMMARY_STAGE.exec(line);
      stage = header ? header[1] : undefined;
      continue;
    }
    const exit = SUMMARY_EXIT.exec(line);
    if (exit && stage !== undefined) {
      codes[stage] = Number(exit[1]);
      stage = undefined;
    }
  }
  return codes;
}

/**
 * The resource/teardown sentence the bounded launchers print as their LAST
 * such line, and the vitest counts. Both are quoted verbatim; neither is
 * recomputed here.
 */
const RESOURCE_LINE =
  /^(?:Vitest|Node) resources: .*$|^\[[^\]]+\] .*: .*wall.*$/;
const TEST_FILES_LINE = /^\s*Test Files\s+.*$/;
const TESTS_LINE = /^\s*Tests\s+.*$/;

function readStage(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const last = (pattern) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (pattern.test(lines[index])) return lines[index].trim();
    }
    return undefined;
  };
  return {
    bytes: statSync(file).size,
    sha256: sha256(readFileSync(file)),
    resources: last(RESOURCE_LINE),
    teardownVerified: TEARDOWN_VERIFIED.test(text),
    testFiles: last(TEST_FILES_LINE),
    tests: last(TESTS_LINE),
  };
}

const exitCodes = recordedExitCodes(gateDirectory);
const stages = readdirSync(gateDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== SUMMARY_LOG)
  .map((entry) => entry.name)
  .sort()
  .map((name) => {
    const stage = name.replace(LOG_SUFFIX, "");
    return {
      stage,
      log: name,
      exit: Object.hasOwn(exitCodes, stage) ? exitCodes[stage] : "unrecorded",
      ...readStage(resolve(gateDirectory, name)),
    };
  });

/**
 * A stage the summary recorded an exit code for under a name no log file
 * carries. It is listed rather than guessed at: a recorded `exit=1` that
 * matches no `<stage>.log` must stay visible, and inventing the mapping here
 * would make this reader a second owner of the integrator's stage names.
 */
const loggedStages = new Set(stages.map((stage) => stage.stage));
const stagesWithoutLog = Object.entries(exitCodes)
  .filter(([stage]) => !loggedStages.has(stage))
  .map(([stage, exit]) => ({ stage, exit }))
  .sort((left, right) => left.stage.localeCompare(right.stage));

/* --------------------------------------------------------------- manifests */

/**
 * Every test path any registered manifest names, and the cell counts the
 * manifests that carry them declare. The manifest modules are the owners; this
 * walk states no list of its own.
 */
const MANIFEST_MODULES = [
  "scripts/raptor3-manifest.mjs",
  "scripts/credential-free-test-manifest.mjs",
  "scripts/client-test-manifest.mjs",
  "scripts/driver-test-manifest.mjs",
  "scripts/migration-test-manifest.mjs",
  "scripts/query-engine-test-manifest.mjs",
];

async function readManifests() {
  const lists = {};
  const counts = {};
  const paths = new Set();
  for (const module of MANIFEST_MODULES) {
    const exported = await import(`../${module}`);
    for (const [name, value] of Object.entries(exported)) {
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        lists[name] = value.length;
        for (const item of value) {
          if (item.endsWith(".test.ts")) paths.add(item);
        }
      } else if (
        value &&
        typeof value === "object" &&
        Object.values(value).every((count) => typeof count === "number")
      ) {
        counts[name] = Object.values(value).reduce(
          (total, count) => total + count,
          0
        );
        for (const item of Object.keys(value)) {
          if (item.endsWith(".test.ts")) paths.add(item);
        }
      }
    }
  }
  return {
    modules: MANIFEST_MODULES.map((module) => ({
      module,
      sha256: sha256(readFileSync(resolve(root, module))),
    })),
    lists,
    declaredCells: counts,
    registeredFiles: [...paths].sort(),
  };
}

const manifests = await readManifests();

/**
 * Harness identity: the registered test files themselves, plus the manifest
 * modules that name them. `calibrationSourceIdentity` already attests `src/`,
 * `benchmarks/`, `scripts/` and the lockfile; `tests/` is the half it does not
 * reach, and a gate is only as identified as the harness that ran it.
 */
const harnessFiles = manifests.registeredFiles
  .filter((file) => existsSync(resolve(root, file)))
  .map((file) => ({
    file,
    sha256: sha256(readFileSync(resolve(root, file))),
  }));
const missingHarnessFiles = manifests.registeredFiles.filter(
  (file) => !existsSync(resolve(root, file))
);
const harnessHash = createHash("sha256");
for (const { file, sha256: digest } of harnessFiles) {
  harnessHash.update(file).update("\0").update(digest).update("\0");
}

/* -------------------------------------------------------------- identities */

const manifestJson = readJson("package.json");
const runtime = {
  node: process.version,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  pnpm: (() => {
    try {
      return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "unavailable";
    }
  })(),
  lockfileSha256: sha256(readFileSync(resolve(root, "pnpm-lock.yaml"))),
  packageJsonSha256: sha256(readFileSync(resolve(root, "package.json"))),
  dependencies: manifestJson.dependencies,
  peerDependencies: manifestJson.peerDependencies,
  packageManager: manifestJson.packageManager,
};

const source = {
  commit: git("rev-parse", "HEAD"),
  describe: git("log", "-1", "--format=%H %cI %s"),
  workingTree: git("status", "--porcelain"),
  identity: calibrationSourceIdentity(root).sha256,
  identityScope:
    "src/, benchmarks/, scripts/, package.json, pnpm-lock.yaml, tsconfig.json, tsdown.config.ts, biome.jsonc — the existing calibration owner",
};

/* ------------------------------------------------------- measured readings */

const measurement = measurementFile ? readJson(measurementFile) : undefined;
const recount = recountFile ? readJson(recountFile) : undefined;

/**
 * The bundle reading, summarised. The per-module detail stays in the
 * measurement file this index names; copying it here would duplicate a
 * megabyte of it under a second owner.
 */
const bundles = measurement
  ? {
      status: measurement.status,
      measurementFile: relative(root, resolve(root, measurementFile)),
      commit: measurement.source.commit,
      clean: measurement.source.clean,
      sourceIdentity: measurement.source.sourceIdentity.sha256,
      frozenTargets: measurement.frozenTargets,
      fixtures: Object.entries(measurement.bundles ?? {}).map(
        ([fixture, value]) => ({
          fixture,
          runtimeBytes: value.runtimeBytes,
          gzipBytes: value.gzipBytes,
          modules: value.modules.length,
          sha256: value.sha256,
        })
      ),
    }
  : { status: "not supplied to this index" };

/* ------------------------------------------------------------------ output */

mkdirSync(resolve(outDirectory, "logs"), { recursive: true });
for (const stage of stages) {
  copyFileSync(
    resolve(gateDirectory, stage.log),
    resolve(outDirectory, "logs", stage.log)
  );
}

const index = {
  version: 1,
  label,
  assembledBy: relative(
    root,
    resolve(import.meta.dirname, "closure-final-index.mjs")
  ),
  assembledAt: new Date().toISOString(),
  gateDirectory: gateDirectory.startsWith(root)
    ? relative(root, gateDirectory)
    : gateDirectory,
  source,
  runtime,
  harness: {
    sha256: harnessHash.digest("hex"),
    registeredFiles: harnessFiles.length,
    missingFiles: missingHarnessFiles,
    manifestModules: manifests.modules,
    lists: manifests.lists,
    declaredCells: manifests.declaredCells,
  },
  stages,
  stagesWithoutLog,
  bundles,
  loc: recount ?? { status: "not supplied to this index" },
};

writeFileSync(
  resolve(outDirectory, "index.json"),
  `${JSON.stringify(index, null, 2)}\n`
);

const cell = (value) => String(value ?? "—").replaceAll("|", "\\|");
const markdown = [
  `# Final local release index — ${label}`,
  "",
  `Assembled ${index.assembledAt} by \`${index.assembledBy}\` from \`${index.gateDirectory}\`.`,
  "Raw logs are copied verbatim under `logs/`; nothing here is recomputed or",
  "reconstructed.",
  "",
  "## 1. Source identity",
  "",
  `- commit: \`${source.commit}\``,
  `- head: ${source.describe}`,
  `- calibration source identity: \`${source.identity}\``,
  `- scope: ${source.identityScope}`,
  `- working tree at assembly: ${source.workingTree === "" ? "clean" : `\n\n\`\`\`\n${source.workingTree}\n\`\`\`\n`}`,
  "",
  "## 2. Harness identity",
  "",
  `- registered test files: ${index.harness.registeredFiles}`,
  `- harness identity: \`${index.harness.sha256}\``,
  ...(missingHarnessFiles.length === 0
    ? []
    : [
        `- registered but absent from the tree: ${missingHarnessFiles.join(", ")}`,
      ]),
  "",
  "| manifest module | sha256 |",
  "| --- | --- |",
  ...manifests.modules.map(
    ({ module, sha256: digest }) => `| \`${module}\` | \`${digest}\` |`
  ),
  "",
  "## 3. Runtime and dependency identity",
  "",
  `- node: \`${runtime.node}\` (v8 \`${runtime.v8}\`, ${runtime.platform}/${runtime.arch})`,
  `- pnpm: \`${runtime.pnpm}\`, \`packageManager\`: \`${runtime.packageManager ?? "unset"}\``,
  `- \`pnpm-lock.yaml\`: \`${runtime.lockfileSha256}\``,
  `- \`package.json\`: \`${runtime.packageJsonSha256}\``,
  "",
  "## 4. Gate stages",
  "",
  "| stage | exit | test files | tests | resources / teardown | log sha256 |",
  "| --- | --- | --- | --- | --- | --- |",
  ...stages.map(
    (stage) =>
      `| \`${stage.stage}\` | ${cell(stage.exit)} | ${cell(stage.testFiles)} | ${cell(stage.tests)} | ${cell(stage.resources)} | \`${stage.sha256.slice(0, 16)}…\` |`
  ),
  "",
  ...(stagesWithoutLog.length === 0
    ? ["Every stage the summary recorded an exit code for has a log above."]
    : [
        "### Summary stages with no log",
        "",
        "The summary recorded an exit code under these names and no",
        "`<stage>.log` carries them, so their codes are stated here rather than",
        "dropped or attached to a neighbour.",
        "",
        "| summary stage | exit |",
        "| --- | --- |",
        ...stagesWithoutLog.map(
          (entry) => `| \`${entry.stage}\` | ${cell(entry.exit)} |`
        ),
      ]),
  "",
  "## 5. Registered inventory",
  "",
  "| list | files |",
  "| --- | --- |",
  ...Object.entries(manifests.lists)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `| \`${name}\` | ${count} |`),
  "",
  "| declared-cell map | cells |",
  "| --- | --- |",
  ...Object.entries(manifests.declaredCells)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `| \`${name}\` | ${count} |`),
  "",
  "## 6. Bundles",
  "",
  ...(bundles.fixtures === undefined
    ? [`Not supplied to this index (\`${bundles.status}\`).`]
    : [
        `From \`${bundles.measurementFile}\` (commit \`${bundles.commit}\`, clean: ${bundles.clean}, status \`${bundles.status}\`).`,
        "The per-module detail stays in that file.",
        "",
        "| fixture | runtime bytes | gzip bytes | modules | sha256 |",
        "| --- | --- | --- | --- | --- |",
        ...bundles.fixtures.map(
          (fixture) =>
            `| \`${fixture.fixture}\` | ${fixture.runtimeBytes.toLocaleString("en-US")} | ${fixture.gzipBytes.toLocaleString("en-US")} | ${fixture.modules} | \`${fixture.sha256.slice(0, 16)}…\` |`
        ),
        "",
        `Targets: engine gzip ratio ≤ ${bundles.frozenTargets.engineGzipRatio}, every public PostgreSQL fixture ≤ ${bundles.frozenTargets.everyPublicPostgresGzipRatio}. The ratios themselves are computed against the frozen bundle baseline, which this index does not hold.`,
      ]),
  "",
  "## 7. LOC and the charged perimeter",
  "",
  ...(index.loc.totals === undefined
    ? [`Not supplied to this index (\`${index.loc.status}\`).`]
    : [
        "| class | files | token LOC | physical | bytes |",
        "| --- | --- | --- | --- | --- |",
        ...Object.entries(index.loc.totals).map(
          ([name, value]) =>
            `| ${name} | ${value.files} | ${value.tokenLines.toLocaleString("en-US")} | ${value.physical.toLocaleString("en-US")} | ${value.bytes.toLocaleString("en-US")} |`
        ),
        "",
        "| unit | files | charged-engine ± | charged total ± |",
        "| --- | --- | --- | --- |",
        ...(index.loc.units ?? []).map((unit) => {
          const charged = Object.entries(unit.buckets).filter(([bucket]) =>
            bucket.startsWith("charged-")
          );
          const engineBucket = unit.buckets["charged-engine"];
          const total = charged.reduce(
            (sum, [, value]) => ({
              added: sum.added + value.added,
              deleted: sum.deleted + value.deleted,
            }),
            { added: 0, deleted: 0 }
          );
          return `| \`${unit.name}\` (\`${unit.range}\`) | ${unit.files} | +${engineBucket?.added ?? 0} / −${engineBucket?.deleted ?? 0} | +${total.added} / −${total.deleted} |`;
        }),
        "",
        `Full detail: \`${index.loc.measurement?.file ?? "the recount file"}\` and the recount beside it.`,
      ]),
  "",
].join("\n");

writeFileSync(resolve(outDirectory, "index.md"), markdown);

process.stdout.write(
  `closure-final-index: ${stages.length} stages (${stagesWithoutLog.length} summary stage(s) with no log), ${index.harness.registeredFiles} registered test files -> ${relative(root, outDirectory)}\n`
);
