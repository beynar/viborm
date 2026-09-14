import assert from "node:assert/strict";
import { s } from "@schema";
import type {
  OperationOutcome,
  StateRows,
  ScenarioDefinition,
} from "../../harness/protocol";
import { observeFailure } from "../../harness/sqlite-world";
import { g3RecipeFromPublicInput, type G3GeneratedRecipe } from "./recipe";

type BulkRecipe = Extract<G3GeneratedRecipe, { contract: "C08" }>;

interface BulkScenarioOptions {
  readonly specimen?: "wrong-g3-stored-state";
}

interface BulkRow {
  id: number;
  code: string;
  label: string;
  secret: string;
  score: number;
}

function readRows(state: StateRows): BulkRow[] {
  const records = state.records;
  assert(records, "g3-generated-bulk:missing-state");
  return records.map((row) => {
    assert(row && typeof row === "object");
    assert("id" in row && typeof row.id === "number");
    assert("code" in row && typeof row.code === "string");
    assert("label" in row && typeof row.label === "string");
    assert("secret" in row && typeof row.secret === "string");
    assert("score" in row && typeof row.score === "number");
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      secret: row.secret,
      score: row.score,
    };
  });
}

function returnedRows(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value), "g3-generated-bulk:returned-series");
  return value.map((row) => {
    assert(row && typeof row === "object", "g3-generated-bulk:returned-row");
    return { ...row };
  });
}

function byId(left: { id: number }, right: { id: number }): number {
  return left.id - right.id;
}

function presentationRow(
  row: BulkRow,
  presentation: BulkRecipe["presentation"]
): Record<string, unknown> {
  return presentation === "select"
    ? { id: row.id, code: row.code, score: row.score }
    : { id: row.id, code: row.code, label: row.label, score: row.score };
}

function returnedId(row: Record<string, unknown>): number {
  assert(typeof row.id === "number", "g3-c08:returned-rows");
  return row.id;
}

function returnedCount(value: unknown, limit: number): number {
  assert(
    value && typeof value === "object" && "count" in value,
    "g3-c08:count"
  );
  assert(
    typeof value.count === "number" &&
      Number.isInteger(value.count) &&
      value.count >= 0 &&
      value.count <= limit,
    "g3-c08:count"
  );
  return value.count;
}

function operationOutcome(
  settled: PromiseSettledResult<unknown>
): OperationOutcome {
  return settled.status === "fulfilled"
    ? { kind: "success", value: settled.value }
    : { kind: "failure", failure: observeFailure(settled.reason) };
}

