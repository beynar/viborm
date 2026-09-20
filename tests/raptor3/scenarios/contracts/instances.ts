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
        // RE-EXPRESSED (FC-01, 2026-09-21). This cell recorded
        // `NestedWriteError` V7001 "Nested operation 'set' on relation
        // 'targets' depends on an earlier 'connectOrCreate' target write in
        // the same nested write. Split these operations into separate
        // queries." FC-01 deleted the operation-global veto that produced it
        // (`Commands.expanded`) and places a fresh series member's ordered
        // observation at its consumer's execution point instead, so the
        // composition now EXECUTES. What it executes is unchanged and is the
        // engine's own canonical relation order (`collectionMutationOrder`:
        // `connectOrCreate` before `set`, whatever order the payload's keys
        // are in — the sibling `relation key order` cell runs both). TWO
        // physical orders run, one per selected bin, because FC-01 moves a
        // reader only where a write of the same series proposes the id that
        // reader reads. Bin 10's create resolves its id to the literal 1,
        // statically disjoint from the 2 that `set` looks up, so its lookup
        // never reaches `depend`: it keeps placement `before` and runs FIRST,
        // ahead of the connectOrCreate's look for target 99 (absent, and
        // nothing here creates it), the INSERT of the create arm's target,
        // its link, `set`'s clear of the bin's links, and the final link to
        // target 2. Bin 10 therefore completes. Only bin 11, whose create
        // proposes exactly the 2 `set` reads, has its lookup MOVED — behind
        // the create arm and its link, ahead of the clear — and there it is
        // never taken: bin 11 draws 2, s2_targets already holds row 2 from
        // the seed, and the create arm violates the table's PRIMARY KEY
        // first. No order avoids that: this payload deletes only
        // s2_bin_targets rows, never a target, so row 2 is present whenever
        // the create runs. The placement itself is pinned by
        // tests/raptor3/g4/parity/fresh-member-placement.test.ts.
        assert.equal(observation.outcome.failure.name, "UniqueConstraintError");
        assert.equal(observation.outcome.failure.code, "V3001");
        assert.equal(
          observation.outcome.failure.message,
          "Unique constraint violation"
        );
        assert(isRecord(observation.outcome.failure.meta));
        // The violated constraint is the target table's own key, not a
        // membership: the create arm, not the `set`, is what collides.
        assert.deepEqual(observation.outcome.failure.meta.columns, [
          "s2_targets.id",
        ]);
        // The retired `verifyChangedDependencyCommandsProgress` adjudicator
        // carried this literal — the engine's OWN published progress at the
        // failure — inside a two-armed comparison, and it ran at one profile
        // only (`sqlite-atomic-batch`; the interactive profile publishes no
        // segment progress). Restated here, one-sided, so this scenario pins
        // the record again. Re-expressed with the cell (FC-01): the refusal
        // was raised while the member at index 1 (bin 11) was still being
        // PLANNED, with only the root's segment behind it; the executed run
        // commits the root segment AND bin 10's before that same member fails
        // in its own member phase, so the two committed counts and the
        // completed-member count each advance by one. The located pair is
        // unchanged — the failing member is the same one, index 1 of 2.
        if (controls.profile === "sqlite-atomic-batch") {
          const progress =
            observation.outcome.failure.meta.recordSeriesProgress;
          assert(isRecord(progress));
          const { memberPath, totalMembers, ...segment } = progress;
          assert.deepEqual(segment, {
            atomicity: "segment",
            phase: "member",
            committedSegments: 2,
            committedWriteMembers: 2,
            completedMembers: 1,
          });
          // The deleted `program/` specimen published this same segment record
          // WITHOUT the located pair, so the pair could only be pinned where it
          // appeared. Every engine that remains publishes it; the pin is
          // unconditional now, which is strictly the stronger record.
          assert.deepEqual(
            { memberPath, totalMembers },
            { memberPath: [1], totalMembers: 2 }
          );
        }
        // One draw for the template before the capture cut, then one per
        // member built from the admitted payload — the fixture's declared
        // `initialDefault: 1` and `selectedMemberDefaults: [1, 2]`. The
        // interactive profile adds two: its rejection aborts the region it
        // opened, so the region owner spends its one recovery and re-runs the
        // operation; the template's commands are reused (no fourth template
        // draw) while both members are rebuilt, and this generator answers 2
        // to every draw after the second, so bin 10 now collides too and the
        // spent budget lets the violation surface.
        assert.deepEqual(
          observation.defaults,
          controls.profile === "sqlite-interactive"
            ? [
                { name: "target.id", value: 1 },
                { name: "target.id", value: 1 },
                { name: "target.id", value: 2 },
                { name: "target.id", value: 2 },
                { name: "target.id", value: 2 },
              ]
            : [
                { name: "target.id", value: 1 },
                { name: "target.id", value: 1 },
                { name: "target.id", value: 2 },
              ]
        );
        // Interactive: one transaction, both attempts rolled back, nothing at
        // all. Atomic batch: segment atomicity, so the root's segment (the
        // shelf's label) and bin 10's segment stand — target 1 created and
        // left orphaned by `set`'s clear, and bin 10 holding exactly target 2
        // — while bin 11 contributes nothing. Bin 12 belongs to shelf 2 and is
        // never selected, so its membership is untouched either way.
        assert.deepEqual(
          observation.final,
          controls.profile === "sqlite-interactive"
            ? initial
            : {
                shelves: [
                  { id: 1, label: "before-series" },
                  { id: 2, label: "untouched" },
                ],
                bins: initial.bins,
                targets: [{ id: 1 }, { id: 2 }, { id: 8 }],
                memberships: [
                  { binId: 10, targetId: 2 },
                  { binId: 12, targetId: 8 },
                ],
              }
        );
      },
    };
  },
};

export const instanceScenarios = [distinctDefaults, changedDependency];
