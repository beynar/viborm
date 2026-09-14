import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
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
        },
        assert(observation) {
          requireSuccess(observation, { count: 2 });
          assert.equal(firstWriteAdmissions, 3);
          assert.deepEqual(admissions, ["audit-0", "audit-1", "audit-2"]);
          assert.deepEqual(observation.final, {
            nodes: [
              { id: 1, label: "touched", parentId: 2 },
              { id: 2, label: "seen", parentId: null },
            ],
            audits: [
              { id: "audit-1", note: "admitted", nodeId: 1 },
              { id: "audit-2", note: "admitted", nodeId: 2 },
            ],
          });
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
          const firstCapture = phases.indexOf("capture:n1");
          const firstAdmission = phases.indexOf("admit:n1");
          const targetEffect = phases.indexOf("effect:target-create");
          const laterCapture = phases.indexOf("capture:n2");
          const laterAdmission = phases.indexOf("admit:n2");
          assert.equal(firstCapture >= 0, true);
          assert.equal(firstAdmission >= 0, true);
          assert.equal(targetEffect >= 0, true);
          assert.equal(laterCapture >= 0, true);
          assert.equal(laterAdmission >= 0, true);
          assert.equal(firstCapture < firstAdmission, true);
          assert.equal(firstAdmission < targetEffect, true);
          assert.equal(targetEffect < laterCapture, true);
          assert.equal(laterCapture < laterAdmission, true);
        },
      };
    },
  };
}