/** One fixed schema family owns generated C08 public inputs and raw-state oracles. */
export function generatedBulkScenario(
  recipe: BulkRecipe,
  options: BulkScenarioOptions = {}
): ScenarioDefinition {
  return {
    id: "g3-generated-bulk-series",
    ...(options.specimen ? { specimen: options.specimen } : {}),
    family: "C08",
    contracts: ["C08", "C13"],
    sources: ["tests/raptor3/g3/bulk-series-contract.test.ts"],
    prepare(controls) {
      let defaultSequence = 0;
      const record = s
        .model({
          id: s.int().id(),
          code: s.string().unique(),
          label: s.string().default(() => {
            const value = `default-${recipe.seed}-${++defaultSequence}`;
            controls.recordDefault("record.label", value);
            return value;
          }),
          secret: s.string().default("private"),
          score: s.int().default(0),
        })
        .map("g3_generated_bulk_records");
      const schema = { record };
      let settlements = 0;
      let overlapObserved = false;
      let specimenApplied = false;
      const initialRows = Array.from({ length: 8 }, (_, index) => ({
        id: recipe.seed * 1000 + index,
        code: `stored-${index}`,
        label: `stored-label-${index}`,
        secret: `stored-secret-${index}`,
        score: index,
      }));
      const defaultsPerCreate = Math.ceil(recipe.rowCount / 2);
      const createInputRows = (operation: number) => {
        const base = recipe.seed * 1000 + 100 + operation * 16;
        return Array.from({ length: recipe.rowCount }, (_, index) => ({
          id: base + index,
          code: `created-${operation}-${index}`,
          ...(index % 2 === 0
            ? {}
            : { label: `explicit-${operation}-${index}` }),
          secret: `secret-${operation}-${index}`,
          score: index,
        }));
      };
      const expectedCreateRows = (operation: number): BulkRow[] =>
        createInputRows(operation).map((row, index) => ({
          ...row,
          label:
            "label" in row && typeof row.label === "string"
              ? row.label
              : `default-${recipe.seed}-${operation * defaultsPerCreate + Math.floor(index / 2) + 1}`,
        }));

      return {
        publicInput: { recipe },
        requiredCuts: [
          ...(recipe.verb === "createMany" || recipe.limit > 0
            ? ["g3-generated-bulk-provider-completed"]
            : []),
          ...(recipe.actors === 2
            ? ["g3-generated-bulk-actors-overlapped"]
            : []),
        ],
        expectedExecutions: recipe.operations,
        seed(database) {
          database.exec(`
            CREATE TABLE g3_generated_bulk_records(
              id INTEGER PRIMARY KEY,
              code TEXT NOT NULL UNIQUE,
              label TEXT NOT NULL,
              secret TEXT NOT NULL,
              score INTEGER NOT NULL
            ) STRICT;
          `);
          if (recipe.verb === "createMany") return;
          const insert = database.prepare(
            "INSERT INTO g3_generated_bulk_records(id,code,label,secret,score) VALUES(?,?,?,?,?)"
          );
          for (const row of initialRows)
            insert.run(row.id, row.code, row.label, row.secret, row.score);
        },
        async invoke(driver, candidateFactory) {
          assert(
            candidateFactory,
            "G3 generated worlds require the command engine"
          );
          const candidate = candidateFactory({ schema, driver });
          const execute = (operation: number) => {
            const presentation =
              recipe.presentation === "count"
                ? {}
                : recipe.presentation === "select"
                  ? { select: { id: true, code: true, score: true } }
                  : { omit: { secret: true } };
            if (recipe.verb === "createMany") {
              return candidate
                .execute("record", "createMany", {
                  data: createInputRows(operation),
                  ...presentation,
                })
                .finally(() => settlements++);
            }
            if (recipe.verb === "updateMany") {
              return candidate
                .execute("record", "updateMany", {
                  where: { score: { lt: 100 } },
                  data: { score: { increment: 100 } },
                  limit: recipe.limit,
                  ...presentation,
                })
                .finally(() => settlements++);
            }
            return candidate
              .execute("record", "deleteMany", {
                where: { score: { lt: 100 } },
                limit: recipe.limit,
                ...presentation,
              })
              .finally(() => settlements++);
          };
          const outcomes: PromiseSettledResult<unknown>[] = [];
          const primary = execute(0);
          if (recipe.actors === 2)
            outcomes.push(...(await Promise.allSettled([primary, execute(1)])));
          else outcomes.push((await Promise.allSettled([primary]))[0]!);
          for (
            let operation = outcomes.length;
            operation < recipe.operations;
            operation++
          ) {
            outcomes.push((await Promise.allSettled([execute(operation)]))[0]!);
          }
          return outcomes.map(operationOutcome);
        },
        inspect(database) {
          return {
            records: database
              .prepare(
                "SELECT id,code,label,secret,score FROM g3_generated_bulk_records ORDER BY id"
              )
              .all(),
          };
        },
        afterStatement(database, completion) {
          if (!/^(?:INSERT|UPDATE|DELETE)\b/i.test(completion.sql.trim()))
            return undefined;
          const storedCount = database
            .prepare("SELECT COUNT(*) AS count FROM g3_generated_bulk_records")
            .get();
          const deletionReached =
            storedCount !== undefined &&
            storedCount !== null &&
            typeof storedCount === "object" &&
            "count" in storedCount &&
            typeof storedCount.count === "number" &&
            storedCount.count < initialRows.length;
          const successfulWriteReached =
            recipe.verb === "createMany"
              ? database
                  .prepare(
                    "SELECT 1 FROM g3_generated_bulk_records WHERE code LIKE 'created-%'"
                  )
                  .get()
              : recipe.verb === "updateMany"
                ? database
                    .prepare(
                      "SELECT 1 FROM g3_generated_bulk_records WHERE score >= 100"
                    )
                    .get()
                : deletionReached;
          if (
            options.specimen === "wrong-g3-stored-state" &&
            !specimenApplied &&
            successfulWriteReached
          ) {
            database
              .prepare(
                "INSERT INTO g3_generated_bulk_records(id,code,label,secret,score) VALUES(?,?,?,?,?)"
              )
              .run(
                recipe.seed * 1000 + 900,
                "fixture-corrupt",
                "fixture-corrupt",
                "fixture-corrupt",
                100_000
              );
            specimenApplied = true;
          }
          const cuts = ["g3-generated-bulk-provider-completed"];
          if (recipe.actors === 2 && !overlapObserved && settlements === 0) {
            overlapObserved = true;
            cuts.push("g3-generated-bulk-actors-overlapped");
          }
          return cuts;
        },
        assert(observation) {
          assert.equal(observation.outcome.kind, "success");
          if (observation.outcome.kind !== "success") return;
          assert(Array.isArray(observation.outcome.value));
          assert.equal(
            observation.outcome.value.length,
            recipe.operations,
            "g3-c08:result-count"
          );
          const outcomes = observation.outcome.value;
          const successful: Array<{
            readonly operation: number;
            readonly value: unknown;
          }> = [];
          for (const [index, wrapped] of outcomes.entries()) {
            assert(wrapped && typeof wrapped === "object" && "kind" in wrapped);
            const expectedFailure = index === 0 && recipe.fault !== "none";
            assert.equal(
              wrapped.kind,
              expectedFailure ? "failure" : "success",
              "g3-c08:operation-outcome"
            );
            if (!expectedFailure) {
              assert("value" in wrapped, "g3-c08:returned-results");
              successful.push({ operation: index, value: wrapped.value });
            }
          }
          const initial = readRows(observation.initial);
          const final = readRows(observation.final);
          assert.deepEqual(
            initial,
            recipe.verb === "createMany" ? [] : initialRows,
            "g3-c08:initial-state"
          );
          assert.deepEqual(
            observation.defaults,
            recipe.verb === "createMany"
              ? Array.from(
                  { length: recipe.operations * defaultsPerCreate },
                  (_, index) => ({
                    name: "record.label",
                    value: `default-${recipe.seed}-${index + 1}`,
                  })
                )
              : [],
            "g3-c08:default-ledger"
          );
          if (recipe.verb === "createMany") {
            const expectedFinal = successful
              .flatMap(({ operation }) => expectedCreateRows(operation))
              .sort(byId);
            assert.deepEqual(final, expectedFinal, "g3-c08:stored-state");
            for (const { operation, value } of successful) {
              const expectedRows = expectedCreateRows(operation).map((row) =>
                presentationRow(row, recipe.presentation)
              );
              if (recipe.presentation === "count") {
                assert.deepEqual(
                  value,
                  { count: recipe.rowCount },
                  "g3-c08:count"
                );
              } else {
                assert.deepEqual(
                  returnedRows(value),
                  expectedRows,
                  "g3-c08:returned-results"
                );
              }
            }
            return;
          }

          const successfulOperations = successful.length;
          const affectedCount = Math.min(
            initialRows.length,
            recipe.limit * successfulOperations
          );
          if (recipe.verb === "updateMany") {
            assert.equal(
              final.length,
              initialRows.length,
              "g3-c08:stored-state"
            );
            const initialById = new Map(initial.map((row) => [row.id, row]));
            const changed = final.filter((row) => {
              const before = initialById.get(row.id);
              assert(before, "g3-c08:stored-state");
              assert.deepEqual(
                { code: row.code, label: row.label, secret: row.secret },
                {
                  code: before.code,
                  label: before.label,
                  secret: before.secret,
                },
                "g3-c08:untouched-fields"
              );
              assert(
                row.score === before.score || row.score === before.score + 100,
                "g3-c08:stored-state"
              );
              return row.score === before.score + 100;
            });
            assert.equal(changed.length, affectedCount, "g3-c08:stored-state");
            if (recipe.presentation === "count") {
              const counts = successful.map(({ value }) =>
                returnedCount(value, recipe.limit)
              );
              assert.equal(
                counts.reduce((total, count) => total + count, 0),
                affectedCount,
                "g3-c08:count"
              );
              return;
            }
            const returned = successful.flatMap((entry) => {
              const rows = returnedRows(entry.value);
              assert(rows.length <= recipe.limit, "g3-c08:result-count");
              return rows;
            });
            assert.equal(returned.length, affectedCount, "g3-c08:result-count");
            assert.deepEqual(
              returned.sort(
                (left, right) => returnedId(left) - returnedId(right)
              ),
              changed
                .map((row) => presentationRow(row, recipe.presentation))
                .sort((left, right) => returnedId(left) - returnedId(right)),
              "g3-c08:results-persisted-rows"
            );
            return;
          }

          assert.equal(
            final.length,
            initialRows.length - affectedCount,
            "g3-c08:stored-state"
          );
          const finalIds = new Set(final.map(({ id }) => id));
          for (const row of final) {
            const before = initialRows.find(({ id }) => id === row.id);
            assert(before, "g3-c08:stored-state");
            assert.deepEqual(row, before, "g3-c08:untouched-fields");
          }
          const removed = initialRows.filter(({ id }) => !finalIds.has(id));
          if (recipe.presentation === "count") {
            const counts = successful.map(({ value }) =>
              returnedCount(value, recipe.limit)
            );
            assert.equal(
              counts.reduce((total, count) => total + count, 0),
              affectedCount,
              "g3-c08:count"
            );
            return;
          }
          const returned = successful.flatMap((entry) => {
            const rows = returnedRows(entry.value);
            assert(rows.length <= recipe.limit, "g3-c08:result-count");
            return rows;
          });
          assert.equal(returned.length, affectedCount, "g3-c08:result-count");
          assert.deepEqual(
            returned.sort(
              (left, right) => returnedId(left) - returnedId(right)
            ),
            removed
              .map((row) => presentationRow(row, recipe.presentation))
              .sort((left, right) => returnedId(left) - returnedId(right)),
            "g3-c08:results-persisted-rows"
          );
        },
      };
    },
  };
}

export function generatedBulkScenarioFromPublicInput(
  input: unknown,
  options: BulkScenarioOptions = {}
): ScenarioDefinition {
  const recipe = g3RecipeFromPublicInput(input);
  assert.equal(
    recipe.contract,
    "C08",
    "G3 bulk replay requires the admitted C08 recipe"
  );
  if (recipe.contract !== "C08") throw new Error("Unreachable G3 recipe");
  return generatedBulkScenario(recipe, options);
}
