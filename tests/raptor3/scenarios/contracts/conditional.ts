import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioId } from "../../contracts";
import type {
  FailureObservation,
  ScenarioDefinition,
  StateRows,
} from "../../harness/protocol";

function parentSchema() {
  const holder = s
    .model({
      id: s.int().id(),
      producerId: s.int(),
      producer: s
        .toOne(() => producer)
        .fields("producerId")
        .references("id"),
    })
    .map("s1_holders");
  const producer = s
    .model({
      id: s.int().id().increment(),
      tag: s.string().unique(),
      holders: s.toMany(() => holder),
      children: s.toMany(() => child),
      marks: s.toMany(() => mark),
    })
    .map("s1_producers");
  const child = s
    .model({
      id: s.string().id(),
      producerId: s.int(),
      producer: s
        .toOne(() => producer)
        .fields("producerId")
        .references("id"),
    })
    .map("s1_children");
  const mark = s
    .model({
      id: s.string().id(),
      producerTag: s.string(),
      producer: s
        .toOne(() => producer)
        .fields("producerTag")
        .references("tag"),
    })
    .map("s1_marks");
  return { holder, producer, child, mark };
}

function childSchema() {
  const holder = s
    .model({
      id: s.int().id(),
      producers: s.toMany(() => producer),
    })
    .map("s1_holders");
  const producer = s
    .model({
      id: s.int().id().increment(),
      tag: s.string().unique(),
      holderId: s.int(),
      holder: s
        .toOne(() => holder)
        .fields("holderId")
        .references("id"),
      children: s.toMany(() => child),
      marks: s.toMany(() => mark),
    })
    .map("s1_producers");
  const child = s
    .model({
      id: s.string().id(),
      producerId: s.int(),
      producer: s
        .toOne(() => producer)
        .fields("producerId")
        .references("id"),
    })
    .map("s1_children");
  const mark = s
    .model({
      id: s.string().id(),
      producerTag: s.string(),
      producer: s
        .toOne(() => producer)
        .fields("producerTag")
        .references("tag"),
    })
    .map("s1_marks");
  return { holder, producer, child, mark };
}

function inspect(database: Database.Database): StateRows {
  return {
    holders: database.prepare("SELECT * FROM s1_holders ORDER BY id").all(),
    producers: database.prepare("SELECT * FROM s1_producers ORDER BY id").all(),
    children: database.prepare("SELECT * FROM s1_children ORDER BY id").all(),
    marks: database.prepare("SELECT * FROM s1_marks ORDER BY id").all(),
    sequence: database
      .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name")
      .all(),
  };
}

