import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { OperationOutcome, ScenarioDefinition } from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";

function engineReuse(recovery: boolean): ScenarioDefinition {
  return {
    id: recovery ? "g1-reuse-after-rollback" : "g1-concurrent-queued-creates",
    family: "C04",
    contracts: ["C04", "C10", "C13"],
    sources: [
      "tests/raptor3/scenarios/contracts/conditional.ts",
      "src/drivers/driver-transaction-base.ts",
      "src/drivers/sqlite3/index.ts",
    ],
    prepare(controls) {
      let admissions = 0;
      const parent = s
        .model({
          id: s.int().id().increment(),
          name: s.string(),
          ticket: s.int().default(() => {
            admissions += 1;
            controls.recordDefault("parent.ticket", admissions);
            return admissions;
          }),
          children: s.toMany(() => child),
        })
        .map("g1_reuse_parents");
      const child = s
        .model({
          id: s.string().id(),
          parentId: s.int(),
          parent: s
            .toOne(() => parent)
            .fields("parentId")
            .references("id"),
        })
        .map("g1_reuse_children");
      const schema = { parent, child };
      const select = {
        id: true,
        name: true,
        ticket: true,
        children: {
          orderBy: { id: "asc" },
          select: { id: true, parentId: true },
        },
      } as const;
      const failedArgs = {
        data: {
          name: "failed",
          children: { create: [{ id: "first" }, { id: "collision" }] },
        },
        select,
      };
      const firstName = recovery ? "healthy-a" : "queued-a";
      const secondName = recovery ? "healthy-b" : "queued-b";
      const firstArgs = {
        data: { name: firstName, children: { create: { id: "child-a" } } },
        select,
      };
      const secondArgs = {
        data: { name: secondName, children: { create: { id: "child-b" } } },
        select,
      };
      const firstTicket = recovery ? 2 : 1;
      const secondTicket = recovery ? 3 : 2;
      const firstValue = {
        id: 41,
        name: firstName,
        ticket: firstTicket,
        children: [{ id: "child-a", parentId: 41 }],
      };
      const secondValue = {
        id: 42,
        name: secondName,
        ticket: secondTicket,
        children: [{ id: "child-b", parentId: 42 }],
      };
      const initial = {
        parents: [{ id: 7, name: "decoy", ticket: 0 }],
        children: [{ id: "collision", parentId: 7 }],
        sequences: [{ name: "g1_reuse_parents", seq: 40 }],
      };
      const failedCut = "g1-failed-producer-visible";
      const firstCut = recovery
        ? "g1-recovered-producer-visible"
        : "g1-queued-first-producer-visible";
      const secondCut = recovery
        ? "g1-reused-fresh-producer-visible"
        : "g1-queued-second-producer-visible";
      const cuts = recovery
        ? [failedCut, firstCut, secondCut]
        : [firstCut, secondCut];
      const reached = new Set<string>();
      const subsequentOutcomes: OperationOutcome[] = [];
      return {
        publicInput: {
          model: "parent",
          operation: "create",
          execution: recovery
            ? "same engine, failed call then two healthy calls"
            : "same engine, two starts before await under the stock SQLite connection lease",
          calls: recovery
            ? [failedArgs, firstArgs, secondArgs]
            : [firstArgs, secondArgs],
        },
        expectedExecutions: recovery ? 3 : 2,
        subsequentOutcomes,
        requiredCuts: cuts,
        seed(database) {
          database.exec(`
            CREATE TABLE g1_reuse_parents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ticket INTEGER NOT NULL);
            CREATE TABLE g1_reuse_children (id TEXT PRIMARY KEY, parentId INTEGER NOT NULL REFERENCES g1_reuse_parents(id));
            INSERT INTO g1_reuse_parents VALUES (7,'decoy',0);
            INSERT INTO g1_reuse_children VALUES ('collision',7);
            UPDATE sqlite_sequence SET seq=40;
          `);
        },
        async invoke(driver, candidateFactory) {
          // Reuse the returned engine, not its internal per-operation representation.
          const engine = candidateFactory?.({ schema, driver });
          const client = engine ? undefined : createClient({ schema, driver });
          const create = async (args: typeof failedArgs | typeof firstArgs) => {
            if (engine) return await engine.execute("parent", "create", args);
            assert.ok(client);
            return await client.parent.create(args);
          };
          if (!recovery) {
            // Both calls enter before an await; the driver's existing lease queues
            // whole transactions. No unrelated SQL enters a held transaction.
            const first = create(firstArgs);
            const second = create(secondArgs);
            const outcomes = await Promise.allSettled([first, second]);
            const secondOutcome = outcomes[1];
            assert.ok(secondOutcome);
            subsequentOutcomes.push(
              secondOutcome.status === "fulfilled"
                ? { kind: "success", value: secondOutcome.value }
                : {
                    kind: "failure",
                    failure: observeFailure(secondOutcome.reason),
                  }
            );
            const firstOutcome = outcomes[0];
            assert.ok(firstOutcome);
            if (firstOutcome.status === "rejected") throw firstOutcome.reason;
            return firstOutcome.value;
          }
          let firstFailure: unknown;
          let firstOutcome: OperationOutcome;
          try {
            firstOutcome = { kind: "success", value: await create(failedArgs) };
          } catch (failure) {
            firstFailure = failure;
            firstOutcome = {
              kind: "failure",
              failure: observeFailure(failure),
            };
          }
          for (const args of [firstArgs, secondArgs]) {
            try {
              subsequentOutcomes.push({
                kind: "success",
                value: await create(args),
              });
            } catch (failure) {
              subsequentOutcomes.push({
                kind: "failure",
                failure: observeFailure(failure),
              });
            }
          }
          if (firstOutcome.kind === "failure") throw firstFailure;
          return firstOutcome.value;
        },
        inspect(database) {
          return {
            parents: database
              .prepare("SELECT * FROM g1_reuse_parents ORDER BY id")
              .all(),
            children: database
              .prepare("SELECT * FROM g1_reuse_children ORDER BY id")
              .all(),
            sequences: database
              .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
              .all(),
          };
        },
        afterStatement(database, completion) {
          if (!recovery)
            assert.equal(
              admissions,
              2,
              "Both queued calls must be admitted before the first provider completion"
            );
          const failed = database
            .prepare("SELECT id FROM g1_reuse_parents WHERE name='failed'")
            .get();
          if (recovery && failed && !reached.has(failedCut)) {
            assert.deepEqual(failed, { id: 41 });
            assert.equal(completion.transactionOpen, true);
            reached.add(failedCut);
            return failedCut;
          }
          const first = database
            .prepare("SELECT id,ticket FROM g1_reuse_parents WHERE name=?")
            .get(firstName);
          if (first && !reached.has(firstCut)) {
            assert.equal(failed, undefined);
            assert.deepEqual(first, { id: 41, ticket: firstTicket });
            assert.equal(completion.transactionOpen, true);
            reached.add(firstCut);
            return firstCut;
          }
          const second = database
            .prepare("SELECT id,ticket FROM g1_reuse_parents WHERE name=?")
            .get(secondName);
          if (second && !reached.has(secondCut)) {
            assert.deepEqual(second, { id: 42, ticket: secondTicket });
            assert.deepEqual(
              database
                .prepare("SELECT * FROM g1_reuse_children WHERE id='child-a'")
                .get(),
              { id: "child-a", parentId: 41 }
            );
            assert.equal(completion.transactionOpen, true);
            reached.add(secondCut);
            return secondCut;
          }
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, {
            parents: [
              initial.parents[0],
              { id: 41, name: firstName, ticket: firstTicket },
              { id: 42, name: secondName, ticket: secondTicket },
            ],
            children: [
              { id: "child-a", parentId: 41 },
              { id: "child-b", parentId: 42 },
              initial.children[0],
            ],
            sequences: [{ name: "g1_reuse_parents", seq: 42 }],
          });
          assert.deepEqual(
            observation.defaults,
            Array.from({ length: recovery ? 3 : 2 }, (_, index) => ({
              name: "parent.ticket",
              value: index + 1,
            }))
          );
          assert.deepEqual(observation.reachedCuts, cuts);
          assert.deepEqual(
            observation.subsequentOutcomes,
            recovery
              ? [
                  { kind: "success", value: firstValue },
                  { kind: "success", value: secondValue },
                ]
              : [{ kind: "success", value: secondValue }]
          );
          if (!recovery) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: firstValue,
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(
            observation.outcome.failure.name,
            "UniqueConstraintError"
          );
          assert.equal(observation.outcome.failure.code, "V3001");
        },
      };
    },
  };
}

export const engineReuseScenarios = [engineReuse(true), engineReuse(false)];
