import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";
import { countTokenLines, censusFunctionSha256, censusScriptPath } from "./census-fn.mjs";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const BASE = "0cc61e61";

function measureText(path, text) {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    physicalLines: text.match(/\n/g)?.length ?? 0,
    tokenLines: countTokenLines(
      ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    ),
  };
}

function measureFile(rel) {
  const abs = resolve(ROOT, rel);
  const text = readFileSync(abs, "utf8");
  const m = measureText(abs, text);
  // statSync size cross-check (G3's own receipt used statSync size)
  m.statBytes = statSync(abs).size;
  return m;
}

function measureAtBase(rel) {
  try {
    const text = execFileSync("git", ["show", `${BASE}:${rel}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return measureText(resolve(ROOT, rel), text);
  } catch {
    return null; // absent at base
  }
}

function group(label, files) {
  const per = {};
  const total = { files: files.length, bytes: 0, physicalLines: 0, tokenLines: 0 };
  for (const f of files) {
    const m = measureFile(f);
    per[f] = m;
    total.bytes += m.bytes;
    total.physicalLines += m.physicalLines;
    total.tokenLines += m.tokenLines;
  }
  return { label, total, files: per };
}

const g3Cost = JSON.parse(
  readFileSync(
    resolve(
      ROOT,
      "docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/support/source-cost.json"
    ),
    "utf8"
  )
);
const g3Commands = g3Cost.privateCandidates.candidates.commands;
const g3Files = g3Commands.files;
const language7 = g3Files.filter((f) => f.startsWith("src/query-engine/raptor3/commands/"));
const shared5 = g3Files.filter((f) => f.startsWith("src/query-engine/raptor3/shared/"));
const retained18 = g3Files.filter(
  (f) => !f.startsWith("src/query-engine/raptor3/")
);

// whole raptor3 tree, current
const raptor3Files = execFileSync(
  "bash",
  ["-c", `cd ${ROOT} && find src/query-engine/raptor3 -type f -name '*.ts' | sort`],
  { encoding: "utf8" }
)
  .trim()
  .split("\n");

const routeFile = "src/query-engine/raptor3/route/client-route.ts";
const deltaFiles = [
  "src/client/client.ts",
  "src/query-engine/query-engine.ts",
  "src/query-engine/pending-operation.ts",
  "src/adapters/database-adapter.ts",
  "src/adapters/databases/mysql/mysql-adapter.ts",
  "src/adapters/databases/postgres/postgres-adapter.ts",
  "src/adapters/databases/sqlite/sqlite-adapter.ts",
];

// git diff --numstat for the delta files
const numstatRaw = execFileSync(
  "git",
  ["diff", "--numstat", BASE, "--", ...deltaFiles],
  { cwd: ROOT, encoding: "utf8" }
);
const numstat = {};
for (const line of numstatRaw.trim().split("\n").filter(Boolean)) {
  const [added, deleted, file] = line.split("\t");
  numstat[file] = { addedLines: Number(added), deletedLines: Number(deleted) };
}

const deltas = {};
for (const f of deltaFiles) {
  const now = measureFile(f);
  const base = measureAtBase(f);
  deltas[f] = {
    numstat: numstat[f] ?? { addedLines: 0, deletedLines: 0 },
    base: base && { bytes: base.bytes, physicalLines: base.physicalLines, tokenLines: base.tokenLines },
    now: { bytes: now.bytes, physicalLines: now.physicalLines, tokenLines: now.tokenLines },
    delta: base && {
      bytes: now.bytes - base.bytes,
      physicalLines: now.physicalLines - base.physicalLines,
      tokenLines: now.tokenLines - base.tokenLines,
    },
    inG3Perimeter: g3Files.includes(f),
  };
}

// candidate core 12 = language7 + shared5, as they are now
const core12 = group("candidate-core-12", [...language7, ...shared5]);
const tree = group("raptor3-tree", raptor3Files);
const perimeter30 = group("g3-complete-charged-perimeter-30", g3Files);
const lang = group("language-7", language7);
const sh = group("shared-5", shared5);
const ret = group("retained-18", retained18);
const route = group("route-whole", [routeFile]);
// Shipped-engine owners the candidate newly retains at runtime (static runtime
// imports from route/client-route.ts). `write-engine/parse-boundary.ts` is the
// G3 precedent for charging such an owner whole in the retained list.
const newlyRetainedCacheOwners = group("newly-retained-cache-owners", [
  "src/query-engine/result/cache-value-codecs.ts",
  "src/query-engine/result/cache-json-codec.ts",
  "src/query-engine/result/cache-snapshot-structure.ts",
]);
const program = group("program-specimen", [
  "src/query-engine/raptor3/program/index.ts",
  "src/query-engine/raptor3/program/program.ts",
]);

// base (0cc61e61) measurement of the same G3 30-file list, for the G4 delta
const perimeter30AtBase = { files: 0, bytes: 0, physicalLines: 0, tokenLines: 0, missing: [] };
const core12AtBase = { files: 0, bytes: 0, physicalLines: 0, tokenLines: 0, missing: [] };
for (const f of g3Files) {
  const m = measureAtBase(f);
  if (!m) { perimeter30AtBase.missing.push(f); continue; }
  perimeter30AtBase.files += 1;
  perimeter30AtBase.bytes += m.bytes;
  perimeter30AtBase.physicalLines += m.physicalLines;
  perimeter30AtBase.tokenLines += m.tokenLines;
}
for (const f of [...language7, ...shared5]) {
  const m = measureAtBase(f);
  if (!m) { core12AtBase.missing.push(f); continue; }
  core12AtBase.files += 1;
  core12AtBase.bytes += m.bytes;
  core12AtBase.physicalLines += m.physicalLines;
  core12AtBase.tokenLines += m.tokenLines;
}

// reproduce the G3 recorded per-file sums from source-cost.json, as a recipe check
const recorded = new Map(g3Cost.files.map((r) => [r.file, r]));
const g3Recomputed = { language: {files:0,bytes:0,physicalLines:0,tokenLines:0}, shared: {files:0,bytes:0,physicalLines:0,tokenLines:0}, retained: {files:0,bytes:0,physicalLines:0,tokenLines:0} };
for (const [key, list] of [["language", language7], ["shared", shared5], ["retained", retained18]]) {
  for (const f of list) {
    const r = recorded.get(f);
    if (!r) { g3Recomputed[key].missingRecord = (g3Recomputed[key].missingRecord ?? []).concat(f); continue; }
    g3Recomputed[key].files += 1;
    g3Recomputed[key].bytes += r.bytes;
    g3Recomputed[key].physicalLines += r.physicalLines;
    g3Recomputed[key].tokenLines += r.tokenLines;
  }
}

// Test/harness lines, reported separately from the charged perimeter (plan §7).
const newTestDirs = ["tests/raptor3/g4", "tests/types/raptor3"];
const newTestFiles = execFileSync(
  "bash",
  ["-c", `cd ${ROOT} && find ${newTestDirs.join(" ")} -type f -name '*.ts' | sort`],
  { encoding: "utf8" }
).trim().split("\n").filter(Boolean);
const newTests = group("g4-new-test-files", newTestFiles);
const harnessTracked = execFileSync(
  "git",
  ["diff", "--numstat", BASE, "--", "scripts", "tests", "vitest.workspace.ts"],
  { cwd: ROOT, encoding: "utf8" }
).trim().split("\n").filter(Boolean).map((l) => {
  const [a, d, f] = l.split("\t");
  return { file: f, addedLines: Number(a), deletedLines: Number(d) };
});
const harnessTrackedTotal = harnessTracked.reduce(
  (acc, r) => ({ files: acc.files + 1, addedLines: acc.addedLines + r.addedLines, deletedLines: acc.deletedLines + r.deletedLines }),
  { files: 0, addedLines: 0, deletedLines: 0 }
);
const testHarness = {
  newTestFiles: newTests.total,
  trackedHarnessDiff: { total: harnessTrackedTotal, files: harnessTracked },
  note: "Tests and harness are counted separately from the charged production perimeter (plan §7). Not added to any charged figure.",
};

const identity = JSON.parse(
  readFileSync(resolve(ROOT, "docs/architecture/raptor3-evidence/g4/freeze/identity.json"), "utf8")
);

const chargedDeltaTotal = { bytes: 0, physicalLines: 0, tokenLines: 0, addedLines: 0, deletedLines: 0 };
for (const [f, d] of Object.entries(deltas)) {
  if (d.inG3Perimeter) continue; // already counted whole inside the re-measured perimeter
  chargedDeltaTotal.bytes += d.delta.bytes;
  chargedDeltaTotal.physicalLines += d.delta.physicalLines;
  chargedDeltaTotal.tokenLines += d.delta.tokenLines;
  chargedDeltaTotal.addedLines += d.numstat.addedLines;
  chargedDeltaTotal.deletedLines += d.numstat.deletedLines;
}

const g4CompleteCharged = {
  perimeter30Now: perimeter30.total,
  routeWhole: route.total,
  chargedDeltasOutsidePerimeter: chargedDeltaTotal,
  total: {
    files: perimeter30.total.files + 1,
    bytes: perimeter30.total.bytes + route.total.bytes + chargedDeltaTotal.bytes,
    physicalLines:
      perimeter30.total.physicalLines + route.total.physicalLines + chargedDeltaTotal.physicalLines,
    tokenLines:
      perimeter30.total.tokenLines + route.total.tokenLines + chargedDeltaTotal.tokenLines,
  },
  withNewlyRetainedCacheOwners: {
    files: perimeter30.total.files + 1 + newlyRetainedCacheOwners.total.files,
    bytes:
      perimeter30.total.bytes + route.total.bytes + chargedDeltaTotal.bytes + newlyRetainedCacheOwners.total.bytes,
    physicalLines:
      perimeter30.total.physicalLines + route.total.physicalLines + chargedDeltaTotal.physicalLines + newlyRetainedCacheOwners.total.physicalLines,
    tokenLines:
      perimeter30.total.tokenLines + route.total.tokenLines + chargedDeltaTotal.tokenLines + newlyRetainedCacheOwners.total.tokenLines,
    rationale:
      "If the G3 retained-owner rule (a shipped engine owner the candidate imports at runtime is charged whole, as write-engine/parse-boundary.ts is) is applied to the three official cache codec owners the G4 route newly imports, the candidate perimeter is this. Reported as an alternative, not substituted for the G3 file list.",
  },
  note:
    "Charged deltas for the four files outside the G3 perimeter (client.ts, query-engine.ts, pending-operation.ts, database-adapter.ts). The three dialect adapters are inside the G3 perimeter and are counted whole there; their G4 deltas are reported but not added again.",
};

const report = {
  version: 1,
  producedBy: "docs/architecture/raptor3-evidence/g4/root-review-probes/D/census.mjs",
  producedAt: new Date().toISOString(),
  method: {
    censusOwner: relative(ROOT, censusScriptPath),
    censusFunctionSha256,
    censusFunctionMatchesG3: censusFunctionSha256 === g3Cost.accounting.censusFunctionSha256,
    definition: g3Cost.accounting.definition,
    physicalLines: "newline count, the census script's own `lines`",
    bytes: "utf8 byte length; statBytes cross-check per file",
    baseCommit: BASE,
  },
  identity,
  groups: {
    candidateCore12: core12,
    language7: lang,
    shared5: sh,
    retained18: ret,
    raptor3Tree: tree,
    g3CompleteChargedPerimeter30: perimeter30,
    routeWhole: route,
    programSpecimen: program,
    newlyRetainedCacheOwners,
  },
  atBase: { candidateCore12: core12AtBase, g3CompleteChargedPerimeter30: perimeter30AtBase },
  g4ChargedDeltasOutsideRaptor3: deltas,
  g4CompleteCharged,
  g3Closure: {
    core: { files: g3Commands.language.files + g3Commands.shared.files, tokenLines: g3Commands.language.tokenLines + g3Commands.shared.tokenLines, physicalLines: g3Commands.language.physicalLines + g3Commands.shared.physicalLines, bytes: g3Commands.language.bytes + g3Commands.shared.bytes },
    complete: g3Commands.total,
    recomputedFromPerFileRecords: g3Recomputed,
  },
  shippedChargedPerimeter: g3Cost.accounting.charged,
  testHarness,
  comparisons: {
    coreVsG3Closure: {
      tokenLines: { g3: 6927, g4: core12.total.tokenLines, delta: core12.total.tokenLines - 6927 },
      physicalLines: { g3: 6997, g4: core12.total.physicalLines, delta: core12.total.physicalLines - 6997 },
      bytes: { g3: 230397, g4: core12.total.bytes, delta: core12.total.bytes - 230397 },
    },
    completeVsG3Closure: {
      perimeter30: {
        tokenLines: { g3: 11849, g4: perimeter30.total.tokenLines, delta: perimeter30.total.tokenLines - 11849 },
        physicalLines: { g3: 14486, g4: perimeter30.total.physicalLines, delta: perimeter30.total.physicalLines - 14486 },
        bytes: { g3: 499927, g4: perimeter30.total.bytes, delta: perimeter30.total.bytes - 499927 },
      },
      completeWithG4Additions: {
        tokenLines: { g3: 11849, g4: g4CompleteCharged.total.tokenLines, delta: g4CompleteCharged.total.tokenLines - 11849 },
        physicalLines: { g3: 14486, g4: g4CompleteCharged.total.physicalLines, delta: g4CompleteCharged.total.physicalLines - 14486 },
        bytes: { g3: 499927, g4: g4CompleteCharged.total.bytes, delta: g4CompleteCharged.total.bytes - 499927 },
      },
    },
    vsShippedChargedPerimeter: {
      shipped: g3Cost.accounting.charged,
      candidateComplete: g4CompleteCharged.total,
      ratioTokenLines: g4CompleteCharged.total.tokenLines / g3Cost.accounting.charged.tokenLines,
      ratioPhysicalLines: g4CompleteCharged.total.physicalLines / g3Cost.accounting.charged.physicalLines,
      ratioBytes: g4CompleteCharged.total.bytes / g3Cost.accounting.charged.bytes,
      ratioTokenLinesWithRetainedCacheOwners:
        g4CompleteCharged.withNewlyRetainedCacheOwners.tokenLines / g3Cost.accounting.charged.tokenLines,
      targets: {
        tokenLines: "<= 0.60 of the frozen baseline (plan §7)",
        physicalLines: "<= 0.70 of the frozen baseline (plan §7)",
      },
    },
    g3CumulativeGuidepost: {
      guidepostTokenLines: 14000,
      classification: "Review trigger, not an automatic stop-loss verdict (plan §7 size table)",
      perimeter30Now: perimeter30.total.tokenLines,
      completeWithG4Additions: g4CompleteCharged.total.tokenLines,
      crossed: perimeter30.total.tokenLines > 14000,
    },
  },
  perUnitCumulative: {
    scope: "candidate core, 12 files, token-lines. Each row is one tree state in the order the tree actually reached it, so the deltas sum to the measured total; `owner` attributes the delta to a unit.",
    base: { stage: "0cc61e61", tokenLines: 6927, source: "measured here from git show; reproduces g3 source-cost.json exactly" },
    chain: [
      { stage: "G4-01 r2", tokenLines: 8573, delta: 1646, owner: "G4-01", note: "unit01/note.md 'Cost after Repair 2'" },
      { stage: "G4-01 r3", tokenLines: 8626, delta: 53, owner: "G4-01", note: "unit01/note.md" },
      { stage: "G4-01 r4", tokenLines: 8641, delta: 15, owner: "G4-01", note: "unit01-review-followup2/core-cost-recheck.json" },
      { stage: "G4-02 phase 1 (measured on the r4 tree)", tokenLines: 8982, delta: 341, owner: "G4-02", note: "unit02/note.md §9.4 / §R.6; the unit's own eight-file increment is +345, measured against a slightly different eight-file base" },
      { stage: "G4-01 r5 merged into the phase-2 tree", tokenLines: 9001, delta: 19, owner: "G4-01", note: "unit01/note.md 'Cost after Repair 3' (8,641 -> 8,660 in isolation); unit02/note.md §P.10 states the phase-1 figure predates this merge, so the r5 delta lands here in the tree-state sequence" },
      { stage: "G4-02 phase 2", tokenLines: 9227, delta: 226, owner: "G4-02", note: "unit02/note.md §P.10" },
      { stage: "G4-02 phase-2 repairs", tokenLines: 9277, delta: 50, owner: "G4-02", note: "unit02/note.md (two rounds, 9,277)" },
      { stage: "G4-02 closure", tokenLines: 9337, delta: 60, owner: "G4-02", note: "unit02/note.md closure" },
      { stage: "G4-02 closure r2", tokenLines: 9342, delta: 5, owner: "G4-02", note: "unit02/note.md §R5" },
      { stage: "G4-02 closure r3", tokenLines: 9357, delta: 15, owner: "G4-02", note: "unit02/note.md §R6.7" },
      { stage: "decisions unit", tokenLines: 9398, delta: 41, owner: "decisions", note: "unit02/note.md decisions round (schema.ts +23)" },
      { stage: "freeze r1", tokenLines: 9406, delta: 8, owner: "freeze", note: "freeze/note.md §4" },
      { stage: "freeze r2", tokenLines: 9407, delta: 1, owner: "freeze", note: "freeze/note.md §R2.7" },
    ],
    measuredAtFreeze: core12.total.tokenLines,
    perUnitTotals: {
      "G4-01": 1733,
      "G4-02 (phases 1-2, repairs, closure)": 697,
      "decisions": 41,
      "freeze": 9,
      "G4-03 (route + seams; 0 in the core by construction)": 0,
      "witness / harness (tests and scripts only)": 0,
      sum: 2480,
      measuredDelta: core12.total.tokenLines - 6927,
    },
    outsideCore: {
      "route/client-route.ts": { atUnit03Close: 143, atUnit03b: 144, atFreeze: route.total.tokenLines, ownerOfTheGrowth: "G4-02 closure (transferred route): +103" },
      "pending-operation.ts": { atUnit03Close: 68, atFreeze: deltas["src/query-engine/pending-operation.ts"].delta.tokenLines },
      "client.ts": { atUnit03Close: 20, atFreeze: deltas["src/client/client.ts"].delta.tokenLines },
      "query-engine.ts": { atUnit03Close: 5, atFreeze: deltas["src/query-engine/query-engine.ts"].delta.tokenLines },
      "adapters (3 dialect + database-adapter)": { atFreeze: 6, note: "the three dialect adapters are inside the G3 perimeter (+5); database-adapter.ts is a separate charged delta (+1)" },
      "program specimen (2 files)": { g3: 622, atFreeze: program.total.tokenLines },
    },
  },
};

console.log(JSON.stringify(report, null, 2));
