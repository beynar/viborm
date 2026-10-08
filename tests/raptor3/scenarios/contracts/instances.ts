// biome-ignore-all lint/suspicious/noMisplacedAssertion: The replay/scenario assertion helpers run from registered test cases.
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { isRecord } from "@validation/value-guards";
import type { ScenarioDefinition } from "../../harness/protocol";

const distinctDefaults: ScenarioDefinition = {
  id: "s2-distinct-defaults",
  family: "S2",
  contracts: ["C08", "C13"],
  sources: [
    "tests/contracts/engine/write/update-many-relation-series-behavior.ts",
  ],
  prepare(controls) {
    let nextDefault = 0;
    const bin = s
      .model({
        id: s.int().id(),
        label: s.string(),
        tickets: s.toMany(() => ticket),
      })
      .map("s2_bins");
    const ticket = s
      .model({
        id: s
          .string()
          .id()
          .default(() => {
            const value = `ticket-${++nextDefault}`;
            controls.recordDefault("ticket.id", value);
            return value;
          }),
        note: s.string(),
        binId: s.int(),
        bin: s
          .toOne(() => bin)
          .fields("binId")
          .references("id"),
      })
      .map("s2_tickets");
    const args = {
      where: { id: { in: [1, 2] } },
      data: { tickets: { create: { note: "auto" } } },
    };
    const bins = [
      { id: 1, label: "one" },
      { id: 2, label: "two" },
      { id: 3, label: "untouched" },
    ];
    const decoy = { id: "decoy", note: "untouched", binId: 3 };
    return {
      publicInput: { model: "bin", operation: "updateMany", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE s2_bins (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
          CREATE TABLE s2_tickets (id TEXT PRIMARY KEY, note TEXT NOT NULL, binId INTEGER NOT NULL REFERENCES s2_bins(id));
          INSERT INTO s2_bins VALUES (1,'one'),(2,'two'),(3,'untouched');
          INSERT INTO s2_tickets VALUES ('decoy','untouched',3);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return await candidateFactory({
            schema: { bin, ticket },
            driver,
          }).execute("bin", "updateMany", args);
        return await createClient({
          schema: { bin, ticket },
          driver,
        }).bin.updateMany(args);
      },
      inspect(database) {
        return {
          bins: database.prepare("SELECT * FROM s2_bins ORDER BY id").all(),
          tickets: database
            .prepare("SELECT * FROM s2_tickets ORDER BY id")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, { bins, tickets: [decoy] });
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { count: 2 },
        });
        // The envelope and each captured occurrence admit once (D-8), on every
        // arm: since C-01 the public client IS this engine.
        assert.deepEqual(observation.defaults, [
          { name: "ticket.id", value: "ticket-1" },
          { name: "ticket.id", value: "ticket-2" },
          { name: "ticket.id", value: "ticket-3" },
        ]);
        assert.deepEqual(observation.final, {
          bins,
          tickets: [
            decoy,
            {
              id: "ticket-2",
              note: "auto",
              binId: 1,
            },
            {
              id: "ticket-3",
              note: "auto",
              binId: 2,
            },
          ],
        });
      },
    };
  },
};

