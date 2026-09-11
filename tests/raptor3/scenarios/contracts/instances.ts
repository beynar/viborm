import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { isRecord } from "@validation/value-guards";
import type { ScenarioDefinition } from "../../harness/protocol";
import type { ObservedWorld } from "../../harness/sqlite-world";
import { assertEquivalentRunObservations } from "../../../../benchmarks/operation-pipeline-semantics.mjs";

/** Compare only the two explicitly adjudicated S2 admission contracts. */
export function verifyInstanceAdmissionPair(
  baseline: ObservedWorld,
  compared: ObservedWorld
): void {
  const id = baseline.record.scenarioId;
  assert(id === "s2-distinct-defaults" || id === "s2-changed-dependency");
  baseline.fixture.assert(baseline.observation);
  compared.fixture.assert(compared.observation);
  let final = baseline.observation.final;
  if (id === "s2-distinct-defaults") {
    const renamed = new Map([
      ["ticket-3", "ticket-2"],
      ["ticket-5", "ticket-3"],
    ]);
    final = {
      ...final,
      tickets: final.tickets!.map((value) => {
        const ticket = value as { id: string; note: string; binId: number };
        return { ...ticket, id: renamed.get(ticket.id) ?? ticket.id };
      }),
    };
  }
  // Both raw ledgers and generated IDs are pinned by the exact oracles above.
  assertEquivalentRunObservations(
    id,
    { ...baseline.observation, final, defaults: [] },
    { ...compared.observation, defaults: [] }
  );
}

const distinctDefaults: ScenarioDefinition = {
  id: "s2-distinct-defaults",
  family: "S2",
  contracts: ["C08", "C13"],
  sources: [
    "tests/contracts/engine/write/update-many-relation-series-behavior.ts",
  ],
  prepare(controls) {
    let nextDefault = 0;
    let singleAdmission = false;
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
        singleAdmission = candidateFactory !== undefined;
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
        // The envelope and each captured occurrence admit once in Raptor 3.
        // Keep the old duplicate relation evaluations visible in its baseline.
        assert.deepEqual(observation.defaults, [
          { name: "ticket.id", value: "ticket-1" },
          { name: "ticket.id", value: "ticket-2" },
          { name: "ticket.id", value: "ticket-3" },
          ...(!singleAdmission
            ? [
                { name: "ticket.id", value: "ticket-4" },
                { name: "ticket.id", value: "ticket-5" },
              ]
            : []),
        ]);
        assert.deepEqual(observation.final, {
          bins,
          tickets: [
            decoy,
            {
              id: singleAdmission ? "ticket-2" : "ticket-3",
              note: "auto",
              binId: 1,
            },
            {
              id: singleAdmission ? "ticket-3" : "ticket-5",
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
    let singleAdmission = false;
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
      requiredCuts: ["s2-selected-members-captured"],
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
        singleAdmission = candidateFactory !== undefined;
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
        assert.equal(observation.outcome.failure.name, "NestedWriteError");
        assert.equal(observation.outcome.failure.code, "V7001");
        assert.equal(
          observation.outcome.failure.message,
          "Nested operation 'set' on relation 'targets' depends on an earlier 'connectOrCreate' target write in the same nested write. Split these operations into separate queries."
        );
        assert.deepEqual(observation.defaults, [
          { name: "target.id", value: 1 },
          { name: "target.id", value: 1 },
          ...(!singleAdmission ? [{ name: "target.id", value: 1 }] : []),
          { name: "target.id", value: 2 },
        ]);
        assert.deepEqual(observation.final, {
          ...initial,
          shelves:
            controls.profile === "sqlite-interactive"
              ? initial.shelves
              : [
                  { id: 1, label: "before-series" },
                  { id: 2, label: "untouched" },
                ],
        });
      },
    };
  },
};

export const instanceScenarios = [distinctDefaults, changedDependency];
