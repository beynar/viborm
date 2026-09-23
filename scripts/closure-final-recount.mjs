/**
 * The like-for-like recount, runnable on the final tree.
 *
 * It states no LOC definition of its own. The totals come from
 * `measure-raptor3-baseline.mjs` — the reader that owns the charged
 * classification and executes `query-engine-structure.mjs`'s own
 * `countTokenLines` — and this script only groups, divides and tabulates what
 * that reader answered, exactly as `g4/release/closure/fc06/receipts/
 * loc-recount.md` did by hand.
 *
 *   node scripts/closure-final-recount.mjs --out <dir> \
 *     [--measurement <baseline.json>] \
 *     [--unit <name>=<base>..<tip>]...
 *
 * `--measurement` reuses an existing reading (the integrator's own run on the
 * final tree); without it the reader is invoked here, into the output
 * directory. Each `--unit` is one charged-perimeter diff: every `src/` file the
 * range touches, bucketed by the SAME classification the totals use, so a rule
 * moved out of the engine into a driver, an adapter, a codec or a migration is
 * visible rather than absorbed. A `src/` path the range DELETED is absent from
 * that classification — the reader measured the final tree — so it is bucketed
 * as `removed-or-unclassified-production` rather than called uncharged.
 * `tests/`, `scripts/`, `docs/` and `benchmarks/` are reported beside it as the
 * non-production volume they are.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function option(name, { required = false } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) {
    if (required) throw new Error(`Missing required --${name}`);
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} needs a value`);
  return value;
}
function options(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}`) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`--${name} needs a value`);
      values.push(value);
    }
  }
  return values;
}

const outDirectory = resolve(root, option("out", { required: true }));
mkdirSync(outDirectory, { recursive: true });

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

/* ------------------------------------------------ the one measured reading */

let measurementFile = option("measurement");
if (!measurementFile) {
  measurementFile = resolve(outDirectory, "source-size.json");
  execFileSync(
    process.execPath,
    ["scripts/measure-raptor3-baseline.mjs", "--output", measurementFile],
    { cwd: root, stdio: "inherit" }
  );
}
const measurement = JSON.parse(
  readFileSync(resolve(root, measurementFile), "utf8")
);

/** file -> the reader's own classification, for every production file. */
const classificationOf = new Map(
  measurement.files.map((file) => [file.file, file.classification])
);

const sum = (files) =>
  files.reduce(
    (total, file) => ({
      files: total.files + 1,
      tokenLines: total.tokenLines + file.tokenLines,
      physical: total.physical + file.physicalLines,
      bytes: total.bytes + file.bytes,
    }),
    { files: 0, tokenLines: 0, physical: 0, bytes: 0 }
  );
const byClass = (name) =>
  sum(measurement.files.filter((file) => file.classification === name));

const engine = byClass("charged-engine");
const integration = byClass("charged-integration");
const adapterIntegration = byClass("charged-adapter-integration");
const prepShared = byClass("charged-g3-prep-shared");
const likeForLike = sum(
  measurement.files.filter((file) =>
    [
      "charged-engine",
      "charged-integration",
      "charged-adapter-integration",
    ].includes(file.classification)
  )
);
const charged = sum(
  measurement.files.filter((file) => file.classification.startsWith("charged-"))
);

/**
 * The old-engine denominators, QUOTED from the recorded evidence rather than
 * recomputed: a revision whose engine no longer exists cannot be re-measured
 * from this tree, and substituting a different baseline would silently change
 * every ratio below.
 */
const DENOMINATORS = [
  {
    name: "frozen 146-file census",
    provenance:
      'docs/architecture/raptor3-evidence/g4.md, "Census corrected", 16:40 2026-09-16',
    engineTokenLines: 46_021,
    withIntegrationTokenLines: 49_887,
    physical: undefined,
    bytes: undefined,
  },
  {
    name: "ff5e77ca5 charged-engine",
    provenance:
      "docs/architecture/raptor3-evidence/g4/qualified/support/source-cost.json (the tool's own classification while the old engine shipped)",
    engineTokenLines: 45_570,
    withIntegrationTokenLines: undefined,
    physical: 59_815,
    bytes: 2_121_028,
  },
  {
    name: "3a291a59 src/query-engine minus the retired pattern/ experiment",
    provenance: "the plan's provisional navigation denominator",
    engineTokenLines: 47_625,
    withIntegrationTokenLines: undefined,
    physical: 62_149,
    bytes: 2_197_061,
  },
];

const ratio = (value, denominator) =>
  denominator === undefined
    ? undefined
    : Number((value / denominator).toFixed(4));

const ratios = DENOMINATORS.map((denominator) => ({
  ...denominator,
  engineTokenRatio: ratio(engine.tokenLines, denominator.engineTokenLines),
  withIntegrationTokenRatio: ratio(
    likeForLike.tokenLines,
    denominator.withIntegrationTokenLines
  ),
  enginePhysicalRatio: ratio(engine.physical, denominator.physical),
  engineByteRatio: ratio(engine.bytes, denominator.bytes),
}));

/* ------------------------------------------------------ per-unit perimeter */

const NON_PRODUCTION = ["tests/", "scripts/", "docs/", "benchmarks/"];

function bucketOf(file) {
  const classification = classificationOf.get(file);
  if (classification) return classification;
  if (file.startsWith("src/")) {
    // The classification map is built from the FINAL tree, so a production file
    // the range DELETED is absent from it. It was not "uncharged": it is gone,
    // and a removed engine rule is exactly what the per-unit table exists to
    // show. Saying so is the honest answer; re-deriving a class for a path the
    // measurement no longer holds would be a second classification owner.
    return "removed-or-unclassified-production";
  }
  const prefix = NON_PRODUCTION.find((candidate) => file.startsWith(candidate));
  return prefix
    ? `non-production:${prefix.slice(0, -1)}`
    : "non-production:other";
}