const changedDependency: ScenarioDefinition = {
  id: "s2-changed-dependency",
  family: "S2",
  contracts: ["C07", "C08", "C10", "C13"],
  sources: ["tests/contracts/engine/write/update-many-relation-series.test.ts"],
  prepare(controls) {
    let captureReached = false;
    let capturedDefaultCalls = 0;
    const shelf = s
      .model({
        id: s.int().id(),
        label: s.string(),
        bins: s.toMany(() => bin),
      })
      .map("s2_shelves");
    const bin = s
      .model({
        id: s.int().id(),
        shelfId: s.int(),
        shelf: s
          .toOne(() => shelf)
          .fields("shelfId")
          .references("id"),
        targets: s
          .toMany(() => target)
          .through("s2_bin_targets")
          .source("binId")
          .target("targetId"),
      })
      .map("s2_bins");
    const target = s
      .model({
        id: s
          .int()
          .id()
          .default(() => {
            const defaultValue =
              captureReached && ++capturedDefaultCalls > 1 ? 2 : 1;
            controls.recordDefault("target.id", defaultValue);
            return defaultValue;
          }),
        bins: s.toMany(() => bin),
      })
      .map("s2_targets");
    const args = {
      where: { id: 1 },
      data: {
        label: "before-series",
        bins: {
          updateMany: {
            data: {
              targets: {
                connectOrCreate: { where: { id: 99 }, create: {} },
                set: [{ id: 2 }],
              },
            },
          },
        },
      },
    };
    const initial = {
      shelves: [
        { id: 1, label: "original" },
        { id: 2, label: "untouched" },
      ],
      bins: [
        { id: 10, shelfId: 1 },
        { id: 11, shelfId: 1 },
        { id: 12, shelfId: 2 },
      ],
      targets: [{ id: 2 }, { id: 8 }],
      memberships: [{ binId: 12, targetId: 8 }],
    };
    return {
      publicInput: {
        model: "shelf",
        operation: "update",
        args,
        control: { initialDefault: 1, selectedMemberDefaults: [1, 2] },
      },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE s2_shelves (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
          CREATE TABLE s2_bins (id INTEGER PRIMARY KEY, shelfId INTEGER NOT NULL REFERENCES s2_shelves(id));
          CREATE TABLE s2_targets (id INTEGER PRIMARY KEY);
          CREATE TABLE s2_bin_targets (binId INTEGER NOT NULL REFERENCES s2_bins(id), targetId INTEGER NOT NULL REFERENCES s2_targets(id), PRIMARY KEY(binId,targetId));
          INSERT INTO s2_shelves VALUES (1,'original'),(2,'untouched');
          INSERT INTO s2_bins VALUES (10,1),(11,1),(12,2);
          INSERT INTO s2_targets VALUES (2),(8);
          INSERT INTO s2_bin_targets VALUES (12,8);
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return await candidateFactory({
            schema: { shelf, bin, target },
            driver,
          }).execute("shelf", "update", args);
        return await createClient({
          schema: { shelf, bin, target },
          driver,
        }).shelf.update(args);
      },
      inspect(database) {
        return {
          shelves: database
            .prepare("SELECT * FROM s2_shelves ORDER BY id")
            .all(),
          bins: database.prepare("SELECT * FROM s2_bins ORDER BY id").all(),
          targets: database
            .prepare("SELECT * FROM s2_targets ORDER BY id")
            .all(),
          memberships: database
            .prepare("SELECT * FROM s2_bin_targets ORDER BY binId,targetId")
            .all(),
        };
      },
      afterStatement(_database, completion) {
        const capturedIds = completion.rows.map((row) => {
          if (!isRecord(row)) return undefined;
          if (row.id === 10 || row.id === 10n) return 10;
          if (row.id === 11 || row.id === 11n) return 11;
          return undefined;
        });
        if (
          !captureReached &&
          capturedIds.length === 2 &&
          capturedIds.includes(10) &&
          capturedIds.includes(11)
        ) {
          captureReached = true;
          return "s2-selected-members-captured";
        }
        return undefined;
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        // V1 refuses the caller's adding-before-clearing spelling before
        // capturing or committing any relation-series member.
        assert.equal(observation.outcome.failure.name, "ValidationError");
        assert.equal(observation.outcome.failure.code, "V4001");
        assert.equal(
          observation.outcome.failure.message,
          "Validation failed for update: data.bins.updateMany.data.targets: Collection mutation must spell clearing verb 'set' before adding verb 'connectOrCreate'."
        );
        assert.deepEqual(observation.final, initial);
      },
    };
  },
};

export const instanceScenarios = [distinctDefaults, changedDependency];
