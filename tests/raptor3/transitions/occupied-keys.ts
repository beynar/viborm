import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { StateRows } from "../harness/protocol";
import type { KeyScenario } from "./keys";

const cases = [
  "g2-nested-key-occupied-move-refused",
  "g2-nested-key-occupied-set-same",
  "g2-nested-key-occupied-increment-zero",
  "g2-nested-key-occupied-cascade",
] as const;

/** A selected nested source, its occupied reference, and an incoming free row. */
export const occupiedKeyScenarios: KeyScenario[] = cases.map((id) => ({
  id,
  family: "C05",
  contracts: ["C05", "C06"],
  sources: [
    "tests/contracts/engine/write/nested-update-pk-transition-cascade-occupied.test.ts",
    "tests/contracts/engine/write/nested-update-pk-transition-cascade-fixtures.ts",
    "tests/contracts/engine/query/relation-key-update-legality-transition-arm.test.ts",
  ],
  prepare() {
    const cascade = id === "g2-nested-key-occupied-cascade";
    const refused = id === "g2-nested-key-occupied-move-refused";
    const moves = cascade || refused;
    const owner = s
      .model({
        id: s.int().id(),
        label: s.string(),
        branches: s.toMany(() => branch),
      })
      .map("g2_occupied_owners");
    const branch = s
      .model({
        id: s.int().id(),
        label: s.string().unique(),
        ownerId: s.int(),
        owner: s
          .toOne(() => owner)
          .fields("ownerId")
          .references("id"),
        leaves: s.toMany(() => leaf),
      })
      .map("g2_occupied_branches");
    const leaf = s
      .model({
        id: s.int().id(),
        label: s.string(),
        branchId: s.int().nullable(),
        branch: cascade
          ? s
              .toOne(() => branch)
              .fields("branchId")
              .references("id")
              .onUpdate("cascade")
          : s
              .toOne(() => branch)
              .fields("branchId")
              .references("id"),
      })
      .map("g2_occupied_leaves");
    const schema = { owner, branch, leaf };
    const operand = moves
      ? 7
      : id === "g2-nested-key-occupied-set-same"
        ? { set: 1 }
        : { increment: 0 };
    const args = {
      where: { id: 10 },
      data: {
        branches: {
          update: {
            // The public unique selector pins the before-value. The legacy
            // contract does not promise the same no-op verdict for label-only lookup.
            where: { id: 1 },
            data: { id: operand, leaves: { connect: { id: 5 } } },
          },
        },
      },
      select: {
        id: true,
        label: true,
        branches: {
          orderBy: { id: "asc" },
          select: { id: true, label: true, ownerId: true },
        },
      },
    } as const;
    const initial = {
      owners: [
        { id: 10, label: "owner-a" },
        { id: 20, label: "owner-b" },
      ],
      branches: [
        { id: 1, label: "selected", ownerId: 10 },
        { id: 3, label: "sibling", ownerId: 10 },
        { id: 4, label: "other-owner", ownerId: 20 },
      ],
      leaves: [
        { id: 5, label: "incoming", branchId: null },
        { id: 6, label: "occupant", branchId: 1 },
        { id: 8, label: "other-owner-decoy", branchId: 4 },
        { id: 9, label: "sibling-decoy", branchId: 3 },
      ],
    };
    const final = refused
      ? initial
      : {
          owners: initial.owners,
          branches: cascade
            ? [
                initial.branches[1],
                initial.branches[2],
                { id: 7, label: "selected", ownerId: 10 },
              ]
            : initial.branches,
          leaves: [
            { id: 5, label: "incoming", branchId: cascade ? 7 : 1 },
            { id: 6, label: "occupant", branchId: cascade ? 7 : 1 },
            initial.leaves[2],
            initial.leaves[3],
          ],
        };
    const inspect = (database: Database.Database) => ({
      owners: database
        .prepare("SELECT * FROM g2_occupied_owners ORDER BY id")
        .all(),
      branches: database
        .prepare("SELECT * FROM g2_occupied_branches ORDER BY id")
        .all(),
      leaves: database
        .prepare("SELECT * FROM g2_occupied_leaves ORDER BY id")
        .all(),
    });
    const observeState = (state: StateRows) => {
      if (refused)
        assert.deepEqual(
          state,
          initial,
          "An occupied non-cascade key transition must refuse before any effect"
        );
      return undefined;
    };
    return {
      initial,
      tables: {
        owners: { name: "g2_occupied_owners", order: ["id"] },
        branches: { name: "g2_occupied_branches", order: ["id"] },
        leaves: { name: "g2_occupied_leaves", order: ["id"] },
      },
      observeState,
      publicInput: { model: "owner", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g2_occupied_owners(id INTEGER PRIMARY KEY,label TEXT NOT NULL);
          CREATE TABLE g2_occupied_branches(id INTEGER PRIMARY KEY,label TEXT NOT NULL UNIQUE,ownerId INTEGER NOT NULL REFERENCES g2_occupied_owners(id));
          CREATE TABLE g2_occupied_leaves(id INTEGER PRIMARY KEY,label TEXT NOT NULL,branchId INTEGER REFERENCES g2_occupied_branches(id) ON UPDATE ${cascade ? "CASCADE" : "NO ACTION"});
          INSERT INTO g2_occupied_owners VALUES(10,'owner-a'),(20,'owner-b');
          INSERT INTO g2_occupied_branches VALUES(1,'selected',10),(3,'sibling',10),(4,'other-owner',20);
          INSERT INTO g2_occupied_leaves VALUES(5,'incoming',NULL),(6,'occupant',1),(8,'other-owner-decoy',4),(9,'sibling-decoy',3);
          CREATE TRIGGER g2_occupied_no_clear BEFORE UPDATE OF branchId ON g2_occupied_leaves
          WHEN OLD.branchId IS NOT NULL AND NEW.branchId IS NULL
          BEGIN SELECT RAISE(ABORT,'fixture: an occupied key transition cannot clear and repair membership'); END;
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "owner",
            "update",
            args
          );
        return createClient({ schema, driver }).owner.update(args);
      },
      inspect,
      afterStatement(database) {
        return observeState(inspect(database));
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(
          observation.final,
          final,
          JSON.stringify(observation.outcome)
        );
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        if (!refused) {
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: {
              id: 10,
              label: "owner-a",
              branches: cascade
                ? [
                    initial.branches[1],
                    { id: 7, label: "selected", ownerId: 10 },
                  ]
                : [initial.branches[0], initial.branches[1]],
            },
          });
          return;
        }
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        assert.equal(observation.outcome.failure.name, "NestedWriteError");
        assert.equal(observation.outcome.failure.code, "V7001");
        // SQL's omitted referential action is NO ACTION; the public relation
        // failure owner names that default "restrict" (messages.ts and its caller).
        assert.equal(
          observation.outcome.failure.message,
          "Cannot update relation 'leaves' with onUpdate('restrict') while the current relation is occupied."
        );
      },
    };
  },
}));
