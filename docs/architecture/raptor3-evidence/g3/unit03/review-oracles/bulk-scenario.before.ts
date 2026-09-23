import assert from "node:assert/strict";
import { s } from "@schema";
import type {
  OperationOutcome,
  StateRows,
  ScenarioDefinition,
} from "../../harness/protocol";
import { observeFailure } from "../../harness/sqlite-world";
import {
  g3RecipeFromPublicInput,
  type G3GeneratedRecipe,
} from "./recipe";

type BulkRecipe = Extract<G3GeneratedRecipe, { contract: "C08" }>;

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

function operationOutcome(
  settled: PromiseSettledResult<unknown>
): OperationOutcome {
  return settled.status === "fulfilled"
    ? { kind: "success", value: settled.value }
    : { kind: "failure", failure: observeFailure(settled.reason) };
}

/** One fixed schema family owns generated C08 public inputs and raw-state oracles. */
export function generatedBulkScenario(recipe: BulkRecipe): ScenarioDefinition {
  return {
    id: "g3-generated-bulk-series",
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
      const initialRows = Array.from({ length: 8 }, (_, index) => ({
        id: recipe.seed * 1000 + index,
        code: `stored-${index}`,
        label: `stored-label-${index}`,
        secret: `stored-secret-${index}`,
        score: index,
      }));

      return {
        publicInput: { recipe },
        requiredCuts: [
          "g3-generated-bulk-provider-completed",
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
          assert(candidateFactory, "G3 generated worlds require the command engine");
          const candidate = candidateFactory({ schema, driver });
          const execute = (operation: number) => {
            const base = recipe.seed * 1000 + 100 + operation * 16;
            const presentation =
              recipe.presentation === "count"
                ? {}
                : recipe.presentation === "select"
                  ? { select: { id: true, code: true, score: true } }
                  : { omit: { secret: true } };
            if (recipe.verb === "createMany") {
              const rows = Array.from(
                { length: recipe.rowCount },
                (_, index) => ({
                  id: base + index,
                  code: `created-${operation}-${index}`,
                  ...(index % 2 === 0
                    ? {}
                    : { label: `explicit-${operation}-${index}` }),
                  secret: `secret-${operation}-${index}`,
                  score: index,
                })
              );
              return candidate
                .execute("record", "createMany", {
                  data: rows,
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
          for (let operation = outcomes.length; operation < recipe.operations; operation++) {
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
        afterStatement(_database, completion) {
          if (!/^(?:INSERT|UPDATE|DELETE)\b/i.test(completion.sql.trim()))
            return undefined;
          const cuts = ["g3-generated-bulk-provider-completed"];
          if (
            recipe.actors === 2 &&
            !overlapObserved &&
            settlements === 0
          ) {
            overlapObserved = true;
            cuts.push("g3-generated-bulk-actors-overlapped");
          }
          return cuts;
        },
        assert(observation) {
          assert.equal(observation.outcome.kind, "success");
          if (observation.outcome.kind !== "success") return;
          assert(Array.isArray(observation.outcome.value));
          assert.equal(observation.outcome.value.length, recipe.operations);
          const outcomes = observation.outcome.value;
          for (const [index, wrapped] of outcomes.entries()) {
            assert(wrapped && typeof wrapped === "object" && "kind" in wrapped);
            assert.equal(
              wrapped.kind,
              index === 0 && recipe.fault !== "none" ? "failure" : "success"
            );
          }
          const initial = readRows(observation.initial);
          const final = readRows(observation.final);
          if (recipe.verb === "createMany") {
            assert.equal(initial.length, 0);
            assert.equal(
              final.length,
              (recipe.operations - (recipe.fault === "none" ? 0 : 1)) *
                recipe.rowCount
            );
          } else if (recipe.verb === "updateMany") {
            assert.equal(initial.length, 8);
            assert.equal(final.length, 8);
            const changed = final.filter((row) => row.score >= 100);
            const successfulOperations =
              recipe.operations - (recipe.fault === "none" ? 0 : 1);
            assert.equal(
              changed.length,
              Math.min(8, recipe.limit * successfulOperations)
            );
          } else {
            assert.equal(initial.length, 8);
            const successfulOperations =
              recipe.operations - (recipe.fault === "none" ? 0 : 1);
            assert.equal(
              final.length,
              8 - Math.min(8, recipe.limit * successfulOperations)
            );
          }
          for (const wrapped of outcomes) {
            assert(wrapped && typeof wrapped === "object" && "kind" in wrapped);
            if (wrapped.kind === "failure") continue;
            assert("value" in wrapped);
            const outcome = wrapped.value;
            if (recipe.presentation === "count") {
              assert(
                outcome &&
                  typeof outcome === "object" &&
                  "count" in outcome &&
                  typeof outcome.count === "number",
                "g3-generated-bulk:count"
              );
              continue;
            }
            for (const row of returnedRows(outcome)) {
              assert.equal(typeof row.id, "number");
              assert.equal(typeof row.code, "string");
              assert.equal(typeof row.score, "number");
              if (recipe.presentation === "omit")
                assert.equal("secret" in row, false);
            }
          }
        },
      };
    },
  };
}

export function generatedBulkScenarioFromPublicInput(
  input: unknown
): ScenarioDefinition {
  const recipe = g3RecipeFromPublicInput(input);
  assert.equal(
    recipe.contract,
    "C08",
    "G3 bulk replay requires the admitted C08 recipe"
  );
  if (recipe.contract !== "C08") throw new Error("Unreachable G3 recipe");
  return generatedBulkScenario(recipe);
}