function conditional(
  id: ScenarioId,
  orientation: "parent" | "child",
  world: "found" | "missing" | "rollback"
): ScenarioDefinition {
  return {
    id,
    family: "S1",
    contracts: ["C02", "C03", "C04", "C10"],
    sources: [
      "tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior.ts",
      "tests/contracts/engine/write/create-nested-upsert-behavior.ts",
      "tests/contracts/engine/write/parity-f-fresh-field.core.test.ts",
    ],
    prepare(controls) {
      const found = world === "found";
      const producerId = found ? 11 : 41;
      const producerTag = found ? "stored" : "admitted";
      const connectOrCreate = {
        where: { tag: "stored" },
        create: {
          tag: "admitted",
          children: {
            create: [
              { id: "new-a" },
              { id: world === "rollback" ? "decoy" : "new-b" },
            ],
          },
          marks: { create: { id: "new-mark" } },
        },
      };
      const producerSelect = {
        id: true,
        tag: true,
        children: {
          orderBy: { id: "asc" },
          select: { id: true, producerId: true },
        },
        marks: {
          orderBy: { id: "asc" },
          select: { id: true, producerTag: true },
        },
      } as const;
      const parentArgs = {
        data: { id: 1, producer: { connectOrCreate } },
        select: {
          id: true,
          producerId: true,
          producer: { select: producerSelect },
        },
      } as const;
      const childArgs = {
        data: { id: 1, producers: { connectOrCreate } },
        select: {
          id: true,
          producers: { select: producerSelect, orderBy: { id: "asc" } },
        },
      } as const;
      const parent = orientation === "parent" ? parentSchema() : undefined;
      const child = orientation === "child" ? childSchema() : undefined;
      const cut = `${id}-producer-written`;
      let producerCutReached = false;
      const oldChildren = [
        { id: "decoy", producerId: 7 },
        ...(found ? [{ id: "old-leaf", producerId: 11 }] : []),
      ];
      const oldMarks = [
        { id: "decoy-mark", producerTag: "decoy-tag" },
        ...(found ? [{ id: "old-mark", producerTag: "stored" }] : []),
      ];
      const oldHolders =
        orientation === "parent"
          ? [
              { id: 2, producerId: found ? 11 : 7 },
              { id: 3, producerId: 7 },
            ]
          : [{ id: 2 }, { id: 3 }];
      const oldProducers =
        orientation === "parent"
          ? [
              { id: 7, tag: "decoy-tag" },
              ...(found ? [{ id: 11, tag: "stored" }] : []),
            ]
          : [
              { id: 7, tag: "decoy-tag", holderId: 3 },
              ...(found ? [{ id: 11, tag: "stored", holderId: 2 }] : []),
            ];
      const initial = {
        holders: oldHolders,
        producers: oldProducers,
        children: oldChildren,
        marks: oldMarks,
        sequence: [{ name: "s1_producers", seq: 40 }],
      };
      return {
        publicInput: {
          model: "holder",
          operation: "create",
          args: orientation === "parent" ? parentArgs : childArgs,
        },
        requiredCuts: found ? [] : [cut],
        seed(database) {
          database.exec(
            orientation === "parent"
              ? `
            CREATE TABLE s1_producers (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL UNIQUE);
            CREATE TABLE s1_holders (id INTEGER PRIMARY KEY, producerId INTEGER NOT NULL REFERENCES s1_producers(id));
            INSERT INTO s1_producers (id,tag) VALUES (7,'decoy-tag');
          `
              : `
            CREATE TABLE s1_holders (id INTEGER PRIMARY KEY);
            CREATE TABLE s1_producers (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL UNIQUE, holderId INTEGER NOT NULL REFERENCES s1_holders(id));
            INSERT INTO s1_holders VALUES (2),(3);
            INSERT INTO s1_producers (id,tag,holderId) VALUES (7,'decoy-tag',3);
          `
          );
          database.exec(`
            CREATE TABLE s1_children (id TEXT PRIMARY KEY, producerId INTEGER NOT NULL REFERENCES s1_producers(id));
            CREATE TABLE s1_marks (id TEXT PRIMARY KEY, producerTag TEXT NOT NULL REFERENCES s1_producers(tag));
            INSERT INTO s1_children VALUES ('decoy',7);
            INSERT INTO s1_marks VALUES ('decoy-mark','decoy-tag');
          `);
          if (found) {
            database.exec(
              orientation === "parent"
                ? "INSERT INTO s1_producers (id,tag) VALUES (11,'stored')"
                : "INSERT INTO s1_producers (id,tag,holderId) VALUES (11,'stored',2)"
            );
            database.exec(
              "INSERT INTO s1_children VALUES ('old-leaf',11); INSERT INTO s1_marks VALUES ('old-mark','stored');"
            );
          }
          if (orientation === "parent") {
            database
              .prepare("INSERT INTO s1_holders VALUES (?,?)")
              .run(2, found ? 11 : 7);
            database.exec("INSERT INTO s1_holders VALUES (3,7)");
          }
          database.exec(
            "UPDATE sqlite_sequence SET seq=40 WHERE name='s1_producers'"
          );
        },
        async invoke(driver, candidateFactory) {
          if (parent) {
            if (candidateFactory)
              return await candidateFactory({ schema: parent, driver }).execute(
                "holder",
                "create",
                parentArgs
              );
            return await createClient({ schema: parent, driver }).holder.create(
              parentArgs
            );
          }
          assert(child);
          if (candidateFactory)
            return await candidateFactory({ schema: child, driver }).execute(
              "holder",
              "create",
              childArgs
            );
          return await createClient({ schema: child, driver }).holder.create(
            childArgs
          );
        },
        inspect,
        afterStatement(database, completion) {
          const writtenProducer =
            !found && !producerCutReached
              ? database
                  .prepare("SELECT id,tag FROM s1_producers WHERE id=41")
                  .get()
              : undefined;
          if (writtenProducer !== undefined) {
            assert.equal(
              completion.transactionOpen,
              true,
              "producer must be inside its real rollback region"
            );
            assert.deepEqual(writtenProducer, { id: 41, tag: "admitted" });
            producerCutReached = true;
            return cut;
          }
          return undefined;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.defaults, []);
          if (world === "rollback") {
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind !== "failure") return;
            const failure = observation.outcome.failure;
            if (controls.fault?.kind === "after-rollback") {
              const interactive = controls.profile === "sqlite-interactive";
              const redacted = {
                name: "Error",
                message: "Underlying error details redacted",
              };
              if (interactive) {
                assert.equal(failure.name, "AggregateError");
                assert.deepEqual(Object.keys(failure).sort(), [
                  "cause",
                  "errors",
                  "message",
                  "name",
                ]);
                const primary = failure.cause as FailureObservation;
                assert.equal(primary.name, "UniqueConstraintError");
                assert.equal(primary.code, "V3001");
                assert.equal(primary.message, "Unique constraint violation");
                assert.deepEqual(primary.cause, redacted);
                assert.equal(failure.message, primary.message);
                const cleanup = failure.errors?.[1] as FailureObservation;
                assert.equal(cleanup.name, "QueryError");
                assert.equal(cleanup.code, "V2001");
                assert.equal(cleanup.message, "Query execution failed");
                assert.deepEqual(cleanup.cause, redacted);
                assert.deepEqual(failure.errors, [primary, cleanup]);
                const correlationId = (primary.meta as Record<string, unknown>)
                  .correlationId;
                assert(
                  typeof correlationId === "string" && correlationId.length > 0
                );
                assert.deepEqual(
                  primary.meta,
                  Object.assign(Object.create(null), {
                    columns: ["s1_children.id"],
                    correlationId,
                    driver: "sqlite3",
                    model: "child",
                    operation: "create",
                  })
                );
                assert.deepEqual(
                  cleanup.meta,
                  Object.assign(Object.create(null), {
                    correlationId,
                    driver: "sqlite3",
                    model: "holder",
                    operation: "create",
                  })
                );
              } else {
                assert.equal(failure.name, "UniqueConstraintError");
                assert.equal(failure.code, "V3001");
                assert.equal(failure.message, "Unique constraint violation");
                // Native batch exposes the redacted lifecycle cause, not its cleanup array.
                assert.deepEqual(failure.cause, {
                  ...redacted,
                  cause: redacted,
                });
              }
            } else assert.equal(failure.code, "V3001");
            assert.deepEqual(
              observation.final,
              initial,
              "all writes and sequence changes must roll back"
            );
            return;
          }
          const children = found
            ? [{ id: "old-leaf", producerId: 11 }]
            : [
                { id: "new-a", producerId: 41 },
                { id: "new-b", producerId: 41 },
              ];
          const marks = [{ id: found ? "old-mark" : "new-mark", producerTag }];
          const projectedProducer = {
            id: producerId,
            tag: producerTag,
            children,
            marks,
          };
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value:
              orientation === "parent"
                ? { id: 1, producerId, producer: projectedProducer }
                : { id: 1, producers: [projectedProducer] },
          });
          assert.deepEqual(observation.final, {
            holders: [
              orientation === "parent" ? { id: 1, producerId } : { id: 1 },
              ...oldHolders,
            ],
            producers:
              orientation === "parent"
                ? [
                    ...oldProducers,
                    ...(found ? [] : [{ id: 41, tag: "admitted" }]),
                  ]
                : [
                    { id: 7, tag: "decoy-tag", holderId: 3 },
                    { id: producerId, tag: producerTag, holderId: 1 },
                  ],
            children: [{ id: "decoy", producerId: 7 }, ...children],
            marks: [{ id: "decoy-mark", producerTag: "decoy-tag" }, ...marks],
            sequence: [{ name: "s1_producers", seq: found ? 40 : 41 }],
          });
        },
      };
    },
  };
}

export const conditionalScenarios = [
  conditional("s1-parent-found", "parent", "found"),
  conditional("s1-parent-missing", "parent", "missing"),
  conditional("s1-parent-rollback", "parent", "rollback"),
  conditional("s1-child-found", "child", "found"),
  conditional("s1-child-missing", "child", "missing"),
  conditional("s1-child-rollback", "child", "rollback"),
];
