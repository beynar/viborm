import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { isRecord } from "@validation/value-guards";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

export const upsertMembershipScenario: ScenarioDefinition = {
  id: "g25-nested-upsert-member-lost",
  family: "C05",
  contracts: ["C02", "C05", "C06"],
  sources: [
    "tests/contracts/engine/write/update-nested-upsert-behavior.ts",
    "tests/raptor3/transitions/series-staleness.ts",
  ],
  prepare(controls) {
    assert.equal(controls.profile, "sqlite-atomic-batch");
    const parent = s
      .model({
        id: s.int().id(),
        label: s.string(),
        children: s.toMany(() => child),
      })
      .map("g25_upsert_parents");
    const child = s
      .model({
        id: s.int().id(),
        slug: s.string().unique(),
        label: s.string(),
        parentId: s.int().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentId")
          .references("id"),
      })
      .map("g25_upsert_children");
    const schema = { parent, child };
    const args = {
      where: { id: 1 },
      data: {
        children: {
          upsert: {
            where: { slug: "selected" },
            create: { id: 30, slug: "unused", label: "must not create" },
            update: { label: "must not update" },
          },
        },
      },
      select: { id: true, label: true },
    } as const;
    const initial = {
      parents: [
        { id: 1, label: "selected parent" },
        { id: 9, label: "other parent" },
      ],
      children: [
        { id: 10, slug: "selected", label: "unchanged", parentId: 1 },
        { id: 90, slug: "decoy", label: "other child", parentId: 9 },
      ],
    };
    const final = {
      ...initial,
      children: [{ ...initial.children[0], parentId: 9 }, initial.children[1]],
    };
    const inspect = (database: Database.Database) => ({
      parents: database
        .prepare("SELECT * FROM g25_upsert_parents ORDER BY id")
        .all(),
      children: database
        .prepare("SELECT * FROM g25_upsert_children ORDER BY id")
        .all(),
    });
    let memberCaptured = false;
    let detached = false;
    let detachRecorded = false;
    return {
      publicInput: {
        model: "parent",
        operation: "update",
        args,
        externalMutation: {
          after:
            "selected child and original membership observed, before next native BEGIN",
          reparent: { child: 10, from: 1, to: 9 },
        },
      },
      requiredCuts: ["nested-upsert-member-detached-before-atomic-use"],
      seed(database) {
        database.exec(`
          CREATE TABLE g25_upsert_parents(id INTEGER PRIMARY KEY,label TEXT NOT NULL);
          CREATE TABLE g25_upsert_children(id INTEGER PRIMARY KEY,slug TEXT NOT NULL UNIQUE,label TEXT NOT NULL,parentId INTEGER REFERENCES g25_upsert_parents(id));
          INSERT INTO g25_upsert_parents VALUES(1,'selected parent'),(9,'other parent');
          INSERT INTO g25_upsert_children VALUES(10,'selected','unchanged',1),(90,'decoy','other child',9);
        `);
        // The fixture's peer acts at the native transaction boundary, after all
        // planning observations and before BEGIN makes its effect atomic.
        const execute = database.exec;
        database.exec = function (sql) {
          if (
            !detached &&
            memberCaptured &&
            sql.trim().toUpperCase() === "BEGIN"
          ) {
            assert.equal(database.inTransaction, false);
            assert.deepEqual(inspect(database), initial);
            const reparented = database
              .prepare(
                "UPDATE g25_upsert_children SET parentId=9 WHERE id=10 AND parentId=1"
              )
              .run();
            assert.equal(reparented.changes, 1);
            detached = true;
            assert.deepEqual(inspect(database), final);
          }
          return execute.call(this, sql);
        };
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "parent",
            "update",
            args
          );
        return createClient({ schema, driver }).parent.update(args);
      },
      inspect,
      afterStatement(database, completion) {
        if (detached) {
          assert.deepEqual(
            inspect(database),
            final,
            "A globally selected child that lost membership must not be modified or adopted"
          );
        } else if (
          completion.parameters.includes("selected") &&
          completion.rows.some(
            (row) => isRecord(row) && row.id === 10n && row.parentId === 1n
          )
        )
          memberCaptured = true;
        return undefined;
      },
      afterTransaction(database, phase) {
        if (detached && !detachRecorded && phase === "begin") {
          assert.equal(database.inTransaction, true);
          detachRecorded = true;
          return "nested-upsert-member-detached-before-atomic-use";
        }
        return undefined;
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, final);
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, [
          "nested-upsert-member-detached-before-atomic-use",
        ]);
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        assert.equal(observation.outcome.failure.name, "NestedWriteError");
        assert.equal(observation.outcome.failure.code, "V7001");
        // Preserve the measured private G2 diagnostic at this atomic-use cut.
        assert.equal(
          observation.outcome.failure.message,
          "Cannot upsert relation 'children': target record was not found for this parent."
        );
        assert(isRecord(observation.outcome.failure.meta));
        assert.notEqual(observation.outcome.failure.meta.raceable, true);
      },
    };
  },
};
