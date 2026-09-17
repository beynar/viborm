import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@client/client";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  TransactionError,
  UniqueConstraintError,
} from "@errors";
import { s } from "@schema";
import { z } from "zod";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import { captureRaptor3Identity } from "../../../scripts/raptor3-manifest.mjs";
import type {
  CandidateEngineFactory,
  OperationOutcome,
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

const pgIds = [
  "g2-junction-held-capture-race",
  "g2-junction-empty-capture-race",
  "g2-junction-captured-owner-replaced",
] as const;
const mysqlIds = [
  "g2-junction-held-interactive-race",
  "g2-junction-empty-interactive-race",
] as const;
export const junctionRaceIds = liveProvider === "pg" ? pgIds : mysqlIds;
export const junctionRaceProvider = liveProvider;
type JunctionRaceId = (typeof pgIds)[number] | (typeof mysqlIds)[number];
const evidence: unknown[] = [];

export async function saveJunctionRaceEvidence() {
  const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  if (directory)
    await writeFile(
      join(directory, "g2-live-junction-race-evidence.json"),
      JSON.stringify({
        identity: captureRaptor3Identity(),
        provider: liveProvider,
        records: encodeEvidenceValue(evidence),
      })
    );
}

function definitions(names: LiveNames) {
  const q = names.quote;
  const text = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";
  return {
    g2_slot_shelves: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("label")} ${text} NOT NULL`,
    g2_slot_books: `${q("id")} ${text} PRIMARY KEY NOT NULL,${q("title")} ${text} NOT NULL`,
    g2_slot_members: `${q("holder")} ${text} NOT NULL,${q("entry")} ${text} NOT NULL,PRIMARY KEY(${q("holder")},${q("entry")}),CONSTRAINT ${q("g2_slot_members_entry_key")} UNIQUE(${q("entry")}),FOREIGN KEY(${q("holder")}) REFERENCES ${names.table("g2_slot_shelves")}(${q("id")}),FOREIGN KEY(${q("entry")}) REFERENCES ${names.table("g2_slot_books")}(${q("id")})`,
  };
}

/** A failed arrival rejects the wait; it never releases an unproven capture. */
function arrivalGate() {
  let arrivals = 0;
  let open!: () => void;
  let reject!: (failure: unknown) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, refused) => {
    open = resolve;
    reject = refused;
  });
  // The second operation may fail before either capture reaches this promise.
  void ready.catch(() => undefined);
  return {
    wait() {
      timer ??= setTimeout(
        () =>
          reject(new Error("Both native membership captures did not arrive")),
        10_000
      );
      if (++arrivals === 2) {
        clearTimeout(timer);
        open();
      }
      return ready;
    },
    abort(failure: unknown) {
      if (timer) clearTimeout(timer);
      reject(failure);
    },
    close() {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Public UPDATE only. MySQL uses its admitted interactive route, never forced atomic UPDATE. */
export async function runJunctionRaceScenario(
  id: JunctionRaceId,
  candidateFactory?: CandidateEngineFactory
) {
  assert(
    junctionRaceIds.some((admitted) => admitted === id),
    "Junction race is not admitted on this provider"
  );
  const empty = id.includes("empty");
  const replaced = id === "g2-junction-captured-owner-replaced";
  const planned = liveProvider === "pg";
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelf: s.toOne(() => shelf),
    })
    .map("g2_slot_books");
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      items: s
        .toMany({ book: () => book }, { values: { book: "stored.book.v1" } })
        .through({
          book: { table: "g2_slot_members", source: "holder", target: "entry" },
        }),
    })
    .map("g2_slot_shelves");
  const schema = { shelf, book };
  const args = (owner: string) => ({
    where: { id: owner },
    data: {
      items: { connect: [{ type: "book" as const, where: { id: "b1" } }] },
    },
    select: { id: true as const, label: true as const },
  });
  const initial = {
    shelves: ["s0", "s1", "s2", "s9"].map((id) => ({ id, label: id })),
    books: [
      { id: "b1", title: "Requested" },
      { id: "b9", title: "Untouched" },
    ],
    members: [
      ...(empty ? [] : [{ holder: "s0", entry: "b1" }]),
      { holder: "s9", entry: "b9" },
    ],
  };
  const captures = new Set<string>();
  const gate = arrivalGate();
  let captured!: () => void;
  const firstCapture = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let winnerSettled!: () => void;
  const winnerDone = new Promise<void>((resolve) => {
    winnerSettled = resolve;
  });
  let replacementWait: ReturnType<typeof setTimeout> | undefined;
  const outcomes: OperationOutcome[] = [];
  const nativeFailures = new Map<string, unknown>();
  let batchFailures: unknown[] = [];
  const barrier: LiveBarrier = async (completion, state) => {
    const actor = completion.statement.actor;
    assert(actor, "Two-actor evidence must identify the active connection");
    // Owner capture projects only the junction's source field. Target and root
    // lookups have their own model keys. Empty reads additionally name this exact
    // fixed membership table, not an ordinal or a simulated SQL result.
    const ownerRows =
      completion.rows.length > 0 &&
      completion.rows.every(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          Object.keys(row).length === 1 &&
          "holder" in row
      );
    const emptyOwners =
      completion.rows.length === 0 &&
      completion.statement.sql.includes("g2_slot_members") &&
      completion.statement.parameters.includes("b1") &&
      /^\s*SELECT\b/i.test(completion.statement.sql);
    // A read-only planning batch may itself use a native transaction. Its
    // unlocked owner projection is still before the distinct write batch.
    if (!planned || captures.has(actor) || !(ownerRows || emptyOwners)) return;
    assert.deepEqual(
      state,
      initial,
      "Both captured plans must precede their own effects"
    );
    assert.deepEqual(
      completion.rows,
      empty ? [] : [{ holder: "s0" }],
      "The native owner capture must match the fixed premise"
    );
    captures.add(actor);
    if (replaced && actor === "actor") {
      captured();
      await winnerDone;
      return "actor-captured-s0-then-peer-settled";
    }
    if (!replaced) await gate.wait();
    return `${actor}-captured-${empty ? "empty" : "s0"}`;
  };
  const fixture: LiveFixture = {
    actorCount: 2,
    initial,
    tables: {
      shelves: { name: "g2_slot_shelves", order: ["id"] },
      books: { name: "g2_slot_books", order: ["id"] },
      members: { name: "g2_slot_members", order: ["holder", "entry"] },
    },
    async invoke(driver, factory, peerDriver) {
      assert(
        peerDriver,
        "The second ORM operation needs its own native driver"
      );
      const execute = async (
        activeDriver: typeof driver,
        owner: string
      ): Promise<OperationOutcome> => {
        try {
          const value = factory
            ? await factory({ schema, driver: activeDriver }).execute(
                "shelf",
                "update",
                args(owner)
              )
            : await createClient({ schema, driver: activeDriver }).shelf.update(
                args(owner)
              );
          return { kind: "success", value };
        } catch (failure) {
          nativeFailures.set(owner, failure);
          gate.abort(failure);
          return { kind: "failure", failure: observeFailure(failure) };
        }
      };
      try {
        if (replaced) {
          // actor=s2 captures first. The peer=s1 then completes its actual ORM
          // transfer before that captured plan resumes. No raw planted winner.
          const loser = execute(driver, "s2");
          let rejectMissing!: (failure: unknown) => void;
          const missing = new Promise<never>((_, reject) => {
            rejectMissing = reject;
          });
          replacementWait = setTimeout(
            () =>
              rejectMissing(
                new Error(
                  "Captured-owner replacement never reached its native capture"
                )
              ),
            10_000
          );
          try {
            await Promise.race([firstCapture, missing]);
            clearTimeout(replacementWait);
            const winner = await execute(peerDriver, "s1");
            winnerSettled();
            outcomes.push(await loser, winner);
          } finally {
            winnerSettled();
            await loser;
          }
        } else {
          outcomes.push(
            ...(await Promise.all([
              execute(driver, "s1"),
              execute(peerDriver, "s2"),
            ]))
          );
        }
        return outcomes;
      } finally {
        gate.close();
        if (replacementWait) clearTimeout(replacementWait);
      }
    },
    assert(observation: RunObservation) {
      assert.deepEqual(observation.initial, initial);
      assert.deepEqual(observation.defaults, []);
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: outcomes,
      });
      assert.equal(outcomes.length, 2);
      const owners = replaced ? ["s2", "s1"] : ["s1", "s2"];
      const winners = outcomes.flatMap((outcome, index) => {
        if (outcome.kind === "failure") {
          const native = nativeFailures.get(owners[index]!);
          const failure = outcome.failure;
          const meta = z.record(z.string(), z.unknown()).parse(failure.meta);
          if (native instanceof UniqueConstraintError) {
            assert.equal(failure.name, "UniqueConstraintError");
            assert.equal(failure.code, "V3001");
            assert.equal(failure.message, "Unique constraint violation");
            assert.equal(meta.providerCode, planned ? "23505" : "ER_DUP_ENTRY");
            if (!planned) assert.equal(meta.providerErrno, 1062);
            assert.equal(meta.table, "g2_slot_members");
            // The contenders request distinct holders. A membership-PK conflict
            // is not this race: only the target-side UNIQUE arbitrates ownership.
            assert.equal(meta.constraint, "g2_slot_members_entry_key");
          } else if (native instanceof NestedWriteError) {
            assert(
              planned,
              "The interactive row-lock route does not emit captured-owner guards"
            );
            assert.equal(failure.name, "NestedWriteError");
            assert.equal(failure.code, "V7001");
            assert.equal(meta.relation, "items.book");
            const detail = empty
              ? "another owner holds the target"
              : "the captured membership is gone";
            assert.equal(
              failure.message,
              `Concurrent membership change on the singular polymorphic member of relation 'items.book': ${detail}; retry to converge.`
            );
            // Both arms of the capture carry the mark (Arnaud's D-32): the
            // sentence states the loss of a MEMBERSHIP this operation
            // observed, not of an identity the caller named. What the mark
            // does NOT do is authorise a re-adoption here — see the
            // `replaced` block below.
            assert.equal(meta.raceable, true);
            assert(
              batchFailures.some(
                (error) =>
                  error instanceof NestedWriteAssertionError &&
                  Number.isInteger(error.meta.statementIndex)
              ),
              "A refined captured-owner failure requires an actual indexed native assertion rejection"
            );
          } else {
            // error-mapping.ts maps native MySQL errno1213 / ER_LOCK_DEADLOCK
            // to this exact envelope. Lock-wait timeouts are not evidence of
            // arbitration and remain failures of this bounded witness.
            assert(
              !planned && native instanceof TransactionError,
              "An admission, observer, or generic query failure cannot stand in for a native race loser"
            );
            assert.equal(failure.name, "TransactionError");
            assert.equal(failure.code, "V5003");
            assert.equal(failure.message, "Transaction deadlock detected");
            assert.equal(meta.providerCode, "ER_LOCK_DEADLOCK");
            assert.equal(meta.providerErrno, 1213);
          }
          return [];
        }
        assert.deepEqual(outcome.value, {
          id: owners[index],
          label: owners[index],
        });
        return [owners[index]!];
      });
      assert(
        winners.length >= 1,
        "A race requires at least one actual successful adopter"
      );
      // A SIMULTANEOUS race over a held target still has one winner: the two
      // adopters captured the same owner, and the target-side UNIQUE or the
      // premise arbitrates between them. The SEQUENTIAL `replaced` shape is
      // the one Arnaud's D-32 changed, and it states its own outcome below.
      if (planned && !empty && !replaced)
        assert.equal(
          winners.length,
          1,
          "A captured held owner cannot be transferred successfully twice"
        );
      const members = z
        .array(z.strictObject({ holder: z.string(), entry: z.string() }))
        .parse(observation.final.members);
      const requested = members.filter((row) => row.entry === "b1");
      assert.equal(requested.length, 1);
      assert(
        winners.includes(requested[0]!.holder),
        "Final ownership must belong to a reported successful adopter"
      );
      assert.deepEqual(observation.final, {
        shelves: initial.shelves,
        books: initial.books,
        members: [...requested, { holder: "s9", entry: "b9" }],
      });
      if (planned) {
        assert.deepEqual(
          [...captures].sort(),
          ["actor", "peer"],
          "Both actual native owner captures must have completed"
        );
        if (replaced) {
          // Arnaud's D-32, re-expressed: the actor captured `s0`, the peer
          // completed its own transfer, and the actor's atomic unit then
          // aborted at the captured-membership premise. That premise states
          // the loss of a MEMBERSHIP the plan observed, not of an identity the
          // caller named — the two rows this write connects are the ones the
          // arguments spell — so the operation re-plans ONCE from the admitted
          // values, the fresh capture reads the peer's pair, and it transfers
          // THAT. Both operations report success, and the slot is still
          // singular: `requested.length === 1` above, held by the adopter that
          // finished last.
          assert.deepEqual(winners, ["s2", "s1"]);
          assert.deepEqual(observation.reachedCuts, [
            "peer-captured-s0",
            "actor-captured-s0-then-peer-settled",
          ]);
          assert.equal(nativeFailures.size, 0);
          assert.equal(requested[0]!.holder, "s2");
          // The ABORT is what separates convergence from a plan that never
          // proved anything: the first attempt was rejected by an INDEXED
          // native assertion, exactly as it was when the operation ended
          // there. The sentence that rejection carries is pinned by the
          // `NestedWriteError` branch above and, verbatim with its repeated
          // race, by
          // `tests/raptor3/g4/parity/integration-membership-race.test.ts`.
          assert(
            batchFailures.some(
              (error) =>
                error instanceof NestedWriteAssertionError &&
                Number.isInteger(error.meta.statementIndex)
            ),
            "The captured-membership premise must have aborted the first attempt"
          );
        } else
          assert.deepEqual([...observation.reachedCuts].sort(), [
            `actor-captured-${empty ? "empty" : "s0"}`,
            `peer-captured-${empty ? "empty" : "s0"}`,
          ]);
      } else assert.deepEqual(observation.reachedCuts, []);
    },
  };
  const world = await runLiveWorld(
    fixture,
    definitions,
    candidateFactory,
    planned ? "atomic-batch" : "interactive",
    barrier
  );
  batchFailures = world.batchFailures;
  evidence.push({
    scenarioId: id,
    candidate: candidateFactory ? "commands" : "legacy",
    classification:
      "Existing concurrency law; new native execution awaiting classification",
    substrate: planned ? "atomic-batch" : "interactive",
    namespace: world.namespace,
    connections: world.connections,
    candidateEntries: world.candidateEntries,
    publicInput: (replaced ? ["s2", "s1"] : ["s1", "s2"]).map((owner) =>
      args(owner)
    ),
    observation: world.observation,
    completions: world.completions,
    statements: world.statements,
    batchFailures: world.batchFailures.map(observeFailure),
    nativeFailures: [...nativeFailures].map(([owner, failure]) => ({
      owner,
      failure: observeFailure(failure),
    })),
  });
  world.assertHealthy();
  fixture.assert(world.observation);
  return world;
}
