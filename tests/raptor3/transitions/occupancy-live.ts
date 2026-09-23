import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@client/client";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { z } from "zod";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type { CandidateEngineFactory } from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";
import {
  liveProvider,
  runLiveWorld,
  type LiveBarrier,
  type LiveFixture,
} from "./live-world";

export const occupancyRaceId = "g2-race-singular-slot-occupied";
export const occupancyProvider = liveProvider;
const evidence: unknown[] = [];

export async function saveOccupancyEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-live-occupancy-evidence.json"),
    JSON.stringify({
      identity: captureRaptor3Identity(),
      provider: liveProvider,
      substrate: "atomic-batch",
      records: encodeEvidenceValue(evidence),
    })
  );
}

/** The native UNIQUE decides the occupied slot; the fixture never supplies an ORM error. */
export async function runOccupancyScenario(
  candidateFactory?: CandidateEngineFactory
) {
  const station = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      label: s.string(),
      badge: s.toOne(() => badge),
    })
    .map("g2_slot_stations");
  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      stationId: s.string().nullable().unique(),
      station: s
        .toOne(() => station)
        .fields("stationId")
        .references("id"),
    })
    .map("g2_slot_badges");
  const schema = { station, badge };
  const args = {
    data: {
      id: "b-loser",
      tag: "requested",
      station: { connect: { slug: "selected" } },
    },
    select: { id: true, tag: true, stationId: true },
  } as const;
  const initial = {
    stations: [
      { id: "s-decoy", slug: "decoy", label: "untouched" },
      { id: "s-selected", slug: "selected", label: "selected" },
    ],
    badges: [{ id: "b-decoy", tag: "untouched", stationId: "s-decoy" }],
  };
  const winner = { id: "b-winner", tag: "external", stationId: "s-selected" };
  const external = {
    stations: initial.stations,
    badges: [...initial.badges, winner],
  };
  const cut = "station-captured-and-peer-slot-committed";
  let peerCommitted = false;
  let captures = 0;
  const barrier: LiveBarrier = async (completion, state, peer) => {
    if (peerCommitted)
      assert.deepEqual(
        state,
        external,
        "The losing writer must not change the winner or decoys"
      );
    if (completion.transactionOpen || completion.rows.length !== 1)
      return undefined;
    const row = completion.rows[0];
    if (
      row === null ||
      typeof row !== "object" ||
      !("id" in row) ||
      row.id !== "s-selected"
    )
      return undefined;
    captures++;
    assert.equal(
      peerCommitted,
      false,
      "Slot occupation must not retry the target lookup"
    );
    assert(
      completion.statement.parameters.includes("selected"),
      "The actual target was located by its alternate unique slug"
    );
    assert.equal(completion.rowCount, 1);
    assert.deepEqual(
      state,
      initial,
      "No own effects may precede target capture"
    );
    assert.deepEqual(await peer.inspect(), initial);
    const placeholders = liveProvider === "pg" ? "$1,$2,$3" : "?,?,?";
    await peer.write(
      `INSERT INTO ${peer.table("g2_slot_badges")} (${["id", "tag", "stationId"].map(peer.quote).join(",")}) VALUES (${placeholders})`,
      [winner.id, winner.tag, winner.stationId]
    );
    assert.deepEqual(
      await peer.inspect(),
      external,
      "The other connection must commit the singular winner before A resumes"
    );
    peerCommitted = true;
    return cut;
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      stations: { name: "g2_slot_stations", order: ["id"] },
      badges: { name: "g2_slot_badges", order: ["id"] },
    },
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute("badge", "create", args);
      return createClient({ schema, driver }).badge.create(args);
    },
    assert(observation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(observation.final, external);
      assert.deepEqual(observation.defaults, []);
      assert.deepEqual(observation.reachedCuts, [cut]);
      assert.equal(observation.outcome.kind, "failure");
      if (observation.outcome.kind !== "failure") return;
      assert.equal(observation.outcome.failure.name, "UniqueConstraintError");
      assert.equal(observation.outcome.failure.code, "V3001");
      assert.equal(
        observation.outcome.failure.message,
        "Unique constraint violation"
      );
    },
  };
  let definitions: Record<string, string> | undefined;
  const world = await runLiveWorld(
    fixture,
    (names) => {
      const q = names.quote;
      const text = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";
      definitions = {
        g2_slot_stations: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("slug")} ${text} NOT NULL UNIQUE,${q("label")} ${text} NOT NULL`,
        g2_slot_badges: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("tag")} ${text} NOT NULL,${q("stationId")} ${text},CONSTRAINT ${q("g2_slot_badges_station_key")} UNIQUE(${q("stationId")}),FOREIGN KEY(${q("stationId")}) REFERENCES ${names.table("g2_slot_stations")}(${q("id")})`,
      };
      return definitions;
    },
    candidateFactory,
    "atomic-batch",
    barrier
  );
  // Save raw outcomes before asserting the newly classified native execution.
  evidence.push({
    scenarioId: occupancyRaceId,
    expectationOrigin:
      "Existing singular occupancy contract; this is a new native two-connection classification",
    candidate: candidateFactory ? "commands" : "legacy",
    namespace: world.namespace,
    definitions,
    publicInput: {
      model: "badge",
      operation: "create",
      args,
      externalInsert: winner,
    },
    sources: [
      "tests/contracts/engine/write/inverse-to-one-create-behavior.ts",
      "tests/contracts/engine/write/polymorphic-write-family.test.ts",
    ],
    connections: world.connections,
    candidateEntries: world.candidateEntries,
    observation: world.observation,
    statements: world.statements,
    completions: world.completions,
    batchFailures: world.batchFailures.map(observeFailure),
    failedBatches: world.failedBatches.map(({ queries }) => queries),
  });
  world.assertHealthy();
  fixture.assert(world.observation);
  assert.equal(captures, 1);
  assert.equal(
    world.batchFailures.length,
    1,
    "One native constraint failure, no recovery attempt"
  );
  const failure = world.batchFailures[0];
  assert(
    failure instanceof UniqueConstraintError,
    "The actual failed batch must expose the native unique violation"
  );
  assert.equal(
    failure.meta.providerCode,
    liveProvider === "pg" ? "23505" : "ER_DUP_ENTRY"
  );
  if (liveProvider === "mysql") assert.equal(failure.meta.providerErrno, 1062);
  assert.equal(failure.meta.table, "g2_slot_badges");
  assert.equal(failure.meta.constraint, "g2_slot_badges_station_key");
  const failedIndex = z
    .number()
    .int()
    .nonnegative()
    .parse(failure.meta.statementIndex);
  const failedStatement = world.failedBatches[0]!.queries[failedIndex];
  assert(
    failedStatement,
    "The native failure index must name an actual submitted statement"
  );
  assert.match(failedStatement.sql, /^INSERT\b/i);
  assert(failedStatement.sql.includes("g2_slot_badges"));
  assert.deepEqual(failedStatement.params?.slice(0, 2), [
    "b-loser",
    "requested",
  ]);
  assert(world.observation.outcome.kind === "failure");
  const metadata = world.observation.outcome.failure.meta;
  assert.equal(
    z.record(z.string(), z.unknown()).parse(metadata).statementIndex,
    failedIndex,
    "Public attribution must retain the exact native statement position"
  );
  assert.equal(
    world.statements.filter((statement) =>
      ["b-loser", "requested"].every((value) =>
        statement.parameters.includes(value)
      )
    ).length,
    1,
    "The losing insert must not retry or adopt the unrelated slot winner"
  );
  // Position is relative to this engine's physical batch. Its required meaning
  // is the proven losing INSERT above, not equality of two different SQL plans.
  return {
    ...world,
    semanticObservation: {
      ...world.observation,
      outcome: {
        ...world.observation.outcome,
        failure: {
          ...world.observation.outcome.failure,
          meta: Object.assign(
            Object.create(Object.getPrototypeOf(metadata)),
            metadata,
            { statementIndex: "losing badge INSERT" }
          ),
        },
      },
    },
  };
}
