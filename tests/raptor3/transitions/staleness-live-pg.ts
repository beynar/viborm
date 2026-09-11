import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@client/client";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
} from "@errors";
import { s } from "@schema";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { CandidateEngineFactory } from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";
import {
  liveProvider,
  runLiveWorld,
  type LiveBarrier,
  type LiveFixture,
  type LiveNames,
} from "./live-world";

assert.equal(
  liveProvider,
  "pg",
  "These public atomic-update witnesses require PostgreSQL RETURNING admission"
);

export const pgStalenessIds = [
  "g2-pg-captured-key-replaced",
  "g2-pg-series-parent-reference-reused",
] as const;
type PgStalenessId = (typeof pgStalenessIds)[number];
const evidence: unknown[] = [];

export async function savePgStalenessEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-pg-staleness-evidence.json"),
    JSON.stringify({
      identity: captureRaptor3Identity(),
      provider: liveProvider,
      substrate: "atomic-batch",
      records: encodeEvidenceValue(evidence),
    })
  );
}

function capturedKeyRecipe() {
  const counter = s
    .model({
      id: s.int().id(),
      tag: s.string().unique(),
      ticks: s.toMany(() => tick),
    })
    .map("g2_live_stale_counters");
  const tick = s
    .model({
      id: s.string().id(),
      counterId: s.int().nullable(),
      counter: s
        .toOne(() => counter)
        .fields("counterId")
        .references("id")
        .onUpdate("setNull"),
    })
    .map("g2_live_stale_ticks");
  const schema = { counter, tick };
  const args = {
    where: { tag: "selected" },
    data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
    select: { id: true, tag: true },
  } as const;
  const initial = {
    counters: [
      { id: 10, tag: "selected" },
      { id: 10000, tag: "untouched" },
    ],
    ticks: [{ id: "decoy-tick", counterId: 10000 }],
  };
  const external = {
    counters: [
      { id: 10, tag: "replacement" },
      { id: 77, tag: "selected" },
      initial.counters[1]!,
    ],
    ticks: initial.ticks,
  };
  const cut = "captured-key-replaced-by-peer";
  let changed = false;
  const barrier: LiveBarrier = async (completion, state, peer) => {
    if (changed) {
      assert.deepEqual(
        state,
        external,
        "The stale operation must not write the replacement, moved target or descendants"
      );
      return undefined;
    }
    if (completion.transactionOpen || completion.rows.length !== 1)
      return undefined;
    const row = completion.rows[0];
    if (
      row === null ||
      typeof row !== "object" ||
      !("id" in row) ||
      row.id !== 10
    )
      return undefined;
    assert.equal(completion.rowCount, 1);
    assert(
      completion.statement.parameters.includes("selected"),
      "Capture must be the actual alternate-unique lookup"
    );
    assert.deepEqual(
      state,
      initial,
      "Capture must precede all operation effects"
    );
    assert.deepEqual(await peer.inspect(), initial);
    await peer.write(
      `UPDATE ${peer.table("g2_live_stale_counters")} SET ${peer.quote("id")}=77 WHERE ${peer.quote("id")}=10 AND ${peer.quote("tag")}=$1`,
      ["selected"]
    );
    await peer.write(
      `INSERT INTO ${peer.table("g2_live_stale_counters")} (${peer.quote("id")},${peer.quote("tag")}) VALUES (10,$1)`,
      ["replacement"]
    );
    assert.deepEqual(
      await peer.inspect(),
      external,
      "The moved target and replacement must both be committed before A resumes"
    );
    changed = true;
    return cut;
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      counters: { name: "g2_live_stale_counters", order: ["id"] },
      ticks: { name: "g2_live_stale_ticks", order: ["id"] },
    },
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute("counter", "update", args);
      return createClient({ schema, driver }).counter.update(args);
    },
    assert(observation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(observation.final, external);
      assert.deepEqual(observation.defaults, []);
      assert.deepEqual(observation.reachedCuts, [cut]);
      assert.equal(observation.outcome.kind, "failure");
      if (observation.outcome.kind !== "failure") return;
      assert.equal(observation.outcome.failure.name, "NotFoundError");
      assert.equal(observation.outcome.failure.code, "V6001");
      assert.equal(
        observation.outcome.failure.message,
        "No counter record found for update"
      );
    },
  };
  return {
    fixture,
    barrier,
    publicInput: {
      model: "counter",
      operation: "update",
      args,
      externalMove: { from: 10, to: 77 },
      replacement: external.counters[0],
    },
    source: "tests/raptor3/transitions/staleness.ts:g2-key-captured-replaced",
    definitions(names: LiveNames) {
      const q = names.quote;
      return {
        g2_live_stale_counters: `${q("id")} INTEGER PRIMARY KEY NOT NULL,${q("tag")} TEXT NOT NULL UNIQUE`,
        g2_live_stale_ticks: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("counterId")} INTEGER,FOREIGN KEY(${q("counterId")}) REFERENCES ${names.table("g2_live_stale_counters")}(${q("id")}) ON UPDATE SET NULL`,
      };
    },
  };
}

function parentReferenceRecipe() {
  const hub = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      label: s.string(),
      spokes: s.toMany(() => spoke),
    })
    .map("g2_live_series_hubs");
  const spoke = s
    .model({
      id: s.string().id(),
      label: s.string(),
      hubCode: s.string(),
      hub: s
        .toOne(() => hub)
        .fields("hubCode")
        .references("code")
        .onUpdate("cascade"),
      notes: s.toMany(() => note),
    })
    .map("g2_live_series_spokes");
  const note = s
    .model({
      id: s.string().id(),
      text: s.string(),
      spokeId: s.string(),
      spoke: s
        .toOne(() => spoke)
        .fields("spokeId")
        .references("id"),
    })
    .map("g2_live_series_notes");
  const schema = { hub, spoke, note };
  const args = {
    where: { code: "H1" },
    data: {
      label: "prefix-committed",
      spokes: {
        updateMany: {
          where: {},
          data: {
            label: "must-not-land",
            notes: { create: { id: "n-race", text: "must-not-land" } },
          },
        },
      },
    },
    select: { id: true, code: true, label: true },
  } as const;
  const initial = {
    hubs: [
      { id: "h-decoy", code: "H9", label: "untouched" },
      { id: "h-other", code: "H2", label: "other" },
      { id: "h-selected", code: "H1", label: "selected" },
    ],
    spokes: [
      { id: "sp1", label: "first", hubCode: "H1" },
      { id: "sp2", label: "second", hubCode: "H2" },
      { id: "sp9", label: "untouched", hubCode: "H9" },
    ],
    notes: [{ id: "n9", text: "untouched", spokeId: "sp9" }],
  };
  const prefix = {
    ...initial,
    hubs: [
      initial.hubs[0]!,
      initial.hubs[1]!,
      { id: "h-selected", code: "H1", label: "prefix-committed" },
    ],
  };
  const external = {
    hubs: [
      initial.hubs[0]!,
      { id: "h-other", code: "H1", label: "other" },
      { id: "h-selected", code: "H3", label: "prefix-committed" },
    ],
    spokes: [
      { id: "sp1", label: "first", hubCode: "H3" },
      { id: "sp2", label: "second", hubCode: "H1" },
      initial.spokes[2]!,
    ],
    notes: initial.notes,
  };
  const cut = "series-parent-reference-reused-by-peer";
  let changed = false;
  const barrier: LiveBarrier = async (completion, state, peer) => {
    if (changed) {
      assert.deepEqual(
        state,
        external,
        "Parent continuity must fail before every member and descendant effect"
      );
      return undefined;
    }
    if (completion.transactionOpen || completion.rows.length !== 1)
      return undefined;
    const row = completion.rows[0];
    if (
      row === null ||
      typeof row !== "object" ||
      !("id" in row) ||
      row.id !== "sp1"
    )
      return undefined;
    assert.equal(completion.rowCount, 1);
    assert.deepEqual(
      state,
      prefix,
      "The real member capture follows the root's committed prefix"
    );
    assert.deepEqual(
      await peer.inspect(),
      prefix,
      "The other connection must observe the acknowledged prefix"
    );
    await peer.write(
      `UPDATE ${peer.table("g2_live_series_hubs")} SET ${peer.quote("code")}=$1 WHERE ${peer.quote("id")}=$2 AND ${peer.quote("code")}=$3`,
      ["H3", "h-selected", "H1"]
    );
    await peer.write(
      `UPDATE ${peer.table("g2_live_series_hubs")} SET ${peer.quote("code")}=$1 WHERE ${peer.quote("id")}=$2 AND ${peer.quote("code")}=$3`,
      ["H1", "h-other", "H2"]
    );
    assert.deepEqual(
      await peer.inspect(),
      external,
      "Both real cascading changes must commit before the member resumes"
    );
    changed = true;
    return cut;
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      hubs: { name: "g2_live_series_hubs", order: ["id"] },
      spokes: { name: "g2_live_series_spokes", order: ["id"] },
      notes: { name: "g2_live_series_notes", order: ["id"] },
    },
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute("hub", "update", args);
      return createClient({ schema, driver }).hub.update(args);
    },
    assert(observation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(observation.final, external);
      assert.deepEqual(observation.defaults, []);
      assert.deepEqual(observation.reachedCuts, [cut]);
      assert.equal(observation.outcome.kind, "failure");
      if (observation.outcome.kind !== "failure") return;
      assert.equal(observation.outcome.failure.name, "NestedWriteError");
      assert.equal(observation.outcome.failure.code, "V7001");
      assert.equal(
        observation.outcome.failure.message,
        "Cannot update relation 'spokes': parent record changed across a committed segment."
      );
      const meta = observation.outcome.failure.meta;
      assert(
        meta !== null &&
          typeof meta === "object" &&
          "recordSeriesProgress" in meta
      );
      assert.deepEqual(
        meta.recordSeriesProgress,
        {
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
          completedMembers: 0,
          committedWriteMembers: 1,
          mayHaveCommittedSegment: true,
          memberPath: [0],
          totalMembers: 1,
        },
        "The acknowledged prefix and weak native dispatch uncertainty are distinct facts"
      );
    },
  };
  return {
    fixture,
    barrier,
    publicInput: {
      model: "hub",
      operation: "update",
      args,
      externalChanges: [
        { id: "h-selected", code: "H3" },
        { id: "h-other", code: "H1" },
      ],
    },
    source:
      "tests/raptor3/transitions/series-staleness.ts:g2-series-parent-reference-reused",
    definitions(names: LiveNames) {
      const q = names.quote;
      return {
        g2_live_series_hubs: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("code")} TEXT NOT NULL UNIQUE,${q("label")} TEXT NOT NULL`,
        g2_live_series_spokes: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("label")} TEXT NOT NULL,${q("hubCode")} TEXT NOT NULL,FOREIGN KEY(${q("hubCode")}) REFERENCES ${names.table("g2_live_series_hubs")}(${q("code")}) ON UPDATE CASCADE`,
        g2_live_series_notes: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("text")} TEXT NOT NULL,${q("spokeId")} TEXT NOT NULL,FOREIGN KEY(${q("spokeId")}) REFERENCES ${names.table("g2_live_series_spokes")}(${q("id")})`,
      };
    },
  };
}

