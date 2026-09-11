import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../../harness/protocol";

function grouped(empty: boolean): ScenarioDefinition {
  return {
    id: empty ? "s3-empty" : "s3-grouped",
    family: "S3",
    contracts: ["C12"],
    sources: ["tests/contracts/drivers/behaviors/prisma-parity-behavior.ts"],
    prepare() {
      const reading = s
        .model({
          id: s.int().id(),
          category: s.string(),
          amount: s.int(),
        })
        .map("s3_readings");
      const groupFields: "category"[] = ["category"];
      const args = {
        by: groupFields,
        _count: true,
        _sum: { amount: true },
        having: { amount: { _sum: { gte: 100 } } },
        orderBy: { category: "asc" },
      } as const;
      const readings = empty
        ? []
        : [
            { id: 1, category: "alpha", amount: 100 },
            { id: 2, category: "alpha", amount: 50 },
            { id: 3, category: "beta", amount: 200 },
            { id: 4, category: "excluded", amount: 99 },
          ];
      return {
        publicInput: { model: "reading", operation: "groupBy", args },
        requiredCuts: [],
        seed(database) {
          database.exec(
            "CREATE TABLE s3_readings (id INTEGER PRIMARY KEY, category TEXT NOT NULL, amount INTEGER NOT NULL)"
          );
          const insert = database.prepare(
            "INSERT INTO s3_readings VALUES (?,?,?)"
          );
          for (const reading of readings)
            insert.run(reading.id, reading.category, reading.amount);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return await candidateFactory({
              schema: { reading },
              driver,
            }).execute("reading", "groupBy", args);
          return await createClient({
            schema: { reading },
            driver,
          }).reading.groupBy(args);
        },
        inspect(database) {
          return {
            readings: database
              .prepare("SELECT id,category,amount FROM s3_readings ORDER BY id")
              .all(),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.initial, { readings });
          assert.deepEqual(observation.final, { readings });
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: empty
              ? []
              : [
                  { category: "alpha", _count: 2, _sum: { amount: 150 } },
                  { category: "beta", _count: 1, _sum: { amount: 200 } },
                ],
          });
        },
      };
    },
  };
}

export const groupedScenarios = [grouped(false), grouped(true)];
