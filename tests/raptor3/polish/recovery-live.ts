import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@client/client";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { isRecord } from "@validation/value-guards";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type {
  CandidateEngineFactory,
  DefaultObservation,
} from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";
import {
  liveProvider,
  runLiveWorld,
  type LiveBarrier,
  type LiveFixture,
  type LivePeer,
} from "../transitions/live-world";

export const polishRecoveryIds = [
  "g25-recovery-condition-match-to-skip",
  "g25-recovery-winner-lost",
] as const;
const evidence: unknown[] = [];

export async function savePolishRecoveryEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  await writeFile(
    join(directory, "g25-live-recovery-evidence.json"),
    JSON.stringify({
      identity: captureRaptor3Identity(),
      provider: liveProvider,
      records: encodeEvidenceValue(evidence),
    })
  );
}

export async function runPolishRecovery(
  id: (typeof polishRecoveryIds)[number],
  candidateFactory?: CandidateEngineFactory
) {
  assert.equal(liveProvider, "pg");
  const conditional = id === "g25-recovery-condition-match-to-skip";
  const admissions: DefaultObservation[] = [];
  let admissionsAtCollision: DefaultObservation[] = [];
  const author = s
    .model({
      id: s.string().id(),
      label: s.string().default(() => {
        admissions.push({ name: "author.label.default", value: "loser" });
        return "loser";
      }),
      posts: s.toMany(() => post),
    })
    .map("g25_recovery_authors");
  const post = s
    .model({
      id: s.string().id(),
      rank: s.int(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("g25_recovery_posts");
  const schema = { author, post };
  const supplier = {
    connectOrCreate: {
      where: { id: "wanted" },
      create: conditional ? { id: "wanted" } : { id: "wanted", label: "loser" },
    },
  };
  const createArgs = {
    data: { id: "request", rank: 1, title: "created", author: supplier },
    select: { id: true, rank: true, title: true, authorId: true },
  } as const;
  const upsertArgs = {
    where: { id: "request" },
    targetWhere: { rank: 1 },
    create: {
      id: "unused",
      rank: 0,
      title: "must not create",
      authorId: "decoy",
    },
    update: { title: "must not update", author: supplier },
    select: { id: true, rank: true, title: true, authorId: true },
  } as const;
  const initial = {
    authors: [{ id: "decoy", label: "other author" }],
    posts: [
      { id: "other", rank: 9, title: "other post", authorId: "decoy" },
      ...(conditional
        ? [{ id: "request", rank: 1, title: "unchanged", authorId: "decoy" }]
        : []),
    ],
  };
  const external = {
    ...initial,
    authors: [...initial.authors, { id: "wanted", label: "winner" }],
  };
  const skippedPost = {
    id: "request",
    rank: 2,
    title: "unchanged",
    authorId: "decoy",
  };
  const final = conditional
    ? { ...external, posts: [initial.posts[0], skippedPost] }
    : initial;
  let peer: LivePeer | undefined;
  let planted = false;
  let changedAfterRollback = false;
  let missingObservations = 0;
  let winnerObservations = 0;
  let rollbacks = 0;
  let definitions: Record<string, string> = {};
  const barrier: LiveBarrier = async (completion, state, connection) => {
    const parameters = completion.statement.parameters;
    if (
      completion.transactionOpen ||
      parameters.filter((value) => value === "wanted").length !== 1 ||
      !parameters.every((value) => value === "wanted" || value === 1)
    )
      return undefined;
    if (completion.rows.length === 0) {
      missingObservations++;
      if (planted) {
        assert(
          !conditional && changedAfterRollback,
          "Only the deleted winner can become absent on recovery"
        );
        assert.deepEqual(state, initial);
        return "lost-winner-observed-absent";
      }
      assert.deepEqual(state, initial);
      assert.deepEqual(await connection.inspect(), initial);
      peer = connection;
      await connection.write(
        `INSERT INTO ${connection.table("g25_recovery_authors")} (${connection.quote("id")},${connection.quote("label")}) VALUES ($1,$2)`,
        ["wanted", "winner"]
      );
      assert.deepEqual(await connection.inspect(), external);
      planted = true;
      return "missing-author-peer-winner-committed";
    }
    assert(
      conditional && changedAfterRollback,
      "The lost winner must not be published by a later read"
    );
    assert(completion.rows.some((row) => isRecord(row) && row.id === "wanted"));
    assert.deepEqual(state, final);
    winnerObservations++;
    return undefined;
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: "g25_recovery_authors", order: ["id"] },
      posts: { name: "g25_recovery_posts", order: ["id"] },
    },
    async afterRollback() {
      rollbacks++;
      if (changedAfterRollback) return;
      admissionsAtCollision = admissions.map((admission) => ({ ...admission }));
      assert(
        planted && peer,
        "The fixture changes only the real collision's committed peer state"
      );
      assert.deepEqual(
        await peer.inspect(),
        external,
        "Native rollback must remove every provisional ORM effect"
      );
      if (conditional) {
        await peer.write(
          `UPDATE ${peer.table("g25_recovery_posts")} SET ${peer.quote("rank")}=2 WHERE ${peer.quote("id")}=$1 AND ${peer.quote("rank")}=1`,
          ["request"]
        );
      } else {
        await peer.write(
          `DELETE FROM ${peer.table("g25_recovery_authors")} WHERE ${peer.quote("id")}=$1`,
          ["wanted"]
        );
      }
      assert.deepEqual(await peer.inspect(), final);
      changedAfterRollback = true;
    },
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute(
          "post",
          conditional ? "upsert" : "create",
          conditional ? upsertArgs : createArgs
        );
      const client = createClient({ schema, driver });
      return conditional
        ? client.post.upsert(upsertArgs)
        : client.post.create(createArgs);
    },
    assert(observation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(observation.final, final);
      assert.deepEqual(observation.defaults, []);
      assert.deepEqual(
        admissionsAtCollision,
        conditional ? [{ name: "author.label.default", value: "loser" }] : [],
        "The selected missing author input must be admitted exactly once before its collision"
      );
      assert.deepEqual(
        admissions,
        admissionsAtCollision,
        "Eligible INSERT recovery must not re-admit its input after native rollback"
      );
      assert(
        changedAfterRollback,
        "The external post-rollback mutation must actually finish before recovery"
      );
      if (conditional) {
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: skippedPost,
        });
      } else {
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind === "failure") {
          assert.equal(
            observation.outcome.failure.name,
            "UniqueConstraintError"
          );
          assert.equal(observation.outcome.failure.code, "V3001");
          assert.equal(
            observation.outcome.failure.message,
            "Unique constraint violation"
          );
        }
      }
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => {
      const q = names.quote;
      definitions = {
        g25_recovery_authors: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("label")} TEXT NOT NULL`,
        g25_recovery_posts: `${q("id")} TEXT PRIMARY KEY NOT NULL,${q("rank")} INTEGER NOT NULL,${q("title")} TEXT NOT NULL,${q("authorId")} TEXT NOT NULL REFERENCES ${names.table("g25_recovery_authors")}(${q("id")})`,
      };
      return definitions;
    },
    candidateFactory,
    "atomic-batch",
    barrier
  );
  evidence.push({
    scenarioId: id,
    candidate: candidateFactory ? "commands" : "legacy",
    publicInput: {
      model: "post",
      operation: conditional ? "upsert" : "create",
      args: conditional ? upsertArgs : createArgs,
    },
    namespace: world.namespace,
    definitions,
    connections: world.connections,
    missingObservations,
    winnerObservations,
    rollbacks,
    changedAfterRollback,
    admissions,
    admissionsAtCollision,
    observation: world.observation,
    statements: world.statements,
    completions: world.completions,
    failedBatches: world.failedBatches.map(({ queries, failure }) => ({
      queries,
      failure: observeFailure(failure),
    })),
  });
  world.assertHealthy();
  assert.equal(
    world.failedBatches.length,
    1,
    "Exactly one real selected-unique collision is required"
  );
  const collision = world.failedBatches[0]!;
  assert(collision.failure instanceof UniqueConstraintError);
  assert.equal(collision.failure.meta.providerCode, "23505");
  assert.equal(collision.failure.meta.table, "g25_recovery_authors");
  assert.equal(collision.failure.meta.constraint, "g25_recovery_authors_pkey");
  const rejectedIndex = collision.failure.meta.statementIndex;
  assert(typeof rejectedIndex === "number" && Number.isInteger(rejectedIndex));
  const rejected = collision.queries[rejectedIndex];
  assert(rejected);
  assert.match(rejected.sql, /^\s*INSERT\b/i);
  assert.deepEqual(rejected.params, ["wanted", "loser"]);
  const proposedCreates = world.statements.filter(
    (statement) =>
      statement.parameters.includes("wanted") &&
      statement.parameters.includes("loser")
  );
  assert.equal(
    proposedCreates.length,
    1,
    "Losing the winner must not authorize a second missing-branch INSERT"
  );
  assert.equal(proposedCreates[0]!.completed, false);
  fixture.assert(world.observation);
  assert.equal(missingObservations, conditional ? 1 : 2);
  if (!conditional) assert.equal(winnerObservations, 0);
  if (!conditional)
    assert.equal(
      world.terminalFailure,
      collision.failure,
      "A missing recovery winner preserves the original normalized unique failure"
    );
  return world;
}
