// biome-ignore-all lint/suspicious/noMisplacedAssertion: Scenario protocol assertions execute through runSQLiteWorld inside the test runner.

import assert from "node:assert/strict";
import { s } from "@schema";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { v } from "@validation";
import { isRecord } from "@validation/value-guards";
import { describe, it } from "vitest";
import type {
  RunObservation,
  ScenarioDefinition,
  StatementCompletion,
} from "../harness/protocol";
import { runSQLiteWorld } from "../harness/sqlite-world";
import type { ProfileId } from "../profiles";

const WRITE_STATEMENT = /^(?:INSERT|UPDATE|DELETE)\b/i;

function isWrite(completion: StatementCompletion): boolean {
  return WRITE_STATEMENT.test(completion.sql.trim());
}

function requireSuccess(observation: RunObservation, value: unknown): void {
  assert.deepEqual(observation.outcome, { kind: "success", value });
}

function rootPeerScenario(): ScenarioDefinition {
  return {
    id: "cs03-peer-scope-root",
    family: "C08",
    contracts: ["C07", "C08", "C10", "C13"],
    sources: ["tests/raptor3/core-structure/extension-a.contract.test.ts"],
    prepare(controls) {
      const admissions: string[] = [];
      let firstWriteAdmissions: number | undefined;
      const node = s
        .model({
          id: s.int().id(),
          label: s.string(),
          parentId: s.int().nullable(),
          parent: s
            .toOne(() => node)
            .fields("parentId")
            .references("id")
            .name("cs03ScopeTree"),
          children: s.toMany(() => node).name("cs03ScopeTree"),
          audits: s.toMany(() => audit),
        })
        .map("cs03_scope_nodes");
      let auditId = 0;
      const audit = s
        .model({
          id: s
            .string()
            .id()
            .default(() => {
              const value = `audit-${auditId++}`;
              admissions.push(value);
              controls.recordDefault("audit.id", value);
              return value;
            }),
          note: s.string(),
          nodeId: s.int(),
          node: s
            .toOne(() => node)
            .fields("nodeId")
            .references("id"),
        })
        .map("cs03_scope_audits");
      const args = {
        where: { id: { in: [1, 2] } },
        data: {
          label: "seen",
          children: { updateMany: { where: {}, data: { label: "touched" } } },
          audits: { create: { note: "admitted" } },
        },
      };
      return {
        publicInput: { model: "node", operation: "updateMany", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE cs03_scope_nodes (
              id INTEGER PRIMARY KEY,
              label TEXT NOT NULL,
              parentId INTEGER REFERENCES cs03_scope_nodes(id)
            );
            CREATE TABLE cs03_scope_audits (
              id TEXT PRIMARY KEY,
              note TEXT NOT NULL,
              nodeId INTEGER NOT NULL REFERENCES cs03_scope_nodes(id)
            );
            INSERT INTO cs03_scope_nodes VALUES(1,'child',2),(2,'parent',NULL);
          `);
        },
        async invoke(driver, candidateFactory) {
          assert(candidateFactory);
          return await candidateFactory({
            schema: { node, audit },
            driver,
          }).execute("node", "updateMany", args);
        },
        inspect(database) {
          return {
            nodes: database
              .prepare(
                "SELECT id,label,parentId FROM cs03_scope_nodes ORDER BY id"
              )
              .all(),
            audits: database
              .prepare(
                "SELECT id,note,nodeId FROM cs03_scope_audits ORDER BY id"
              )
              .all(),
          };
        },
        afterStatement(_database, completion) {
          if (firstWriteAdmissions === undefined && isWrite(completion))
            firstWriteAdmissions = admissions.length;
          return undefined;
        },
        assert(observation) {
          requireSuccess(observation, { count: 2 });
          // Every default is admitted before the first write, and each
          // member's row takes its own: no two share one admission.
          assert.equal(firstWriteAdmissions, admissions.length);
          const { nodes, audits } = observation.final as {
            nodes: unknown;
            audits: { id: string; note: string; nodeId: number }[];
          };
          assert.deepEqual(nodes, [
            { id: 1, label: "touched", parentId: 2 },
            { id: 2, label: "seen", parentId: null },
          ]);
          assert.deepEqual(
            audits.map(({ note, nodeId }) => ({ note, nodeId })),
            [
              { note: "admitted", nodeId: 1 },
              { note: "admitted", nodeId: 2 },
            ]
          );
          assert.equal(new Set(audits.map((audit) => audit.id)).size, 2);
          for (const audit of audits)
            assert.equal(admissions.includes(audit.id), true);
        },
      };
    },
  };
}

function nestedPeerScenario(): ScenarioDefinition {
  return {
    id: "cs03-peer-scope-nested",
    family: "C08",
    contracts: ["C07", "C08", "C10", "C13"],
    sources: ["tests/raptor3/post-prep/g29-member-dependency.test.ts"],
    prepare(controls) {
      let selectedNode: string | undefined;
      const phases: string[] = [];
      const shelf = s
        .model({
          id: s.string().id(),
          nodes: s.toMany(() => node),
        })
        .map("cs03_scope_shelves");
      const node = s
        .model({
          id: s.string().id(),
          shelfId: s.string(),
          shelf: s
            .toOne(() => shelf)
            .fields("shelfId")
            .references("id"),
          targetId: s.int().nullable(),
          target: s
            .toOne(() => target)
            .fields("targetId")
            .references("id"),
        })
        .map("cs03_scope_nested_nodes");
      const target = s
        .model({
          id: s.int().id().increment(),
          name: s
            .string()
            .schema(
              v.string({
                transform(input) {
                  const scope = selectedNode ?? "template";
                  phases.push(`admit:${scope}`);
                  controls.recordDefault("target.name.scope", scope);
                  return input;
                },
              })
            )
            .unique(),
          nodes: s.toMany(() => node),
        })
        .map("cs03_scope_targets");
      const args = {
        where: { id: { in: ["s1", "s2"] } },
        data: {
          nodes: {
            updateMany: {
              where: {},
              data: {
                target: {
                  connectOrCreate: {
                    where: { name: "shared" },
                    create: { name: "shared" },
                  },
                },
              },
            },
          },
        },
      };
      return {
        publicInput: { model: "shelf", operation: "updateMany", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE cs03_scope_shelves (id TEXT PRIMARY KEY);
            CREATE TABLE cs03_scope_targets (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE cs03_scope_nested_nodes (
              id TEXT PRIMARY KEY,
              shelfId TEXT NOT NULL REFERENCES cs03_scope_shelves(id),
              targetId INTEGER REFERENCES cs03_scope_targets(id)
            );
            INSERT INTO cs03_scope_shelves VALUES('s1'),('s2');
            INSERT INTO cs03_scope_nested_nodes VALUES('n1','s1',NULL),('n2','s2',NULL);
          `);
        },
        async invoke(driver, candidateFactory) {
          assert(candidateFactory);
          return await candidateFactory({
            schema: { shelf, node, target },
            driver,
          }).execute("shelf", "updateMany", args);
        },
        inspect(database) {
          return {
            targets: database
              .prepare("SELECT id,name FROM cs03_scope_targets ORDER BY id")
              .all(),
            nodes: database
              .prepare(
                "SELECT id,shelfId,targetId FROM cs03_scope_nested_nodes ORDER BY id"
              )
              .all(),
          };
        },
        afterStatement(_database, completion) {
          for (const row of completion.rows) {
            if (!isRecord(row) || (row.id !== "n1" && row.id !== "n2"))
              continue;
            selectedNode = row.id;
            phases.push(`capture:${row.id}`);
          }
          if (
            isWrite(completion) &&
            completion.sql.includes("cs03_scope_targets")
          )
            phases.push("effect:target-create");
          return undefined;
        },
        assert(observation) {
          requireSuccess(observation, { count: 2 });
          assert.deepEqual(observation.final, {
            targets: [{ id: 1, name: "shared" }],
            nodes: [
              { id: "n1", shelfId: "s1", targetId: 1 },
              { id: "n2", shelfId: "s2", targetId: 1 },
            ],
          });
          // One target is created, once, and both members reach it.
          assert.equal(
            phases.filter((phase) => phase === "effect:target-create").length,
            1
          );
        },
      };
    },
  };
}

