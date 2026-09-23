import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@client/client";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { v } from "@validation";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type {
  CandidateEngineFactory,
  RunObservation,
} from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";
import {
  liveProvider,
  runLiveWorld,
  type LiveBarrier,
  type LiveFixture,
} from "./live-world";

export const dynamicRecoveryId = "g2-recovery-dynamic-member-admission";
const evidence: unknown[] = [];

export async function saveRecoveryBoundaryEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g2-live-recovery-boundary-evidence.json"),
    JSON.stringify({
      identity: captureRaptor3Identity(),
      provider: liveProvider,
      records: encodeEvidenceValue(evidence),
    })
  );
}

/** Legacy is diagnostic until its exact admission ledger is measured and pinned. */
export async function runDynamicRecoveryBoundary(
  candidateFactory?: CandidateEngineFactory
) {
  assert.equal(
    liveProvider,
    "pg",
    "Dynamic atomic UPDATE recovery is a PostgreSQL-only witness"
  );
  const admissions: RunObservation["defaults"] = [];
  let nextTicket = 0;
  let nextNote = 0;
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin),
    })
    .map("g2_recovery_shelves");
  const author = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin),
    })
    .map("g2_recovery_authors");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      authorId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id"),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      tickets: s.toMany(() => ticket),
    })
    .map("g2_recovery_bins");
  const ticket = s
    .model({
      id: s
        .string()
        .id()
        .default(() => {
          const value = `ticket-${++nextTicket}`;
          admissions.push({ name: "ticket.id.default", value });
          return value;
        }),
      note: s.string().schema(
        v.string({
          transform(value) {
            const transformed = `${value}-${++nextNote}`;
            admissions.push({
              name: "ticket.note.transform",
              value: transformed,
            });
            return transformed;
          },
        })
      ),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id"),
    })
    .map("g2_recovery_tickets");
  const schema = { shelf, author, bin, ticket };
  const args = {
    where: { id: "s1" },
    data: {
      bins: {
        updateMany: {
          where: { id: "b1" },
          data: {
            author: {
              connectOrCreate: {
                where: { id: "wanted" },
                create: { id: "wanted", label: "loser" },
              },
            },
            tickets: { create: { note: "note" } },
          },
        },
      },
    },
    select: { id: true, label: true },
  } as const;
  const initial = {
    shelves: [
      { id: "s1", label: "Selected" },
      { id: "s9", label: "Untouched" },
    ],
    authors: [{ id: "decoy", label: "Untouched" }],
    bins: [
      { id: "b1", shelfId: "s1", authorId: "decoy" },
      { id: "b9", shelfId: "s9", authorId: "decoy" },
    ],
    tickets: [{ id: "t-decoy", note: "Untouched", binId: "b9" }],
  };
  const external = {
    ...initial,
    authors: [...initial.authors, { id: "wanted", label: "winner" }],
  };
  const missingCut = "dynamic-member-missing-target-peer-committed";
  const winnerCut = "dynamic-member-winner-reobserved";
  let missingCaptures = 0;
  let winnerCaptures = 0;
  let admittedBeforeCollision: RunObservation["defaults"] = [];
  let definitions: Record<string, string> = {};
  const barrier: LiveBarrier = async (completion, state, peer) => {
    const params = completion.statement.parameters;
    if (
      completion.transactionOpen ||
      params.filter((value) => value === "wanted").length !== 1 ||
      !params.every((value) => value === "wanted" || value === 1)
    )
      return;
    if (completion.rows.length === 0) {
      assert.equal(
        missingCaptures++,
        0,
        "The fixed missing producer must be observed once"
      );
      assert.equal(completion.rowCount, 0);
      assert.deepEqual(
        state,
        initial,
        "A read-only root prefix must not create a durable write"
      );
      assert.deepEqual(await peer.inspect(), initial);
      admittedBeforeCollision = admissions.map((entry) => ({ ...entry }));
      await peer.write(
        `INSERT INTO ${peer.table("g2_recovery_authors")} (${peer.quote("id")},${peer.quote("label")}) VALUES ($1,$2)`,
        ["wanted", "winner"]
      );
      assert.deepEqual(await peer.inspect(), external);
      return missingCut;
    }
    assert.equal(missingCaptures, 1);
    assert.equal(completion.rowCount, 1);
    assert.equal(completion.rows.length, 1);
    const winner = completion.rows[0];
    assert(
      winner !== null &&
        typeof winner === "object" &&
        "id" in winner &&
        winner.id === "wanted",
      "The actual probe must locate the peer's exact winner"
    );
    assert.deepEqual(
      state,
      external,
      "Any retry probe must precede its own writes"
    );
    winnerCaptures++;
    return winnerCut;
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      shelves: { name: "g2_recovery_shelves", order: ["id"] },
      authors: { name: "g2_recovery_authors", order: ["id"] },
      bins: { name: "g2_recovery_bins", order: ["id"] },
      tickets: { name: "g2_recovery_tickets", order: ["id"] },
    },
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute("shelf", "update", args);
      return createClient({ schema, driver }).shelf.update(args);
    },
    assert(observation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(
        observation.final,
        external,
        "Dynamic admission excludes root recovery: only the peer winner may persist"
      );
      assert.equal(observation.outcome.kind, "failure");
      if (observation.outcome.kind !== "failure") return;
      assert.equal(observation.outcome.failure.name, "UniqueConstraintError");
      assert.equal(observation.outcome.failure.code, "V3001");
      assert.equal(
        observation.outcome.failure.message,
        "Unique constraint violation"
      );
      assert.deepEqual(observation.reachedCuts, [missingCut]);
      assert.deepEqual(
        admissions,
        [
          { name: "ticket.id.default", value: "ticket-1" },
          { name: "ticket.note.transform", value: "note-1" },
          { name: "ticket.id.default", value: "ticket-2" },
          { name: "ticket.note.transform", value: "note-2" },
        ],
        "Each template and captured-member admission runs once; neither may repeat after collision"
      );
      assert.deepEqual(
        admissions,
        admittedBeforeCollision,
        "dynamic-member-no-readmission: rejection must not re-admit the captured member"
      );
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => {
      const q = names.quote;
      definitions = {
        g2_recovery_shelves: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("label")} TEXT NOT NULL`,
        g2_recovery_authors: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("label")} TEXT NOT NULL`,
        g2_recovery_bins: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("shelfId")} TEXT NOT NULL REFERENCES ${names.table("g2_recovery_shelves")}(${q("id")}),${q("authorId")} TEXT NOT NULL REFERENCES ${names.table("g2_recovery_authors")}(${q("id")})`,
        g2_recovery_tickets: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("note")} TEXT NOT NULL,${q("binId")} TEXT NOT NULL REFERENCES ${names.table("g2_recovery_bins")}(${q("id")})`,
      };
      return definitions;
    },
    candidateFactory,
    "atomic-batch",
    barrier
  );
  evidence.push({
    scenarioId: dynamicRecoveryId,
    candidate: candidateFactory ? "commands" : "legacy",
    status: candidateFactory
      ? "approved-once-only-admission-exclusion"
      : "diagnostic-unclassified-legacy-admission",
    publicInput: { model: "shelf", operation: "update", args },
    namespace: world.namespace,
    definitions,
    connections: world.connections,
    candidateEntries: world.candidateEntries,
    admissions,
    admittedBeforeCollision,
    missingCaptures,
    winnerCaptures,
    observation: world.observation,
    statements: world.statements,
    completions: world.completions,
    failedBatches: world.failedBatches.map(({ queries, failure }) => ({
      queries,
      failure: observeFailure(failure),
    })),
  });
  world.assertHealthy();
  assert.equal(missingCaptures, 1);
  assert.equal(
    world.failedBatches.length,
    1,
    "Exactly one actual native selected-unique collision is required"
  );
  const batch = world.failedBatches[0]!;
  assert(batch.failure instanceof UniqueConstraintError);
  assert.equal(batch.failure.meta.providerCode, "23505");
  assert.equal(batch.failure.meta.table, "g2_recovery_authors");
  assert.equal(batch.failure.meta.constraint, "g2_recovery_authors_pkey");
  const index = batch.failure.meta.statementIndex;
  assert(typeof index === "number" && Number.isInteger(index) && index >= 0);
  const rejected = batch.queries[index];
  assert(rejected);
  assert.match(rejected.sql, /^\s*INSERT\b/i);
  assert(rejected.sql.includes("g2_recovery_authors"));
  assert.deepEqual(rejected.params, ["wanted", "loser"]);
  if (candidateFactory) {
    fixture.assert(world.observation);
    assert.equal(
      winnerCaptures,
      0,
      "Excluded dynamic recovery must not probe a winner"
    );
    assert.equal(
      world.terminalFailure,
      batch.failure,
      "Excluded recovery preserves the exact original normalized failure"
    );
  }
  return { world, admissions, admittedBeforeCollision };
}