/** Local cases supply the expectation; each invocation newly classifies native PostgreSQL. */
export async function runPgStalenessScenario(
  id: PgStalenessId,
  candidateFactory?: CandidateEngineFactory
) {
  const recipe =
    id === "g2-pg-captured-key-replaced"
      ? capturedKeyRecipe()
      : parentReferenceRecipe();
  let definitions: Record<string, string> | undefined;
  const world = await runLiveWorld(
    recipe.fixture,
    (names) => {
      definitions = recipe.definitions(names);
      return definitions;
    },
    candidateFactory,
    "atomic-batch",
    recipe.barrier
  );
  evidence.push({
    scenarioId: id,
    expectationOrigin:
      "Classified local staleness case; native PostgreSQL classification is independent",
    source: recipe.source,
    candidate: candidateFactory ? "commands" : "legacy",
    namespace: world.namespace,
    definitions,
    publicInput: recipe.publicInput,
    connections: world.connections,
    candidateEntries: world.candidateEntries,
    observation: world.observation,
    statements: world.statements,
    completions: world.completions,
    batchFailures: world.batchFailures.map(observeFailure),
  });
  world.assertHealthy();
  recipe.fixture.assert(world.observation);
  assert.equal(
    world.batchFailures.length,
    1,
    "The guarded native batch must reject once"
  );
  const failure = world.batchFailures[0];
  assert(
    failure instanceof NestedWriteAssertionError,
    "Native assertion evidence must precede semantic failure attribution"
  );
  assert.equal(failure.code, "V7006");
  assert(
    Number.isInteger(failure.meta.statementIndex),
    "The actual sequential native batch supplies a trustworthy failed statement index"
  );
  assert(
    world.terminalFailure instanceof
      (id === "g2-pg-captured-key-replaced" ? NotFoundError : NestedWriteError)
  );
  return world;
}