function numstat(range) {
  const lines = git("diff", "--numstat", range).trim();
  if (lines === "") return [];
  return lines.split("\n").map((line) => {
    const [added, deleted, file] = line.split("\t");
    return {
      file,
      added: added === "-" ? null : Number(added),
      deleted: deleted === "-" ? null : Number(deleted),
    };
  });
}

const units = options("unit").map((argument) => {
  const separator = argument.indexOf("=");
  if (separator < 0)
    throw new Error(`--unit wants <name>=<base>..<tip>: ${argument}`);
  const name = argument.slice(0, separator);
  const range = argument.slice(separator + 1);
  const entries = numstat(range);
  const buckets = {};
  for (const entry of entries) {
    const bucket = bucketOf(entry.file);
    buckets[bucket] ??= { files: 0, added: 0, deleted: 0, paths: [] };
    buckets[bucket].files += 1;
    buckets[bucket].added += entry.added ?? 0;
    buckets[bucket].deleted += entry.deleted ?? 0;
    buckets[bucket].paths.push(entry.file);
  }
  for (const bucket of Object.values(buckets)) bucket.paths.sort();
  return {
    name,
    range,
    resolved: {
      base: git("rev-parse", range.split("..")[0]).trim(),
      tip: git("rev-parse", range.split("..")[1] ?? "HEAD").trim(),
    },
    files: entries.length,
    buckets,
  };
});

/* ------------------------------------------------------------------ output */

const report = {
  version: 1,
  producedAt: new Date().toISOString(),
  measurement: {
    file: relative(root, resolve(root, measurementFile)),
    status: measurement.status,
    commit: measurement.source.commit,
    clean: measurement.source.clean,
    sourceIdentity: measurement.source.sourceIdentity.sha256,
    censusOwner: measurement.accounting.censusOwner,
    censusFunctionSha256: measurement.accounting.censusFunctionSha256,
    definition: measurement.accounting.definition,
  },
  totals: {
    "charged-engine": engine,
    "charged-integration": integration,
    "charged-adapter-integration": adapterIntegration,
    likeForLike,
    "charged-g3-prep-shared": prepShared,
    charged,
  },
  ratios,
  frozenTargets: measurement.frozenTargets,
  units,
};

writeFileSync(
  resolve(outDirectory, "recount.json"),
  `${JSON.stringify(report, null, 2)}\n`
);

const row = (name, value) =>
  `| ${name} | ${value.files} | ${value.tokenLines.toLocaleString("en-US")} | ${value.physical.toLocaleString("en-US")} | ${value.bytes.toLocaleString("en-US")} |`;

const markdown = [
  "# The like-for-like recount",
  "",
  `Produced ${report.producedAt} by \`scripts/closure-final-recount.mjs\` from`,
  `\`${report.measurement.file}\` (commit \`${report.measurement.commit}\`,`,
  `clean: ${report.measurement.clean}, status \`${report.measurement.status}\`).`,
  "",
  `Token line = ${report.measurement.definition}. The definition and the charged`,
  `classification belong to \`${report.measurement.censusOwner}\` and`,
  "`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.",
  "",
  "## 1. The charged perimeter",
  "",
  "| class | files | token LOC | physical | bytes |",
  "| --- | --- | --- | --- | --- |",
  row("charged-engine (`src/query-engine/**`)", engine),
  row("charged-integration", integration),
  row("charged-adapter-integration", adapterIntegration),
  row("**like-for-like total**", likeForLike),
  row("charged-g3-prep-shared (reported apart)", prepShared),
  row("**charged, everything the tool charges**", charged),
  "",
  "## 2. Against the recorded old-engine denominators",
  "",
  "These denominators are QUOTED from the evidence tree; a revision whose engine",
  "no longer exists cannot be re-measured from this tree.",
  "",
  "| denominator | engine token | with integration | engine physical | engine bytes |",
  "| --- | --- | --- | --- | --- |",
  ...ratios.map(
    (entry) =>
      `| ${entry.name} | ${entry.engineTokenRatio ?? "—"} | ${entry.withIntegrationTokenRatio ?? "—"} | ${entry.enginePhysicalRatio ?? "—"} | ${entry.engineByteRatio ?? "—"} |`
  ),
  "",
  `Plan §7 targets: token ≤ ${measurement.frozenTargets.productionTokenRatio}, physical ≤ ${measurement.frozenTargets.productionPhysicalRatio}.`,
  "",
  "## 3. Per unit, over the complete charged perimeter",
  "",
  ...(units.length === 0
    ? ["No `--unit` range was given."]
    : units.flatMap((unit) => [
        `### ${unit.name} — \`${unit.range}\` (${unit.resolved.base.slice(0, 9)}..${unit.resolved.tip.slice(0, 9)}), ${unit.files} files`,
        "",
        "| bucket | files | + | − |",
        "| --- | --- | --- | --- |",
        ...Object.entries(unit.buckets)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(
            ([bucket, value]) =>
              `| \`${bucket}\` | ${value.files} | ${value.added} | ${value.deleted} |`
          ),
        "",
      ])),
].join("\n");

writeFileSync(resolve(outDirectory, "recount.md"), `${markdown}\n`);

process.stdout.write(
  `closure-final-recount: engine ${engine.tokenLines} token LOC, charged ${charged.tokenLines}; ${units.length} unit range(s) -> ${relative(root, outDirectory)}\n`
);
