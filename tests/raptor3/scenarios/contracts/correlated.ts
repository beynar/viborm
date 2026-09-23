import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../../harness/protocol";

function correlated(sharedFirst: boolean): ScenarioDefinition {
  return {
    id: sharedFirst ? "s4-shared-occurrences" : "s4-parent-pages",
    family: "S4",
    contracts: ["C01", "C12"],
    sources: [
      "tests/contracts/drivers/behaviors/nested-pagination-behavior.ts",
    ],
    prepare() {
      const parent = s
        .model({
          id: s.int().id(),
          targets: s
            .toMany(() => target)
            .through("s4_memberships")
            .source("parentId")
            .target("targetId"),
        })
        .map("s4_parents");
      const target = s
        .model({
          id: s.int().id(),
          label: s.string(),
          parents: s.toMany(() => parent),
        })
        .map("s4_targets");
      const parentIds = [1, 2];
      const args = {
        where: { id: { in: parentIds } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          targets: {
            orderBy: { id: "asc" },
            take: 1,
            select: { id: true, label: true },
          },
        },
      } as const;
      const initial = {
        parents: [{ id: 1 }, { id: 2 }, { id: 3 }],
        targets: [
          { id: 1, label: "one" },
          { id: 2, label: "shared" },
          { id: 3, label: "three" },
          { id: 4, label: "decoy" },
        ],
        memberships: sharedFirst
          ? [
              { parentId: 1, targetId: 2 },
              { parentId: 1, targetId: 3 },
              { parentId: 2, targetId: 2 },
              { parentId: 2, targetId: 4 },
              { parentId: 3, targetId: 1 },
            ]
          : [
              { parentId: 1, targetId: 1 },
              { parentId: 1, targetId: 2 },
              { parentId: 2, targetId: 2 },
              { parentId: 2, targetId: 3 },
              { parentId: 3, targetId: 4 },
            ],
      };
      return {
        publicInput: { model: "parent", operation: "findMany", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE s4_parents (id INTEGER PRIMARY KEY);
            CREATE TABLE s4_targets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
            CREATE TABLE s4_memberships (parentId INTEGER NOT NULL REFERENCES s4_parents(id), targetId INTEGER NOT NULL REFERENCES s4_targets(id), PRIMARY KEY(parentId,targetId));
            INSERT INTO s4_parents VALUES (1),(2),(3);
            INSERT INTO s4_targets VALUES (1,'one'),(2,'shared'),(3,'three'),(4,'decoy');
          `);
          const insert = database.prepare(
            "INSERT INTO s4_memberships VALUES (?,?)"
          );
          for (const membership of initial.memberships)
            insert.run(membership.parentId, membership.targetId);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return await candidateFactory({
              schema: { parent, target },
              driver,
            }).execute("parent", "findMany", args);
          return await createClient({
            schema: { parent, target },
            driver,
          }).parent.findMany(args);
        },
        inspect(database) {
          return {
            parents: database
              .prepare("SELECT id FROM s4_parents ORDER BY id")
              .all(),
            targets: database
              .prepare("SELECT id,label FROM s4_targets ORDER BY id")
              .all(),
            memberships: database
              .prepare(
                "SELECT parentId,targetId FROM s4_memberships ORDER BY parentId,targetId"
              )
              .all(),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, initial);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: [
              {
                id: 1,
                targets: [
                  sharedFirst
                    ? { id: 2, label: "shared" }
                    : { id: 1, label: "one" },
                ],
              },
              { id: 2, targets: [{ id: 2, label: "shared" }] },
            ],
          });
        },
      };
    },
  };
}

export const correlatedScenarios = [correlated(false), correlated(true)];
