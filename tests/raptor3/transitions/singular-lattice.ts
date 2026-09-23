import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import { G2_LATTICE_CASE_IDS } from "../contracts";
import type { G0ReplayRecord, ScenarioDefinition } from "../harness/protocol";

const publicArms = {
  disconnect: true,
  delete: true,
  update: { tag: "u" },
  upsert: { update: { tag: "u" }, create: { id: "b-up", tag: "up" } },
  connectOrCreate: {
    where: { id: "b-alt" },
    create: { id: "b-alt", tag: "never-minted" },
  },
  connect: { id: "b-alt" },
  create: { id: "b-new", tag: "fresh" },
} as const;

type FinalState =
  | "unchanged"
  | "orphan-adopt"
  | "orphan-create"
  | "delete-adopt"
  | "delete-create"
  | "orphan-adopt-modify"
  | "orphan-create-modify"
  | "delete-adopt-modify"
  | "delete-create-modify";
// N1 (D-51) removed the fourth outcome this table carried, "own-write": the
// veto it named ("Nested operation 'update' on relation 'badge' depends on an
// earlier 'delete' target write in the same nested write. Split these
// operations into separate queries.") is retired, and its one cell now names
// the state the arms produce. No arm combination of this lattice reaches it.
type Recipe = {
  arms: readonly (keyof typeof publicArms)[];
  outcome: FinalState | "validation" | "occupancy";
  /** Exact declaration-order names from the public validation contract. */
  rejectedKinds?: string;
};

// This is the public contract's finite answer table, not an implementation of
// the admission lattice. The caller's arm order deliberately differs from its
// validation-message order and from the effects' required order.
const recipes: Record<(typeof G2_LATTICE_CASE_IDS)[number], Recipe> = {
  "g2-lattice-disconnect-delete": {
    arms: ["disconnect", "delete"],
    outcome: "validation",
    rejectedKinds: "disconnect, delete",
  },
  "g2-lattice-disconnect-update": {
    arms: ["disconnect", "update"],
    outcome: "validation",
    rejectedKinds: "update, disconnect",
  },
  "g2-lattice-disconnect-upsert": {
    arms: ["disconnect", "upsert"],
    outcome: "validation",
    rejectedKinds: "upsert, disconnect",
  },
  "g2-lattice-disconnect-coc": {
    arms: ["disconnect", "connectOrCreate"],
    outcome: "orphan-adopt",
  },
  "g2-lattice-disconnect-connect": {
    arms: ["disconnect", "connect"],
    outcome: "orphan-adopt",
  },
  "g2-lattice-disconnect-create": {
    arms: ["disconnect", "create"],
    outcome: "orphan-create",
  },
  "g2-lattice-delete-update": {
    arms: ["delete", "update"],
    outcome: "validation",
    rejectedKinds: "update, delete",
  },
  "g2-lattice-delete-upsert": {
    arms: ["delete", "upsert"],
    outcome: "validation",
    rejectedKinds: "upsert, delete",
  },
  "g2-lattice-delete-coc": {
    arms: ["delete", "connectOrCreate"],
    outcome: "validation",
    rejectedKinds: "connectOrCreate, delete",
  },
  "g2-lattice-delete-connect": {
    arms: ["delete", "connect"],
    outcome: "delete-adopt",
  },
  "g2-lattice-delete-create": {
    arms: ["delete", "create"],
    outcome: "delete-create",
  },
  "g2-lattice-update-upsert": {
    arms: ["update", "upsert"],
    outcome: "validation",
    rejectedKinds: "update, upsert",
  },
  "g2-lattice-update-coc": {
    arms: ["update", "connectOrCreate"],
    outcome: "occupancy",
  },
  "g2-lattice-update-connect": {
    arms: ["update", "connect"],
    outcome: "occupancy",
  },
  "g2-lattice-update-create": {
    arms: ["update", "create"],
    outcome: "occupancy",
  },
  "g2-lattice-upsert-coc": {
    arms: ["upsert", "connectOrCreate"],
    outcome: "validation",
    rejectedKinds: "connectOrCreate, upsert",
  },
  "g2-lattice-upsert-connect": {
    arms: ["upsert", "connect"],
    outcome: "validation",
    rejectedKinds: "connect, upsert",
  },
  "g2-lattice-upsert-create": {
    arms: ["upsert", "create"],
    outcome: "validation",
    rejectedKinds: "create, upsert",
  },
  "g2-lattice-coc-connect": {
    arms: ["connectOrCreate", "connect"],
    outcome: "validation",
    rejectedKinds: "connect, connectOrCreate",
  },
  "g2-lattice-coc-create": {
    arms: ["connectOrCreate", "create"],
    outcome: "validation",
    rejectedKinds: "create, connectOrCreate",
  },
  "g2-lattice-connect-create": {
    arms: ["connect", "create"],
    outcome: "validation",
    rejectedKinds: "create, connect",
  },
  "g2-lattice-disconnect-connect-update": {
    arms: ["disconnect", "connect", "update"],
    outcome: "orphan-adopt-modify",
  },
  "g2-lattice-disconnect-coc-update": {
    arms: ["disconnect", "connectOrCreate", "update"],
    outcome: "orphan-adopt-modify",
  },
  "g2-lattice-disconnect-create-update": {
    arms: ["disconnect", "create", "update"],
    outcome: "orphan-create-modify",
  },
  "g2-lattice-delete-connect-update": {
    arms: ["delete", "connect", "update"],
    // The arms run `delete`, `connect`, `update`: the incumbent goes, the
    // alternate is adopted, and the selector-free modifier observes the member
    // the connect established.
    outcome: "delete-adopt-modify",
  },
  "g2-lattice-delete-coc-update": {
    arms: ["delete", "connectOrCreate", "update"],
    outcome: "validation",
    rejectedKinds: "connectOrCreate, update, delete",
  },
  "g2-lattice-delete-create-update": {
    arms: ["delete", "create", "update"],
    outcome: "delete-create-modify",
  },
  "g2-lattice-empty": { arms: [], outcome: "unchanged" },
  "g2-lattice-inactive-false": { arms: [], outcome: "unchanged" },
};