function surroundingReadScenario(): ScenarioDefinition {
  return {
    id: "cs03-peer-scope-surrounding",
    family: "C08",
    contracts: ["C07", "C08", "C10", "C13"],
    sources: ["tests/raptor3/post-prep/g29-member-dependency.test.ts"],
    prepare(controls) {
      let selectedNode: string | undefined;
      let selectedCheck: string | undefined;
      const admissions: string[] = [];
      const phases: string[] = [];
      const container = s
        .model({
          id: s.string().id(),
          groups: s.toMany(() => group),
          probes: s.toMany(() => probe),
        })
        .map("cs03_scope_containers");
      const group = s
        .model({
          id: s.string().id(),
          containerId: s.string(),
          container: s
            .toOne(() => container)
            .fields("containerId")
            .references("id"),
          nodes: s.toMany(() => node),
        })
        .map("cs03_scope_groups");
      const node = s
        .model({
          id: s.string().id(),
          label: s.string(),
          groupId: s.string(),
          group: s
            .toOne(() => group)
            .fields("groupId")
            .references("id"),
          artifacts: s.toMany(() => artifact).name("cs03ScopeOwnedArtifacts"),
        })
        .map("cs03_scope_surrounding_nodes");
      const probe = s
        .model({
          id: s.string().id(),
          containerId: s.string(),
          container: s
            .toOne(() => container)
            .fields("containerId")
            .references("id"),
          checks: s.toMany(() => check),
        })
        .map("cs03_scope_probes");
      const check = s
        .model({
          id: s.string().id(),
          probeId: s.string(),
          probe: s
            .toOne(() => probe)
            .fields("probeId")
            .references("id"),
          artifacts: s.toMany(() => artifact).name("cs03ScopeWatchedArtifacts"),
        })
        .map("cs03_scope_checks");
      let artifactId = 0;
      const artifact = s
        .model({
          id: s
            .string()
            .id()
            .default(() => {
              const value = `artifact-${artifactId++}`;
              controls.recordDefault("artifact.id", value);
              return value;
            }),
          lookup: s
            .string()
            .schema(
              v.string({
                transform(input) {
                  const value =
                    input === "writer"
                      ? selectedNode === "n2"
                        ? "shared"
                        : selectedNode === "n1"
                          ? "safe"
                          : "template-write"
                      : selectedCheck === undefined
                        ? "template-read"
                        : "shared";
                  admissions.push(`${input}:${value}`);
                  phases.push(
                    `admit:${input}:${value}:${
                      (input === "writer" ? selectedNode : selectedCheck) ??
                      "template"
                    }`
                  );
                  controls.recordDefault(`artifact.lookup.${input}`, value);
                  return value;
                },
              })
            )
            .unique(),
          text: s.string(),
          nodeId: s.string(),
          node: s
            .toOne(() => node)
            .fields("nodeId")
            .references("id")
            .name("cs03ScopeOwnedArtifacts"),
          checkId: s.string(),
          check: s
            .toOne(() => check)
            .fields("checkId")
            .references("id")
            .name("cs03ScopeWatchedArtifacts"),
        })
        .map("cs03_scope_artifacts");
      const args = {
        where: { id: "root" },
        data: {
          groups: {
            updateMany: {
              where: {},
              data: {
                nodes: {
                  updateMany: {
                    where: {},
                    data: {
                      artifacts: {
                        create: {
                          lookup: "writer",
                          text: "expanded-write",
                          checkId: "c1",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          probes: {
            updateMany: {
              where: {},
              data: {
                checks: {
                  updateMany: {
                    where: {},
                    data: {
                      artifacts: {
                        update: {
                          where: { lookup: "reader" },
                          data: { text: "must-not-run" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };
      let forbiddenWrite = false;
      return {
        publicInput: { model: "container", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE cs03_scope_containers (id TEXT PRIMARY KEY);
            CREATE TABLE cs03_scope_groups (
              id TEXT PRIMARY KEY,
              containerId TEXT NOT NULL REFERENCES cs03_scope_containers(id)
            );
            CREATE TABLE cs03_scope_surrounding_nodes (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              groupId TEXT NOT NULL REFERENCES cs03_scope_groups(id)
            );
            CREATE TABLE cs03_scope_probes (
              id TEXT PRIMARY KEY,
              containerId TEXT NOT NULL REFERENCES cs03_scope_containers(id)
            );
            CREATE TABLE cs03_scope_checks (
              id TEXT PRIMARY KEY,
              probeId TEXT NOT NULL REFERENCES cs03_scope_probes(id)
            );
            CREATE TABLE cs03_scope_artifacts (
              id TEXT PRIMARY KEY,
              lookup TEXT NOT NULL UNIQUE,
              text TEXT NOT NULL,
              nodeId TEXT NOT NULL REFERENCES cs03_scope_surrounding_nodes(id),
              checkId TEXT NOT NULL REFERENCES cs03_scope_checks(id)
            );
            INSERT INTO cs03_scope_containers VALUES('root');
            INSERT INTO cs03_scope_groups VALUES('g1','root'),('g2','root');
            INSERT INTO cs03_scope_surrounding_nodes VALUES
              ('n1','initial','g1'),('n2','initial','g2');
            INSERT INTO cs03_scope_probes VALUES('p1','root');
            INSERT INTO cs03_scope_checks VALUES('c1','p1');
          `);
        },
        async invoke(driver, candidateFactory) {
          assert(candidateFactory);
          return await candidateFactory({
            schema: { container, group, node, probe, check, artifact },
            driver,
          }).execute("container", "update", args);
        },
        inspect(database) {
          return {
            artifacts: database
              .prepare(
                "SELECT lookup,text,nodeId,checkId FROM cs03_scope_artifacts ORDER BY lookup"
              )
              .all(),
          };
        },
        afterStatement(_database, completion) {
          for (const row of completion.rows) {
            if (!isRecord(row) || typeof row.id !== "string") continue;
            if (row.id === "g1" || row.id === "g2") selectedNode = undefined;
            if (row.id === "n1" || row.id === "n2") {
              selectedNode = row.id;
              phases.push(`capture:${row.id}`);
            }
            if (row.id === "c1") {
              selectedCheck = row.id;
              phases.push(`capture:${row.id}`);
            }
          }
          if (
            isWrite(completion) &&
            completion.sql.includes("cs03_scope_artifacts") &&
            completion.parameters.includes("expanded-write")
          )
            phases.push("effect:writer");
          if (
            isWrite(completion) &&
            completion.sql.includes("cs03_scope_artifacts") &&
            completion.parameters.includes("must-not-run")
          )
            forbiddenWrite = true;
        },
        assert(observation) {
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind === "failure") {
            assert.equal(observation.outcome.failure.name, "NestedWriteError");
            assert.equal(observation.outcome.failure.code, "V7001");
            assert.equal(isRecord(observation.outcome.failure.meta), true);
            if (isRecord(observation.outcome.failure.meta)) {
              assert.equal(
                observation.outcome.failure.meta.relation,
                "artifacts"
              );
              assert.equal(
                observation.outcome.failure.meta.operation,
                "update"
              );
              assert.equal(
                observation.outcome.failure.meta.conflictsWith,
                "create"
              );
            }
          }
          assert.equal(admissions[0], "writer:template-write");
          assert.equal(admissions.includes("reader:template-read"), true);
          assert.equal(admissions.includes("writer:shared"), true);
          assert.equal(admissions.includes("reader:shared"), true);
          const nestedCapture = phases.indexOf("capture:n2");
          const nestedWriteAdmission = phases.indexOf("admit:writer:shared:n2");
          const nestedWriteEffect = phases.lastIndexOf("effect:writer");
          const surroundingCapture = phases.indexOf("capture:c1");
          const surroundingReadAdmission = phases.indexOf(
            "admit:reader:shared:c1"
          );
          assert.equal(nestedCapture >= 0, true);
          assert.equal(nestedWriteAdmission >= 0, true);
          assert.equal(nestedWriteEffect >= 0, true);
          assert.equal(surroundingCapture >= 0, true);
          assert.equal(surroundingReadAdmission >= 0, true);
          assert.equal(nestedCapture < nestedWriteAdmission, true);
          assert.equal(
            nestedWriteAdmission < nestedWriteEffect,
            true,
            phases.join(" -> ")
          );
          assert.equal(
            nestedWriteEffect < surroundingReadAdmission,
            true,
            phases.join(" -> ")
          );
          assert.equal(surroundingCapture < surroundingReadAdmission, true);
          assert.equal(forbiddenWrite, false);
          if (controls.profile === "sqlite-interactive")
            assert.deepEqual(observation.final, observation.initial);
          else
            assert.deepEqual(observation.final.artifacts, [
              {
                lookup: "safe",
                text: "expanded-write",
                nodeId: "n1",
                checkId: "c1",
              },
              {
                lookup: "shared",
                text: "expanded-write",
                nodeId: "n2",
                checkId: "c1",
              },
            ]);
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
  surroundingReadScenario(),
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
          candidateFactory: createCommandEngine,
          candidateName: "commands",
        });
        world.fixture.assert(world.observation);
      });
    }
  });
}
