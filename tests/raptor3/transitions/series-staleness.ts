import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "../harness/protocol";

function seriesStalenessScenario(
  id:
    | "g2-series-captured-member-reparented"
    | "g2-series-parent-reference-reused"
    | "g2-series-filter-observation"
    | "g2-series-captured-member-missing"
): ScenarioDefinition {
  return {
    id,
    family: "S2",
    contracts: ["C05", "C08", "C10"],
    sources: [
      "tests/contracts/engine/write/progressive-parent-rowkey.test.ts",
      "tests/contracts/engine/write/update-many-relation-series-behavior.ts",
      "src/query-engine/write-engine/NestedSelectedRecordSeries.ts",
    ],
    prepare(controls) {
      assert.equal(
        controls.profile,
        "sqlite-atomic-batch",
        "The external change must occur between committed segments"
      );
      const parentReused = id === "g2-series-parent-reference-reused";
      const filterObservation = id === "g2-series-filter-observation";
      const memberMissing = id === "g2-series-captured-member-missing";
      const hub = s
        .model({
          id: s.string().id(),
          code: s.string().unique(),
          label: s.string(),
          spokes: s.toMany(() => spoke),
        })
        .map("g2_series_hubs");
      const spoke = s
        .model({
          id: s.string().id(),
          label: s.string(),
          hubCode: s.string(),
          hub: s
            .toOne(() => hub)
            .fields("hubCode")
            .references("code")
            .onUpdate("cascade"),
          notes: s.toMany(() => note),
        })
        .map("g2_series_spokes");
      const note = s
        .model({
          id: s.string().id(),
          text: s.string(),
          spokeId: s.string(),
          spoke: s
            .toOne(() => spoke)
            .fields("spokeId")
            .references("id"),
        })
        .map("g2_series_notes");
      const schema = { hub, spoke, note };
      const args = {
        where: { code: "H1" },
        data: {
          label: "prefix-committed",
          spokes: {
            updateMany: {
              where: filterObservation ? { label: "first" } : {},
              data: {
                label: filterObservation ? "member-updated" : "must-not-land",
                notes: {
                  create: filterObservation
                    ? { id: "n-observation", text: "created-after-capture" }
                    : { id: "n-race", text: "must-not-land" },
                },
              },
            },
          },
        },
        select: { id: true, code: true, label: true },
      } as const;
      const initial = {
        hubs: [
          { id: "h-decoy", code: "H9", label: "untouched" },
          { id: "h-other", code: "H2", label: "other" },
          { id: "h-selected", code: "H1", label: "selected" },
        ],
        spokes: [
          { id: "sp1", label: "first", hubCode: "H1" },
          { id: "sp2", label: "second", hubCode: "H2" },
          { id: "sp9", label: "untouched", hubCode: "H9" },
        ],
        notes: [{ id: "n9", text: "untouched", spokeId: "sp9" }],
      };
      const prefix = {
        ...initial,
        hubs: [
          initial.hubs[0]!,
          initial.hubs[1]!,
          { id: "h-selected", code: "H1", label: "prefix-committed" },
        ],
      };
      const final = {
        hubs: memberMissing
          ? [
              initial.hubs[0]!,
              initial.hubs[1]!,
              { id: "h-selected", code: "H3", label: "prefix-committed" },
            ]
          : parentReused
            ? [
                initial.hubs[0]!,
                { id: "h-other", code: "H1", label: "other" },
                { id: "h-selected", code: "H3", label: "prefix-committed" },
              ]
            : prefix.hubs,
        spokes: memberMissing
          ? [initial.spokes[1]!, initial.spokes[2]!]
          : filterObservation
            ? [
                { id: "sp1", label: "member-updated", hubCode: "H1" },
                initial.spokes[1]!,
                initial.spokes[2]!,
              ]
            : parentReused
              ? [
                  { id: "sp1", label: "first", hubCode: "H3" },
                  { id: "sp2", label: "second", hubCode: "H1" },
                  initial.spokes[2]!,
                ]
              : [
                  { id: "sp1", label: "first", hubCode: "H2" },
                  initial.spokes[1]!,
                  initial.spokes[2]!,
                ],
        notes: filterObservation
          ? [
              {
                id: "n-observation",
                text: "created-after-capture",
                spokeId: "sp1",
              },
              initial.notes[0]!,
            ]
          : initial.notes,
      };
      const afterLabelChange = {
        hubs: prefix.hubs,
        spokes: [
          { id: "sp1", label: "external", hubCode: "H1" },
          initial.spokes[1]!,
          initial.spokes[2]!,
        ],
        notes: initial.notes,
      };
      const inspect = (database: Database.Database) => ({
        hubs: database
          .prepare("SELECT * FROM g2_series_hubs ORDER BY id")
          .all(),
        spokes: database
          .prepare("SELECT * FROM g2_series_spokes ORDER BY id")
          .all(),
        notes: database
          .prepare("SELECT * FROM g2_series_notes ORDER BY id")
          .all(),
      });
      const cut = memberMissing
        ? "series-captured-member-missing"
        : filterObservation
          ? "series-captured-filter-changed"
          : parentReused
            ? "series-parent-reference-reused"
            : "series-captured-member-reparented";
      let mutated = false;
      return {
        publicInput: {
          model: "hub",
          operation: "update",
          args,
          externalMutation: {
            after:
              "sp1 captured outside a transaction after the committed root prefix",
            changes: memberMissing
              ? [
                  {
                    model: "hub",
                    id: "h-selected",
                    code: { from: "H1", to: "H3" },
                  },
                  { model: "spoke", id: "sp1", delete: true },
                ]
              : filterObservation
                ? [
                    {
                      model: "spoke",
                      id: "sp1",
                      label: { from: "first", to: "external" },
                    },
                  ]
                : parentReused
                  ? [
                      {
                        model: "hub",
                        id: "h-selected",
                        code: { from: "H1", to: "H3" },
                      },
                      {
                        model: "hub",
                        id: "h-other",
                        code: { from: "H2", to: "H1" },
                      },
                    ]
                  : [
                      {
                        model: "spoke",
                        id: "sp1",
                        hubCode: { from: "H1", to: "H2" },
                      },
                    ],
          },
        },
        requiredCuts: [cut],
        seed(database) {
          database.exec(`
            CREATE TABLE g2_series_hubs(id TEXT PRIMARY KEY NOT NULL,code TEXT NOT NULL UNIQUE,label TEXT NOT NULL);
            CREATE TABLE g2_series_spokes(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL,hubCode TEXT NOT NULL REFERENCES g2_series_hubs(code) ON UPDATE CASCADE);
            CREATE TABLE g2_series_notes(id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,spokeId TEXT NOT NULL REFERENCES g2_series_spokes(id));
            INSERT INTO g2_series_hubs VALUES('h-selected','H1','selected'),('h-other','H2','other'),('h-decoy','H9','untouched');
            INSERT INTO g2_series_spokes VALUES('sp1','first','H1'),('sp2','second','H2'),('sp9','untouched','H9');
            INSERT INTO g2_series_notes VALUES('n9','untouched','sp9');
          `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "hub",
              "update",
              args
            );
          return createClient({ schema, driver }).hub.update(args);
        },
        inspect,
        afterStatement(database, completion) {
          if (mutated) {
            if (filterObservation) {
              // The scalar update and descendant insert need no artificial mutual order.
              const legalStates = [
                afterLabelChange,
                { ...afterLabelChange, notes: final.notes },
                { ...final, notes: initial.notes },
                final,
              ];
              const current = inspect(database);
              assert(
                legalStates.some((state) => isDeepStrictEqual(current, state)),
                "Only the captured member's requested effects may follow the filter change"
              );
              return undefined;
            }
            assert.deepEqual(
              inspect(database),
              final,
              "Series refusal must precede member effects and preserve the committed prefix and external work"
            );
            return undefined;
          }
          // Each capture names the same fixed member. Extra projected fields are
          // immaterial; neither SQL spelling nor a statement ordinal identifies it.
          const captured =
            !completion.transactionOpen &&
            completion.rows.length === 1 &&
            completion.rows.every(
              (row) =>
                row !== null &&
                typeof row === "object" &&
                "id" in row &&
                row.id === "sp1"
            );
          if (!captured) return undefined;
          assert.equal(
            database.inTransaction,
            false,
            "External work cannot enter the operation transaction"
          );
          assert.deepEqual(
            inspect(database),
            prefix,
            "The root prefix must be committed before member capture"
          );
          if (memberMissing) {
            const moved = database
              .prepare(
                "UPDATE g2_series_hubs SET code='H3' WHERE id='h-selected' AND code='H1'"
              )
              .run();
            assert.equal(
              moved.changes,
              1,
              "Invalidate the captured parent premise"
            );
            const removed = database
              .prepare(
                "DELETE FROM g2_series_spokes WHERE id='sp1' AND hubCode='H3'"
              )
              .run();
            assert.equal(removed.changes, 1, "Remove only the captured member");
          } else if (filterObservation) {
            const changed = database
              .prepare(
                "UPDATE g2_series_spokes SET label='external' WHERE id='sp1' AND label='first' AND hubCode='H1'"
              )
              .run();
            assert.equal(
              changed.changes,
              1,
              "Change only the captured filter field"
            );
          } else if (parentReused) {
            const moved = database
              .prepare(
                "UPDATE g2_series_hubs SET code='H3' WHERE id='h-selected' AND code='H1'"
              )
              .run();
            assert.equal(
              moved.changes,
              1,
              "Move the exact selected parent's reference value"
            );
            const reused = database
              .prepare(
                "UPDATE g2_series_hubs SET code='H1' WHERE id='h-other' AND code='H2'"
              )
              .run();
            assert.equal(
              reused.changes,
              1,
              "The other owner must take the former reference"
            );
          } else {
            const moved = database
              .prepare(
                "UPDATE g2_series_spokes SET hubCode='H2' WHERE id='sp1' AND hubCode='H1'"
              )
              .run();
            assert.equal(
              moved.changes,
              1,
              "Reparent the exact captured member"
            );
          }
          assert.deepEqual(
            inspect(database),
            filterObservation ? afterLabelChange : final
          );
          mutated = true;
          return cut;
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            final,
            filterObservation
              ? "The captured member must execute even though its capture filter no longer matches"
              : "No member or descendant may write after the premise changes"
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, [cut]);
          if (filterObservation) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: {
                id: "h-selected",
                code: "H1",
                label: "prefix-committed",
              },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(observation.outcome.failure.name, "NestedWriteError");
          assert.equal(observation.outcome.failure.code, "V7001");
          assert.equal(
            observation.outcome.failure.message,
            parentReused
              ? "Cannot update relation 'spokes': parent record changed across a committed segment."
              : "Cannot update relation 'spokes': target record was not found for this parent."
          );
          if (memberMissing) {
            const meta = observation.outcome.failure.meta;
            assert(
              meta !== null &&
                typeof meta === "object" &&
                "recordSeriesProgress" in meta
            );
            const progress = meta.recordSeriesProgress;
            assert(
              progress !== null &&
                typeof progress === "object" &&
                "phase" in progress
            );
            assert.equal(
              progress.phase,
              "planning",
              "A missing captured member fails its fresh locate before parent or member write guards execute"
            );
          }
          // Raw state proves the acknowledged prefix. The complete failure envelope,
          // including progress metadata, is retained losslessly for legacy-first A/B.
        },
      };
    },
  };
}

export const seriesStalenessScenarios = [
  seriesStalenessScenario("g2-series-captured-member-reparented"),
  seriesStalenessScenario("g2-series-parent-reference-reused"),
  seriesStalenessScenario("g2-series-filter-observation"),
  seriesStalenessScenario("g2-series-captured-member-missing"),
];
