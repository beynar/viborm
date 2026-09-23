import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@client/client";
import { QueryError, UniqueConstraintError } from "@errors";
import { s } from "@schema";
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
  type LiveNames,
} from "./live-world";

export const uniqueRaceIds = [
  "g2-race-selected-unique-recovery",
  "g2-race-unrelated-unique-refused",
  "g2-race-wrong-insert-same-constraint",
] as const;
type UniqueRaceId = (typeof uniqueRaceIds)[number];
export const cleanupRecoveryId = "g2-race-selected-unique-cleanup-refused";
export const uniqueRaceProvider = liveProvider;
const evidence: unknown[] = [];
const cleanupEvidence: unknown[] = [];

export async function saveUniqueRaceEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (!directory) return;
  for (const [filename, records] of [
    ["g2-live-unique-race-evidence.json", evidence],
    ["g2-live-cleanup-recovery-evidence.json", cleanupEvidence],
  ] as const) {
    if (!records.length) continue;
    await writeFile(
      join(directory, filename),
      JSON.stringify({
        identity: captureRaptor3Identity(),
        provider: liveProvider,
        substrate: "atomic-batch",
        records: encodeEvidenceValue(records),
      })
    );
  }
}

/** A missing branch cannot donate its retry pin to a different INSERT. */
async function runWrongInsertScenario(
  candidateFactory?: CandidateEngineFactory
) {
  const author = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      authoredPosts: s.toMany(() => post).name("author"),
      reviewedPosts: s.toMany(() => post).name("reviewer"),
    })
    .map("g2_wrong_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      reviewerId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id")
        .name("author"),
      reviewer: s
        .toOne(() => author)
        .fields("reviewerId")
        .references("id")
        .name("reviewer"),
    })
    .map("g2_wrong_posts");
  const schema = { author, post };
  const args = {
    data: {
      id: "p-request",
      title: "Request",
      author: {
        connectOrCreate: {
          where: { id: "wanted" },
          create: {
            id: "wanted",
            email: "wanted@x",
            name: "conditional-create",
          },
        },
      },
      reviewer: {
        create: {
          id: "occupied",
          email: "new-reviewer@x",
          name: "plain-conflict",
        },
      },
    },
    select: { id: true, authorId: true, reviewerId: true },
  } as const;
  const initial = {
    authors: [
      { id: "decoy", email: "decoy@x", name: "Untouched" },
      {
        id: "occupied",
        email: "existing-reviewer@x",
        name: "Permanent conflict",
      },
    ],
    posts: [
      {
        id: "p-decoy",
        title: "Untouched",
        authorId: "decoy",
        reviewerId: "occupied",
      },
    ],
  };
  const provisional = {
    ...initial,
    authors: [...initial.authors, args.data.author.connectOrCreate.create],
  };
  const cut = "unrelated-missing-choice-observed";
  // One attempt on every arm: since C-01 the public client IS this engine, so
  // the deleted engine's second attempt has no arm left to run on.
  const expectedAttempts = 1;
  let missingCaptures = 0;
  let conditionalWrites = 0;
  let ddl: Record<string, string> = {};
  const barrier: LiveBarrier = async (completion, state, peer) => {
    const parameters = completion.statement.parameters;
    const missingSelector =
      !completion.transactionOpen &&
      parameters.filter((value) => value === "wanted").length === 1 &&
      parameters.every((value) => value === "wanted" || value === 1);
    if (missingSelector) {
      assert.deepEqual(
        completion.rows,
        [],
        "The conditional selector must actually be missing"
      );
      assert.equal(completion.rowCount, 0);
      assert.deepEqual(state, initial);
      assert.deepEqual(
        await peer.inspect(),
        initial,
        "The conflicting plain-create key remains committed on the independent connection"
      );
      missingCaptures++;
      return cut;
    }
    if (
      parameters.includes("conditional-create") &&
      /^\s*INSERT\b/i.test(completion.statement.sql)
    ) {
      assert(
        completion.transactionOpen,
        "The eligible conditional INSERT must remain inside the eventual failed atomic unit"
      );
      assert.deepEqual(state, provisional);
      conditionalWrites++;
    }
    return undefined;
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: "g2_wrong_authors", order: ["id"] },
      posts: { name: "g2_wrong_posts", order: ["id"] },
    },
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute("post", "create", args);
      return createClient({ schema, driver }).post.create(args);
    },
    assert(observation: RunObservation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(
        observation.final,
        initial,
        "Both the successful conditional INSERT and root writes must be rolled back"
      );
      assert.deepEqual(observation.defaults, []);
      assert.equal(observation.outcome.kind, "failure");
      if (observation.outcome.kind !== "failure") return;
      assert.equal(observation.outcome.failure.name, "UniqueConstraintError");
      assert.equal(observation.outcome.failure.code, "V3001");
      assert.equal(
        observation.outcome.failure.message,
        "Unique constraint violation"
      );
      assert.deepEqual(
        observation.reachedCuts,
        Array.from({ length: expectedAttempts }, () => cut),
        "wrong-insert-provenance: the approved exact-INSERT recovery exclusion"
      );
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => {
      const q = names.quote;
      const text = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";
      ddl = {
        g2_wrong_authors: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("email")} ${text} NOT NULL UNIQUE,${q("name")} ${text} NOT NULL`,
        g2_wrong_posts: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("title")} ${text} NOT NULL,${q("authorId")} ${text} NOT NULL,${q("reviewerId")} ${text} NOT NULL,FOREIGN KEY(${q("authorId")}) REFERENCES ${names.table("g2_wrong_authors")}(${q("id")}),FOREIGN KEY(${q("reviewerId")}) REFERENCES ${names.table("g2_wrong_authors")}(${q("id")})`,
      };
      return ddl;
    },
    candidateFactory,
    "atomic-batch",
    barrier
  );
  // The deleted executor retried every matching plan pin, even when a different
  // indexed INSERT failed. The approved candidate policy excludes it, on the
  // client route and on the command engine alike.
  evidence.push({
    scenarioId: "g2-race-wrong-insert-same-constraint",
    candidate: candidateFactory ? "commands" : "client-route",
    status: "Approved exact-INSERT recovery exclusion",
    sources: ["src/query-engine/raptor3/shared/operation-context.ts"],
    namespace: world.namespace,
    definitions: ddl,
    connections: world.connections,
    publicInput: { model: "post", operation: "create", args },
    candidateEntries: world.candidateEntries,
    missingCaptures,
    conditionalWrites,
    observation: world.observation,
    statements: world.statements,
    completions: world.completions,
    failedBatches: world.failedBatches.map(
      ({ queries, failure, nativeFailure }) => ({
        queries,
        failure: observeFailure(failure),
        ...(nativeFailure === undefined
          ? {}
          : { nativeFailure: observeFailure(nativeFailure) }),
      })
    ),
  });
  world.assertHealthy();
  // Prove the actual losing INSERT before counting attempts: the same PK name
  // belongs to both branches, but only reviewer.create proposed occupied.
  assert(
    world.failedBatches.length > 0,
    "The provider must reject the permanently conflicting plain INSERT"
  );
  for (const { failure, queries } of world.failedBatches) {
    assert(failure instanceof UniqueConstraintError);
    assert.equal(
      failure.meta.providerCode,
      liveProvider === "pg" ? "23505" : "ER_DUP_ENTRY"
    );
    if (liveProvider === "mysql")
      assert.equal(failure.meta.providerErrno, 1062);
    assert.equal(failure.meta.table, "g2_wrong_authors");
    assert.equal(
      failure.meta.constraint,
      liveProvider === "pg" ? "g2_wrong_authors_pkey" : "PRIMARY"
    );
    const index = failure.meta.statementIndex;
    assert(typeof index === "number" && Number.isInteger(index) && index >= 0);
    const statement = queries[index];
    assert(statement);
    assert.match(statement.sql, /^\s*INSERT\b/i);
    assert(statement.sql.includes("g2_wrong_authors"));
    assert.deepEqual(statement.params, [
      "occupied",
      "new-reviewer@x",
      "plain-conflict",
    ]);
    assert(
      queries.some(
        (query) =>
          /^\s*INSERT\b/i.test(query.sql) &&
          query.params?.includes("conditional-create")
      ),
      "The same rejected submission must contain the other taken missing producer"
    );
  }
  fixture.assert(world.observation);
  assert.equal(
    missingCaptures,
    expectedAttempts,
    "wrong-insert-provenance: exact missing lookup count"
  );
  // Either INSERT may be physically earlier. The exact failed submission above
  // proves that both were present; successful provisional writes are diagnostic.
  assert.equal(
    world.failedBatches.length,
    expectedAttempts,
    "wrong-insert-provenance: exact rejected plain-INSERT attempt count"
  );
  const plainAttempts = world.statements.filter((statement) =>
    statement.parameters.includes("plain-conflict")
  );
  assert.equal(plainAttempts.length, expectedAttempts);
  assert(plainAttempts.every((statement) => !statement.completed));
  return world;
}