export const singularLatticeScenarios: ScenarioDefinition[] =
  G2_LATTICE_CASE_IDS.map((id) => ({
    id,
    family: "C07",
    contracts: ["C06", "C07", "C13"],
    sources: [
      "tests/contracts/engine/write/vacate-then-supply-pair-lattice.test.ts",
      "tests/contracts/engine/write/vacate-then-supply-behavior.ts",
      "src/validation/relations/to-one-mutation-schema.ts",
      "src/validation/relations/update.ts",
    ],
    prepare() {
      const recipe = recipes[id];
      const station = s
        .model({
          id: s.string().id(),
          label: s.string(),
          badge: s.toOne(() => badge),
        })
        .map("g2_lattice_stations");
      const badge = s
        .model({
          id: s.string().id(),
          tag: s.string(),
          stationId: s.string().nullable().unique(),
          station: s
            .toOne(() => station)
            .fields("stationId")
            .references("id"),
        })
        .map("g2_lattice_badges");
      const schema = { station, badge };
      const mutation =
        id === "g2-lattice-inactive-false"
          ? { disconnect: false, delete: false }
          : Object.fromEntries(
              recipe.arms.map((arm) => [arm, structuredClone(publicArms[arm])])
            );
      const args = {
        where: { id: "s1" },
        data: { badge: mutation },
        select: { id: true, label: true },
      };
      const alternate = { id: "b-alt", tag: "alt", stationId: null };
      const foreign = {
        id: "b-foreign",
        tag: "untouched-foreign",
        stationId: "s9",
      };
      const free = { id: "b-free", tag: "untouched-free", stationId: null };
      const incumbent = { id: "b1", tag: "incumbent", stationId: "s1" };
      const orphan = { id: "b1", tag: "incumbent", stationId: null };
      const adopted = { id: "b-alt", tag: "alt", stationId: "s1" };
      const adoptedModified = { id: "b-alt", tag: "u", stationId: "s1" };
      const created = { id: "b-new", tag: "fresh", stationId: "s1" };
      const createdModified = { id: "b-new", tag: "u", stationId: "s1" };
      const initial = {
        stations: [
          { id: "s1", label: "L" },
          { id: "s9", label: "untouched" },
        ],
        badges: [alternate, foreign, free, incumbent],
      };
      const expectedBadges = {
        unchanged: initial.badges,
        "orphan-adopt": [adopted, foreign, free, orphan],
        "orphan-create": [alternate, foreign, free, created, orphan],
        "delete-adopt": [adopted, foreign, free],
        "delete-create": [alternate, foreign, free, created],
        "orphan-adopt-modify": [adoptedModified, foreign, free, orphan],
        "orphan-create-modify": [
          alternate,
          foreign,
          free,
          createdModified,
          orphan,
        ],
        "delete-adopt-modify": [adoptedModified, foreign, free],
        "delete-create-modify": [alternate, foreign, free, createdModified],
      };
      const refused = recipe.outcome === "validation";
      const failed = refused || recipe.outcome === "occupancy";
      const final = {
        stations: initial.stations,
        badges:
          recipe.outcome === "validation" || recipe.outcome === "occupancy"
            ? initial.badges
            : expectedBadges[recipe.outcome],
      };
      const inspect = (database: Database.Database) => ({
        stations: database
          .prepare("SELECT * FROM g2_lattice_stations ORDER BY id")
          .all(),
        badges: database
          .prepare("SELECT * FROM g2_lattice_badges ORDER BY id")
          .all(),
      });
      return {
        publicInput: { model: "station", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_lattice_stations(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL);
          CREATE TABLE g2_lattice_badges(id TEXT PRIMARY KEY NOT NULL,tag TEXT NOT NULL,stationId TEXT UNIQUE REFERENCES g2_lattice_stations(id));
          INSERT INTO g2_lattice_stations VALUES('s1','L'),('s9','untouched');
          INSERT INTO g2_lattice_badges VALUES('b-alt','alt',NULL),('b-foreign','untouched-foreign','s9'),('b-free','untouched-free',NULL),('b1','incumbent','s1');
        `);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "station",
              "update",
              args
            );
          const stationClient = createClient({ schema, driver }).station;
          // Deliberately refused bags must reach public runtime admission. Reflection
          // preserves the public receiver without pretending this enumeration is a DX probe.
          const publicValue: unknown = await Reflect.apply(
            stationClient.update,
            stationClient,
            [args]
          );
          return publicValue;
        },
        inspect,
        afterStatement(database) {
          if (refused || recipe.outcome === "unchanged")
            assert.deepEqual(
              inspect(database),
              initial,
              "Refused and inactive relation arms must have no effects"
            );
          return undefined;
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
          if (!failed) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: { id: "s1", label: "L" },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          const failure = observation.outcome.failure;
          if (recipe.outcome === "validation") {
            assert.equal(failure.name, "ValidationError");
            assert.equal(failure.code, "V4001");
            assert.equal(
              failure.message,
              `Validation failed for update: Unsupported to-one operation combination: ${recipe.rejectedKinds}`
            );
            return;
          }
          assert.equal(failure.name, "UniqueConstraintError");
          assert.equal(failure.code, "V3001");
          assert.equal(failure.message, "Unique constraint violation");
        },
      };
    },
  }));

export function assertLatticeDispatch(record: G0ReplayRecord): void {
  if (
    record.observation.outcome.kind === "failure" &&
    record.observation.outcome.failure.code === "V4001"
  )
    assert(
      !record.tape.events.some((event) => event.kind === "dispatch"),
      "Public lattice validation must precede every provider dispatch, including a failed statement"
    );
  if (
    record.observation.outcome.kind === "failure" &&
    record.observation.outcome.failure.code === "V3001"
  )
    assert(
      record.tape.events.some(
        (event) =>
          event.kind === "dispatch-failure" &&
          event.failure.code === "SQLITE_CONSTRAINT_UNIQUE" &&
          event.failure.message ===
            "UNIQUE constraint failed: g2_lattice_badges.stationId"
      ),
      "The actual native occupied-slot constraint, not a different key, must reject the supplier"
    );
}
