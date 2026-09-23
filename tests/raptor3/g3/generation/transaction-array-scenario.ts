import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import type {
  CandidateEngineFactory,
  OperationOutcome,
  ScenarioDefinition,
} from "../../harness/protocol";
import { observeFailure } from "../../harness/sqlite-world";
import type { G3GeneratedRecipe } from "./recipe";

type TransactionRecipe = Extract<G3GeneratedRecipe, { contract: "C10" }>;
type Candidate = ReturnType<CandidateEngineFactory>;

interface ArrayRow {
  readonly id: number;
  readonly code: string;
  readonly secret: string;
  readonly score: number;
}

function isPromiseArray(value: unknown): value is Promise<unknown[]> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function transactionArray(client: object, operations: readonly unknown[]) {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  const pending: unknown = Reflect.apply(transaction, client, [operations]);
  assert(isPromiseArray(pending));
  return pending;
}

function outcome(settled: PromiseSettledResult<unknown>): OperationOutcome {
  return settled.status === "fulfilled"
    ? { kind: "success", value: settled.value }
    : { kind: "failure", failure: observeFailure(settled.reason) };
}

function packagedCreate(
  source: PromiseLike<unknown>,
  candidate: Candidate,
  args: unknown,
  capture: (driver: AnyDriver) => void
) {
  return overrideTransactionOperation(source, {
    prepare: () => undefined,
    executeWith(transactionDriver) {
      capture(transactionDriver);
      return candidate.execute("record", "createMany", args, {
        kind: "borrowed-transaction",
        driver: transactionDriver,
      });
    },
    prepareBatch(): Promise<PreparedBatchOperation<unknown> | undefined> {
      return candidate.prepareBatch("record", "createMany", args);
    },
  });
}

function readRows(rows: readonly unknown[]): ArrayRow[] {
  return rows.map((row) => {
    assert(row && typeof row === "object", "g3-c10:atomic-state");
    assert("id" in row && typeof row.id === "number", "g3-c10:atomic-state");
    assert(
      "code" in row && typeof row.code === "string",
      "g3-c10:atomic-state"
    );
    assert(
      "secret" in row && typeof row.secret === "string",
      "g3-c10:atomic-state"
    );
    assert(
      "score" in row && typeof row.score === "number",
      "g3-c10:atomic-state"
    );
    return {
      id: row.id,
      code: row.code,
      secret: row.secret,
      score: row.score,
    };
  });
}

