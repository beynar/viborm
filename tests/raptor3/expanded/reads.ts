import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const cases = [
  ["g1-read-unique-found", 1],
  ["g1-read-unique-missing", 99],
  ["g1-read-null-empty", 3],
] as const;

export const readScenarios: ScenarioDefinition[] = cases.map(
  ([id, selectedId]) => ({
    id,
    family: "C01",
    contracts: ["C01"],
    sources: [
      "tests/contracts/engine/query/result-parser-contracts.core.test.ts",
      "tests/contracts/engine/query/read-traversal-byte-pins.core.test.ts",
    ],
    prepare() {
      const entry = s
        .model({
          id: s.int().id(),
          label: s.string().map("display_label"),
          parentId: s.int().nullable().map("parent_id"),
          parent: s
            .toOne(() => entry)
            .fields("parentId")
            .references("id")
            .name("tree"),
          children: s.toMany(() => entry).name("tree"),
        })
        .map("g1_entries");
      const args = {
        where: { id: selectedId },
        select: {
          id: true,
          label: true,
          parent: { select: { id: true, label: true } },
          children: {
            orderBy: { id: "asc" },
            select: {
              id: true,
              label: true,
              parent: { select: { id: true, label: true } },
            },
          },
        },
      } as const;
      const initial = {
        entries: [
          { id: 1, display_label: "root", parent_id: null },
          { id: 2, display_label: "child", parent_id: 1 },
          { id: 3, display_label: "empty", parent_id: null },
          { id: 4, display_label: "decoy", parent_id: 2 },
        ],
      };
      const value =
        selectedId === 99
          ? null
          : selectedId === 3
            ? {
                id: 3,
                label: "empty",
                parent: null,
                children: [],
              }
            : {
                id: 1,
                label: "root",
                parent: null,
                children: [
                  { id: 2, label: "child", parent: { id: 1, label: "root" } },
                ],
              };
      return {
        publicInput: { model: "entry", operation: "findUnique", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g1_entries (id INTEGER PRIMARY KEY, display_label TEXT NOT NULL, parent_id INTEGER REFERENCES g1_entries(id));
          INSERT INTO g1_entries VALUES (1,'root',NULL),(2,'child',1),(3,'empty',NULL),(4,'decoy',2);
        `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema: { entry }, driver }).execute(
              "entry",
              "findUnique",
              args
            );
          return await createClient({
            schema: { entry },
            driver,
          }).entry.findUnique(args);
        },
        inspect(database) {
          return {
            entries: database
              .prepare("SELECT * FROM g1_entries ORDER BY id")
              .all(),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, initial);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          assert.deepEqual(observation.outcome, { kind: "success", value });
        },
      };
    },
  })
);