function definitions(names: LiveNames) {
  const q = names.quote;
  const text = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";
  return {
    g2_race_authors: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("email")} ${text} NOT NULL,${q("name")} ${text} NOT NULL,CONSTRAINT ${q("g2_race_authors_email_key")} UNIQUE(${q("email")})`,
    g2_race_posts: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("title")} ${text} NOT NULL,${q("authorId")} ${text} NOT NULL,FOREIGN KEY(${q("authorId")}) REFERENCES ${names.table("g2_race_authors")}(${q("id")})`,
  };
}

/** Exact-target recovery and unrelated-constraint rejection share one public call. */
export async function runUniqueRaceScenario(
  id: UniqueRaceId | typeof cleanupRecoveryId,
  candidateFactory?: CandidateEngineFactory
) {
  if (id === "g2-race-wrong-insert-same-constraint")
    return runWrongInsertScenario(candidateFactory);
  const cleanup = id === cleanupRecoveryId;
  if (cleanup)
    assert.equal(
      liveProvider,
      "pg",
      "Post-rollback cleanup injection is admitted on PostgreSQL only"
    );
  const selected = id === "g2-race-selected-unique-recovery" || cleanup;
  const cleanupFailure = new Error(
    "Controlled selected-unique cleanup failure after native rollback"
  );
  let cleanupCalls = 0;
  const author = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("g2_race_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("g2_race_posts");
  const schema = { author, post };
  const args = {
    data: {
      id: "p-request",
      title: "Request",
      author: {
        connectOrCreate: {
          where: { id: "wanted" },
          create: { id: "wanted", email: "claim@x", name: "loser" },
        },
      },
    },
    select: { id: true, title: true, authorId: true },
  } as const;
  const initial = {
    authors: [{ id: "decoy", email: "decoy@x", name: "untouched" }],
    posts: [{ id: "p-decoy", title: "Untouched", authorId: "decoy" }],
  };
  const planted = selected
    ? { id: "wanted", email: "winner@x", name: "winner" }
    : { id: "other", email: "claim@x", name: "unrelated" };
  const external = {
    authors: [...initial.authors, planted],
    posts: initial.posts,
  };
  const publicValue = { id: "p-request", title: "Request", authorId: "wanted" };
  const final =
    selected && !cleanup
      ? { ...external, posts: [...initial.posts, publicValue] }
      : external;
  const missingCut = "missing-target-observed-and-peer-committed";
  const winnerCut = "winner-observed-after-conflict";
  let peerCommitted = false;
  let missingObservations = 0;
  let winnerObservations = 0;

  const barrier: LiveBarrier = async (completion, state, peer) => {
    // The fixed selector has one string parameter; LIMIT may be parameterized.
    // No INSERT carries only that selector. SQL spelling and statement ordinal
    // are diagnostic evidence, never the trigger for the external transaction.
    const parameters = completion.statement.parameters;
    const selector =
      parameters.filter((value) => value === "wanted").length === 1 &&
      parameters.every((value) => value === "wanted" || value === 1);
    // The atomic write may later assert this same key; only planning responses
    // outside that transaction are missing/winner observations.
    if (!selector || completion.transactionOpen) return undefined;
    if (completion.rows.length === 0) {
      missingObservations++;
      assert.equal(
        peerCommitted,
        false,
        "An unrelated unique failure must not repeat the missing arm"
      );
      assert.equal(
        completion.rowCount,
        0,
        "The provider actually observed a missing target"
      );
      assert.deepEqual(
        state,
        initial,
        "No operation write may precede the missing-target barrier"
      );
      assert.deepEqual(
        await peer.inspect(),
        initial,
        "The peer must see the same committed initial world"
      );
      const placeholders = liveProvider === "pg" ? "$1,$2,$3" : "?,?,?";
      await peer.write(
        `INSERT INTO ${peer.table("g2_race_authors")} (${["id", "email", "name"].map(peer.quote).join(",")}) VALUES (${placeholders})`,
        [planted.id, planted.email, planted.name]
      );
      // Autocommit has returned on the other connection. The actor's empty
      // response remains paused until that committed row is independently read.
      assert.deepEqual(await peer.inspect(), external);
      peerCommitted = true;
      return missingCut;
    }
    assert(
      selected && peerCommitted,
      "Only selected-unique recovery can observe a winner"
    );
    assert.equal(completion.rows.length, 1);
    assert.equal(completion.rowCount, 1);
    const row = completion.rows[0];
    assert(
      row !== null &&
        typeof row === "object" &&
        "id" in row &&
        row.id === "wanted",
      "The retried probe must locate the planted winner's exact key"
    );
    assert.deepEqual(
      state,
      external,
      "Recovery must observe the committed winner before creating the post"
    );
    winnerObservations++;
    return winnerCut;
  };

  const fixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: "g2_race_authors", order: ["id"] },
      posts: { name: "g2_race_posts", order: ["id"] },
    },
    ...(cleanup
      ? {
          afterRollback() {
            if (cleanupCalls++ === 0) throw cleanupFailure;
          },
        }
      : {}),
    async invoke(driver, factory) {
      if (factory)
        return factory({ schema, driver }).execute("post", "create", args);
      return createClient({ schema, driver }).post.create(args);
    },
    assert(observation: RunObservation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(observation.final, final);
      assert.deepEqual(observation.defaults, []);
      assert.deepEqual(
        observation.reachedCuts,
        selected && !cleanup ? [missingCut, winnerCut] : [missingCut]
      );
      if (selected && !cleanup) {
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: publicValue,
        });
        return;
      }
      assert.equal(observation.outcome.kind, "failure");
      if (observation.outcome.kind !== "failure") return;
      assert.equal(
        observation.outcome.failure.name,
        cleanup ? "QueryError" : "UniqueConstraintError"
      );
      assert.equal(
        observation.outcome.failure.code,
        cleanup ? "V2001" : "V3001"
      );
      assert.equal(
        observation.outcome.failure.message,
        cleanup ? "Query execution failed" : "Unique constraint violation"
      );
      if (cleanup) {
        assert.deepEqual(observation.outcome.failure.cause, {
          name: "Error",
          message: "Underlying error details redacted",
          cause: {
            name: "Error",
            message: "Underlying error details redacted",
            code: "V3001",
            cause: {
              name: "Error",
              message: "Underlying error details redacted",
              code: "23505",
            },
          },
        });
      }
    },
  };
  const world = await runLiveWorld(
    fixture,
    definitions,
    candidateFactory,
    "atomic-batch",
    barrier
  );
  (cleanup ? cleanupEvidence : evidence).push({
    scenarioId: id,
    candidate: candidateFactory ? "commands" : "legacy",
    namespace: world.namespace,
    candidateEntries: world.candidateEntries,
    publicInput: {
      model: "post",
      operation: "create",
      args,
      externalInsert: planted,
    },
    sources: [
      "tests/contracts/drivers/behaviors/nested-write-concurrency-behavior.ts",
      "tests/contracts/engine/write/race-retry-classification.core.test.ts",
    ],
    connections: world.connections,
    observation: world.observation,
    statements: world.statements,
    completions: world.completions,
    batchFailures: world.batchFailures.map(observeFailure),
    ...(cleanup
      ? {
          cleanupCalls,
          rollbacks: world.rollbacks.map(({ failure }) => ({
            failure:
              failure === undefined ? undefined : observeFailure(failure),
          })),
          failedBatches: world.failedBatches.map(
            ({ queries, failure, nativeFailure }) => ({
              queries,
              failure: observeFailure(failure),
              nativeFailure: observeFailure(nativeFailure),
            })
          ),
        }
      : {}),
  });
  world.assertHealthy();
  fixture.assert(world.observation);
  assert.equal(
    missingObservations,
    1,
    "The fixed initial missing-target observation must occur exactly once"
  );
  assert.equal(
    winnerObservations,
    selected && !cleanup ? 1 : 0,
    "Only the selected-key loser may re-probe and adopt"
  );
  assert.equal(
    world.batchFailures.length,
    1,
    "The real first create-branch batch must lose exactly once"
  );
  const failure = world.batchFailures[0];
  if (cleanup) {
    assert(failure instanceof QueryError);
    assert.equal(failure.code, "V2001");
    assert.equal(failure.meta.model, "post");
    assert.equal(failure.meta.operation, "create");
    assert.equal(failure.meta.driver, "pg");
    assert(
      typeof failure.meta.correlationId === "string" &&
        failure.meta.correlationId.length > 0
    );
  } else {
    assert(
      failure instanceof UniqueConstraintError,
      "The pre-retry failure must be the normalized real unique violation, not an assertion abort"
    );
    assert.equal(failure.code, "V3001");
    assert.equal(
      failure.meta.providerCode,
      liveProvider === "pg" ? "23505" : "ER_DUP_ENTRY"
    );
    if (liveProvider === "mysql")
      assert.equal(failure.meta.providerErrno, 1062);
    assert.equal(
      failure.meta.table,
      "g2_race_authors",
      "The actual provider must attribute the target table"
    );
    assert.equal(
      failure.meta.constraint,
      selected
        ? liveProvider === "pg"
          ? "g2_race_authors_pkey"
          : "PRIMARY"
        : "g2_race_authors_email_key",
      "The actual failed constraint must distinguish the selected identity from the unrelated unique"
    );
  }
  const proposedCreates = world.statements.filter((statement) =>
    ["wanted", "claim@x", "loser"].every((value) =>
      statement.parameters.includes(value)
    )
  );
  assert.equal(
    proposedCreates.length,
    1,
    "There must be one proposed loser INSERT, not a blind retry"
  );
  assert.equal(
    proposedCreates[0]!.completed,
    false,
    "The database must reject the proposed loser INSERT"
  );
  if (!selected || cleanup)
    assert.equal(
      world.terminalFailure,
      failure,
      "Ineligible recovery must preserve the original normalized failure"
    );
  if (cleanup) {
    assert.equal(
      cleanupCalls,
      1,
      "A cleanup rejection must not start another attempt"
    );
    assert.equal(
      world.rollbacks.length,
      1,
      "The failed write batch must perform one real native rollback"
    );
    assert.equal(world.rollbacks[0]!.failure, cleanupFailure);
    const native = world.failedBatches[0]!.nativeFailure;
    assert(
      native instanceof AggregateError,
      "Native cleanup must report the ordered lifecycle aggregate before public redaction"
    );
    const primary: unknown = native.errors[0];
    assert(primary instanceof UniqueConstraintError);
    assert.equal(primary.code, "V3001");
    assert.equal(
      native.cause,
      primary,
      "Cleanup must preserve the exact primary as the aggregate cause"
    );
    assert.equal(native.message, primary.message);
    assert.deepEqual(
      native.errors,
      [primary, cleanupFailure],
      "Cleanup must retain exactly the actual primary followed by the injected secondary"
    );
    assert.equal(primary.meta.providerCode, "23505");
    assert.equal(primary.meta.model, "author");
    assert.equal(primary.meta.operation, "create");
    assert.equal(primary.meta.correlationId, failure.meta.correlationId);
    assert.equal(primary.meta.table, "g2_race_authors");
    assert.equal(primary.meta.constraint, "g2_race_authors_pkey");
    const index = primary.meta.statementIndex;
    assert(typeof index === "number" && Number.isInteger(index) && index >= 0);
    const rejected = world.failedBatches[0]!.queries[index];
    assert(rejected);
    assert.match(rejected.sql, /^\s*INSERT\b/i);
    assert(rejected.sql.includes("g2_race_authors"));
    assert.deepEqual(rejected.params, ["wanted", "claim@x", "loser"]);
  }
  return world;
}