/** C10 generated cells compose real public array members on the selected substrate. */
export function generatedTransactionArrayScenario(
  recipe: TransactionRecipe
): ScenarioDefinition {
  return {
    id: "g3-generated-transaction-array",
    family: "C10",
    contracts: ["C08", "C10", "C13"],
    sources: ["tests/raptor3/g3/transaction-array-contract.test.ts"],
    prepare(controls) {
      const record = s
        .model({
          id: s.int().id(),
          code: s.string().unique(),
          secret: s.string().default("private"),
          score: s.int().default(0),
        })
        .map("g3_generated_array_records");
      const schema = { record };
      const base = recipe.seed * 1000;
      const reservePeer = recipe.actors === 2 ? 1 : 0;
      const reserveRecovery = recipe.fault === "none" ? 0 : 1;
      const availableMembers =
        recipe.operations - reservePeer - reserveRecovery;
      const reserveLate =
        controls.profile === "sqlite-interactive" &&
        recipe.composition === "borrowed" &&
        availableMembers > 1
          ? 1
          : 0;
      const memberCount = availableMembers - reserveLate;
      assert(memberCount >= 1);
      const expectedExecutions =
        controls.profile === "sqlite-interactive" && recipe.fault !== "none"
          ? 1 + reservePeer + reserveRecovery + reserveLate
          : recipe.operations;
      const memberRows: ArrayRow[] = Array.from(
        { length: memberCount },
        (_, index) => ({
          id: base + index,
          code: `member-${index}`,
          secret: "private",
          score: index,
        })
      );
      const peerRow: ArrayRow = {
        id: base + 100,
        code: "peer",
        secret: "private",
        score: 100,
      };
      const recoveryRow: ArrayRow = {
        id: base + 200,
        code: "healthy-recovery",
        secret: "private",
        score: 200,
      };
      let starts = 0;
      let settlements = 0;
      let overlapObserved = false;
      let escapedDriver: AnyDriver | undefined;

      return {
        publicInput: { recipe },
        requiredCuts: [
          "g3-generated-array-provider-completed",
          ...(recipe.actors === 2
            ? ["g3-generated-array-actors-overlapped"]
            : []),
        ],
        expectedExecutions,
        seed(database) {
          database.exec(`
            CREATE TABLE g3_generated_array_records(
              id INTEGER PRIMARY KEY,
              code TEXT NOT NULL UNIQUE,
              secret TEXT NOT NULL,
              score INTEGER NOT NULL
            ) STRICT;
          `);
        },
        async invoke(driver, candidateFactory) {
          assert(
            candidateFactory,
            "G3 generated worlds require the command engine"
          );
          const candidate = candidateFactory({ schema, driver });
          const client = createClient({ schema, driver });
          const members = Array.from({ length: memberCount }, (_, index) =>
            packagedCreate(
              client.record.findMany(),
              candidate,
              {
                data: [
                  {
                    id: base + index,
                    code: `member-${index}`,
                    score: index,
                  },
                ],
                select: { id: true, code: true, score: true },
              },
              (transactionDriver) => {
                escapedDriver ??= transactionDriver;
              }
            )
          );
          const start = (pending: Promise<unknown>) => {
            starts++;
            return pending.finally(() => settlements++);
          };
          const primary = start(transactionArray(client, members));
          let peer: Promise<unknown> | undefined;
          if (recipe.actors === 2) {
            peer = start(
              candidate.execute("record", "createMany", {
                data: [{ id: base + 100, code: "peer", score: 100 }],
                select: { id: true },
              })
            );
            assert.equal(starts, 2, "g3-generated-array:two-starts");
            assert.equal(
              settlements,
              0,
              "g3-generated-array:overlapping-lifetimes"
            );
          }
          const settled = await Promise.allSettled(
            peer ? [primary, peer] : [primary]
          );
          let recovery: PromiseSettledResult<unknown> | undefined;
          if (recipe.fault !== "none")
            recovery = (
              await Promise.allSettled([
                candidate.execute("record", "createMany", {
                  data: [
                    { id: base + 200, code: "healthy-recovery", score: 200 },
                  ],
                  select: { id: true },
                }),
              ])
            )[0]!;
          let late: PromiseSettledResult<unknown> | undefined;
          if (reserveLate) {
            assert(escapedDriver, "Borrowed array did not expose its transaction");
            late = (
              await Promise.allSettled([
                candidate.execute(
                  "record",
                  "createMany",
                  {
                    data: [{ id: base + 300, code: "late", score: 300 }],
                  },
                  { kind: "borrowed-transaction", driver: escapedDriver }
                ),
              ])
            )[0]!;
          }
          return {
            primary: outcome(settled[0]!),
            ...(settled[1] ? { peer: outcome(settled[1]) } : {}),
            ...(recovery ? { recovery: outcome(recovery) } : {}),
            ...(late ? { late: outcome(late) } : {}),
          };
        },
        inspect(database) {
          return {
            records: database
              .prepare(
                "SELECT id,code,secret,score FROM g3_generated_array_records ORDER BY id"
              )
              .all(),
          };
        },
        afterStatement() {
          const cuts = ["g3-generated-array-provider-completed"];
          if (
            recipe.actors === 2 &&
            !overlapObserved &&
            settlements === 0
          ) {
            overlapObserved = true;
            cuts.push("g3-generated-array-actors-overlapped");
          }
          return cuts;
        },
        assert(observation) {
          assert.equal(observation.outcome.kind, "success");
          if (observation.outcome.kind !== "success") return;
          assert.deepEqual(
            observation.initial,
            { records: [] },
            "g3-c10:initial-state"
          );
          const value = observation.outcome.value;
          assert(value && typeof value === "object");
          assert("primary" in value);
          const primary = value.primary;
          assert(primary && typeof primary === "object" && "kind" in primary);
          assert.equal(
            primary.kind,
            recipe.fault === "none" ? "success" : "failure",
            "g3-generated-array:primary-attempt"
          );
          if (primary.kind === "success") {
            assert("value" in primary, "g3-c10:packaged-member-results");
            assert.deepEqual(
              primary.value,
              memberRows.map((row) => [
                { id: row.id, code: row.code, score: row.score },
              ]),
              "g3-c10:packaged-member-results"
            );
          }
          if (recipe.actors === 2) {
            assert("peer" in value, "g3-c10:peer-results");
            const peer = value.peer;
            assert(peer && typeof peer === "object" && "kind" in peer);
            assert.equal(peer.kind, "success", "g3-c10:peer-results");
            assert("value" in peer, "g3-c10:peer-results");
            assert.deepEqual(
              peer.value,
              [{ id: peerRow.id }],
              "g3-c10:peer-results"
            );
          } else assert(!("peer" in value), "g3-c10:peer-results");
          if (recipe.fault !== "none") {
            assert("recovery" in value, "g3-c10:recovery-results");
            const recovery = value.recovery;
            assert(
              recovery &&
                typeof recovery === "object" &&
                "kind" in recovery
            );
            assert.equal(recovery.kind, "success", "g3-c10:recovery-results");
            assert("value" in recovery, "g3-c10:recovery-results");
            assert.deepEqual(
              recovery.value,
              [{ id: recoveryRow.id }],
              "g3-c10:recovery-results"
            );
          } else
            assert(!("recovery" in value), "g3-c10:recovery-results");
          if (reserveLate) {
            assert("late" in value, "g3-c10:late-result");
            const late = value.late;
            assert(late && typeof late === "object" && "kind" in late);
            assert.equal(
              late.kind,
              "failure",
              "g3-generated-array:closed-transaction-refusal"
            );
          } else assert(!("late" in value), "g3-c10:late-result");
          const expectedFinal = [
            ...(recipe.fault === "none" ? memberRows : []),
            ...(recipe.actors === 2 ? [peerRow] : []),
            ...(recipe.fault !== "none" ? [recoveryRow] : []),
          ].sort((left, right) => left.id - right.id);
          const rows = observation.final.records;
          assert(rows, "g3-c10:atomic-state");
          assert.deepEqual(
            readRows(rows),
            expectedFinal,
            recipe.fault === "none"
              ? "g3-c10:final-state"
              : "g3-c10:atomic-rollback-state"
          );
        },
      };
    },
  };
}