function staticPeerScenario(): ScenarioDefinition {
  return {
    id: "cs03-peer-scope-static",
    family: "C08",
    contracts: ["C04", "C07", "C08", "C10", "C13"],
    sources: [
      "tests/contracts/engine/write/create-many-relation-series-behavior.ts",
    ],
    prepare() {
      const board = s
        .model({
          id: s.string().id(),
          posts: s.toMany(() => post),
        })
        .map("cs03_scope_boards");
      const author = s
        .model({
          id: s.int().id().increment(),
          name: s.string().unique(),
          posts: s.toMany(() => post),
        })
        .map("cs03_scope_authors");
      const post = s
        .model({
          id: s.int().id(),
          title: s.string(),
          boardId: s.string(),
          board: s
            .toOne(() => board)
            .fields("boardId")
            .references("id"),
          authorId: s.int(),
          author: s
            .toOne(() => author)
            .fields("authorId")
            .references("id"),
        })
        .map("cs03_scope_posts");
      const args = {
        where: { id: "board" },
        data: {
          posts: {
            createMany: {
              data: [
                {
                  id: 1,
                  title: "first",
                  author: { create: { name: "shared" } },
                },
                {
                  id: 2,
                  title: "second",
                  author: {
                    connectOrCreate: {
                      where: { name: "shared" },
                      create: { name: "shared" },
                    },
                  },
                },
              ],
            },
          },
        },
      };
      return {
        publicInput: { model: "board", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE cs03_scope_boards (id TEXT PRIMARY KEY);
            CREATE TABLE cs03_scope_authors (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE cs03_scope_posts (
              id INTEGER PRIMARY KEY,
              title TEXT NOT NULL,
              boardId TEXT NOT NULL REFERENCES cs03_scope_boards(id),
              authorId INTEGER NOT NULL REFERENCES cs03_scope_authors(id)
            );
            INSERT INTO cs03_scope_boards VALUES('board');
          `);
        },
        async invoke(driver, candidateFactory) {
          assert(candidateFactory);
          return await candidateFactory({
            schema: { board, author, post },
            driver,
          }).execute("board", "update", args);
        },
        inspect(database) {
          return {
            authors: database
              .prepare("SELECT id,name FROM cs03_scope_authors ORDER BY id")
              .all(),
            posts: database
              .prepare(
                "SELECT id,title,boardId,authorId FROM cs03_scope_posts ORDER BY id"
              )
              .all(),
          };
        },
        assert(observation) {
          requireSuccess(observation, { id: "board" });
          assert.deepEqual(observation.final, {
            authors: [{ id: 1, name: "shared" }],
            posts: [
              {
                id: 1,
                title: "first",
                boardId: "board",
                authorId: 1,
              },
              {
                id: 2,
                title: "second",
                boardId: "board",
                authorId: 1,
              },
            ],
          });
        },
      };
    },
  };
}

const scenarios = [
  rootPeerScenario(),
  nestedPeerScenario(),
  staticPeerScenario(),
];

for (const profile of [
  "sqlite-interactive",
  "sqlite-atomic-batch",
] as const satisfies readonly ProfileId[]) {
  describe(`CS-03 peer member scope (${profile})`, () => {
    for (const scenario of scenarios) {
      it(scenario.id, async () => {
        const world = await runSQLiteWorld(scenario, profile, 0, {
          candidateFactory: createTestCommandEngine,
          candidateName: "commands",
        });
        world.fixture.assert(world.observation);
      });
    }
  });
}
