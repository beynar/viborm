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
 * The registered inventory is `closure-final-inventory.mjs`'s answer, not a
 * second walk: that module derives each project's file list from
 * `vitest.workspace.ts`'s own include patterns, so a project this index reports
 * as registering N files is the project a gate stage must run in full.
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
import {
  gatePlan,
  inventory,
  MANIFEST_MODULES,
} from "./closure-final-inventory.mjs";

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
 * walk states no list of its own, and WHICH modules they are is
 * `closure-final-inventory.mjs`'s `MANIFEST_MODULES` — one list, imported,
 * not a second copy that can drift when a manifest is added.
 *
 * The two readers aggregate the same maps differently on purpose: this one
 * reports a map's total for the manifest table, the inventory reports a
 * FILE's cells so a stage's declared count can be told apart from its
 * executions.
 */
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

/**
 * The complete Git TREE identities, and the config digests beside them.
 *
 * The manifest digest above covers the paths the manifests name; it does not
 * reach a native entry file or an imported fixture. A Git tree id does reach
 * every byte under its path, so "the squash carries the same `src`" is stated
 * here as the object identity it is — and named as a Git object id (SHA-1 over
 * the tree object), which is NOT the same algorithm as the sha256 digests in
 * the rest of this index. Different algorithms are never printed as one
 * harness identity.
 */
const TREE_SCOPES = ["src", "tests", "scripts", "benchmarks"];
const CONFIG_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsdown.config.ts",
  "biome.jsonc",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "vitest.d1.config.ts",
];

const source = {
  commit: git("rev-parse", "HEAD"),
  describe: git("log", "-1", "--format=%H %cI %s"),
  workingTree: git("status", "--porcelain"),
  identity: calibrationSourceIdentity(root).sha256,
  identityAlgorithm: "sha256 over the calibration owner's named file set",
  identityScope:
    "src/, benchmarks/, scripts/, package.json, pnpm-lock.yaml, tsconfig.json, tsdown.config.ts, biome.jsonc — the existing calibration owner",
  trees: {
    algorithm: "git object id (SHA-1 tree object)",
    scope: "every byte under the named path at this commit",
    commit: git("rev-parse", "HEAD^{tree}"),
    ...Object.fromEntries(
      TREE_SCOPES.map((scope) => [scope, git("rev-parse", `HEAD:${scope}`)])
    ),
  },
  configDigests: {
    algorithm: "sha256 over the file's bytes in the working tree",
    files: Object.fromEntries(
      CONFIG_FILES.filter((file) => existsSync(resolve(root, file))).map(
        (file) => [file, sha256(readFileSync(resolve(root, file)))]
      )
    ),
  },
};

/**
 * The retained review the checkpoint answers, by its own identity.
 *
 * A review directory is evidence like any log: it is named, counted and
 * hashed here so a later reader can tell WHICH review's witnesses this
 * checkpoint converted. Directories are discovered by the `closure-review`
 * prefix the reviewer already uses, which covers both the bare directory of
 * the review a checkpoint answers and the `closure-review-<sha>` spelling a
 * later round retains beside it, so no list of them is kept anywhere. A
 * trailing hyphen in the prefix excluded the bare directory and printed "No
 * retained review directory sits beside this checkpoint" over a tracked one.
 */
const REVIEW_PARENT = "docs/architecture/raptor3-evidence/g4/release";
const REVIEW_PREFIX = "closure-review";

function directoryIdentity(directory) {
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        entries.push({
          file: relative(directory, path).replaceAll("\\", "/"),
          sha256: sha256(readFileSync(path)),
        });
      }
    }
  };
  walk(directory);
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(entry.file).update("\0").update(entry.sha256).update("\0");
  }
  return { files: entries.length, sha256: digest.digest("hex") };
}

const reviewParent = resolve(root, REVIEW_PARENT);
const retainedReviews = existsSync(reviewParent)
  ? readdirSync(reviewParent, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(REVIEW_PREFIX)
      )
      .map((entry) => ({
        review: `${REVIEW_PARENT}/${entry.name}`,
        algorithm:
          "sha256 over the directory's sorted (path, file sha256) pairs",
        ...directoryIdentity(resolve(reviewParent, entry.name)),
      }))
      .sort((left, right) => left.review.localeCompare(right.review))
  : [];

/* ---------------------------------------------------- registered inventory */

/**
 * Which files each workspace project registers, derived from the workspace's
 * own include patterns by `closure-final-inventory.mjs`.
 *
 * The manifest lists below state how many paths a manifest NAMES. This states
 * how many files a PROJECT registers, and the two are not the same number: the
 * gate that produced the previous checkpoint enumerated `provider-mysql2` by a
 * shell glob and ran eleven of its thirteen registered files. A stage's test
 * total is executed cells across project executions — a file registered in two
 * projects executes twice — so executions and declared cells are reported as
 * separate columns rather than one total.
 */
const registered = await inventory(root);
const projects = registered.projects.map((project) => ({
  project: project.project,
  source: project.source,
  files: project.files.length,
  credentialEnvironment: project.credentialEnvironment,
  declaredCells: project.declaredCells,
  filesWithDeclaredCells: project.declaredCellsKnownFor,
  registeredButAbsent: project.registeredButAbsent,
}));
const plan = gatePlan(registered).map((stage) => ({
  stage: stage.name,
  kind: stage.kind,
  command: stage.command,
  credentialEnvironment: stage.credentialEnvironment,
  files: stage.files,
  totals: stage.totals,
}));

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
  retainedReviews,
  runtime,
  harness: {
    sha256: harnessHash.digest("hex"),
    algorithm:
      "sha256 over the sorted (path, file sha256) pairs of every path a manifest names",
    registeredFiles: harnessFiles.length,
    missingFiles: missingHarnessFiles,
    manifestModules: manifests.modules,
    lists: manifests.lists,
    declaredCells: manifests.declaredCells,
  },
  registered: {
    derivedFrom:
      "vitest.workspace.ts and vitest.d1.config.ts include patterns, expanded by scripts/closure-final-inventory.mjs",
    projects,
    plan,
    unregisteredTestFiles: registered.unregistered,
    unresolvedIncludeSpreads: registered.unresolvedSpreads,
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
  `- calibration source identity: \`${source.identity}\` (${source.identityAlgorithm})`,
  `- scope: ${source.identityScope}`,
  `- working tree at assembly: ${source.workingTree === "" ? "clean" : `\n\n\`\`\`\n${source.workingTree}\n\`\`\`\n`}`,
  "",
  `Git TREE identities — ${source.trees.algorithm}, ${source.trees.scope}. These are`,
  "complete: unlike the manifest digest, they reach native entry files and",
  "imported fixtures. A squash that reports the same ids carries the same bytes.",
  "",
  "| scope | git object id |",
  "| --- | --- |",
  `| commit tree | \`${source.trees.commit}\` |`,
  ...TREE_SCOPES.map(
    (scope) => `| \`${scope}/\` | \`${source.trees[scope]}\` |`
  ),
  "",
  `Config and lockfile digests — ${source.configDigests.algorithm}. A sha256 of a`,
  "file's bytes and a Git tree id are different algorithms over different",
  "scopes; neither stands in for the other.",
  "",
  "| file | sha256 |",
  "| --- | --- |",
  ...Object.entries(source.configDigests.files).map(
    ([file, digest]) => `| \`${file}\` | \`${digest}\` |`
  ),
  "",
  ...(retainedReviews.length === 0
    ? ["No retained review directory sits beside this checkpoint."]
    : [
        "Retained review evidence this checkpoint answers:",
        "",
        "| review | files | identity |",
        "| --- | --- | --- |",
        ...retainedReviews.map(
          (review) =>
            `| \`${review.review}\` | ${review.files} | \`${review.sha256}\` (${review.algorithm}) |`
        ),
      ]),
  "",
  "## 2. Harness identity",
  "",
  `- test files a manifest names: ${index.harness.registeredFiles}`,
  `- harness identity: \`${index.harness.sha256}\` (${index.harness.algorithm})`,
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
  `Derived from ${index.registered.derivedFrom}. A gate stage must run a`,
  "project's whole registered list; a hand-written glob over the same directory",
  "is what omitted two `provider-mysql2` files from the previous checkpoint.",
  "",
  "**Executions are not cases.** A file registered in two projects executes",
  "twice, so a stage's reported `Tests` total is executed cells across project",
  "executions, not that many distinct declared cases. Both columns are below.",
  "",
  "| project | source | files | project needs | declared cells (files declaring) |",
  "| --- | --- | --- | --- | --- |",
  ...projects.map(
    (project) =>
      `| \`${project.project}\` | \`${project.source}\` | ${project.files} | ${project.credentialEnvironment ? `\`${project.credentialEnvironment}\`` : "no credentials"} | ${project.declaredCells} (${project.filesWithDeclaredCells} of ${project.files}) |`
  ),
  "",
  ...(projects.every((project) => project.registeredButAbsent.length === 0)
    ? []
    : [
        "Registered by a project and absent from the tree:",
        "",
        ...projects
          .filter((project) => project.registeredButAbsent.length > 0)
          .map(
            (project) =>
              `- \`${project.project}\`: ${project.registeredButAbsent.join(", ")}`
          ),
        "",
      ]),
  "### The gate plan this inventory implies",
  "",
  "| stage | kind | files | project executions | declared cells |",
  "| --- | --- | --- | --- | --- |",
  ...plan.map(
    (stage) =>
      `| \`${stage.stage}\` | ${stage.kind} | ${stage.totals ? stage.totals.files : "—"} | ${stage.totals ? stage.totals.projectExecutions : "—"} | ${stage.totals ? `${stage.totals.declaredCells} (${stage.totals.filesWithDeclaredCells} of ${stage.totals.files})` : "—"} |`
  ),
  "",
  "A `runner-mode` stage's files belong to `scripts/run-raptor3.mjs`'s own mode",
  "table, which asserts its declared counts, so none is restated here.",
  "Full lists: `node scripts/closure-final-inventory.mjs plan`.",
  "",
  ...(index.registered.unregisteredTestFiles.length === 0
    ? []
    : [
        `${index.registered.unregisteredTestFiles.length} test file(s) in the tree are in no workspace project (listed in \`index.json\`); a new witness placed outside every include pattern would appear here rather than pass unnoticed.`,
        "",
      ]),
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
