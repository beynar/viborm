import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type Database from "better-sqlite3";
import type {
  PreparedScenario,
  ScenarioDefinition,
  StateRows,
} from "../harness/protocol";

/** The SQLite and native-provider worlds share facts and checks, not driver APIs. */
export interface KeyFixture extends PreparedScenario {
  readonly initial: StateRows;
  readonly tables: Record<string, { name: string; order: readonly string[] }>;
  observeState?(state: StateRows): string | undefined;
}
export interface KeyScenario extends ScenarioDefinition {
  prepare(): KeyFixture;
}

function alternateLocatorScenario(
  id: "g2-key-alt-locator" | "g2-key-setnull-occupied-refused"
): KeyScenario {
  return {
    id,
    family: "C05",
    contracts: ["C05"],
    sources: [
      "tests/contracts/engine/write/compiled-key-transition-behavior.ts",
    ],
    prepare() {
      const occupied = id === "g2-key-setnull-occupied-refused";
      const org = s
        .model({
          id: s.string().id(),
          slug: s.string().unique(),
          seats: s.toMany(() => seat),
        })
        .map("g2_orgs");
      const seat = s
        .model({
          id: s.string().id(),
          name: s.string(),
          orgId: s.string().nullable(),
          org: s
            .toOne(() => org)
            .fields("orgId")
            .references("id")
            .onUpdate("setNull"),
        })
        .map("g2_seats");
      const schema = { org, seat };
      const args = {
        where: { slug: "s1" },
        data: { id: "o2", seats: { create: { id: "st1", name: "created" } } },
        select: { id: true, slug: true },
      } as const;
      const initial = {
        orgs: [
          { id: "o-old", slug: "decoy" },
          { id: "o1", slug: "s1" },
        ],
        seats: [
          { id: "decoy-seat", name: "untouched", orgId: "o-old" },
          ...(occupied ? [{ id: "st0", name: "incumbent", orgId: "o1" }] : []),
        ],
      };
      const inspect = (database: Database.Database) => ({
        orgs: database.prepare("SELECT * FROM g2_orgs ORDER BY id").all(),
        seats: database.prepare("SELECT * FROM g2_seats ORDER BY id").all(),
      });
      const observeState = (state: StateRows) => {
        if (occupied)
          assert.deepEqual(
            state,
            initial,
            "occupied transition must refuse before effects"
          );
        return undefined;
      };
      return {
        initial,
        tables: {
          orgs: { name: "g2_orgs", order: ["id"] },
          seats: { name: "g2_seats", order: ["id"] },
        },
        observeState,
        publicInput: { model: "org", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_orgs(id TEXT PRIMARY KEY NOT NULL,slug TEXT NOT NULL UNIQUE);
          CREATE TABLE g2_seats(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,orgId TEXT REFERENCES g2_orgs(id) ON UPDATE SET NULL);
          INSERT INTO g2_orgs VALUES('o1','s1'),('o-old','decoy');
          INSERT INTO g2_seats VALUES('decoy-seat','untouched','o-old');
        `);
          if (occupied)
            database.exec(
              "INSERT INTO g2_seats VALUES('st0','incumbent','o1');"
            );
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "org",
              "update",
              args
            );
          return createClient({ schema, driver }).org.update(args);
        },
        inspect,
        afterStatement(database) {
          return observeState(inspect(database));
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            occupied
              ? initial
              : {
                  orgs: [
                    { id: "o-old", slug: "decoy" },
                    { id: "o2", slug: "s1" },
                  ],
                  seats: [
                    initial.seats[0],
                    { id: "st1", name: "created", orgId: "o2" },
                  ],
                }
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!occupied) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: { id: "o2", slug: "s1" },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(observation.outcome.failure.name, "NestedWriteError");
          assert.equal(observation.outcome.failure.code, "V7001");
          assert.equal(
            observation.outcome.failure.message,
            "Cannot update relation 'seats' with onUpdate('setNull') while the current relation is occupied."
          );
        },
      };
    },
  };
}

const compoundScenario: KeyScenario = {
  id: "g2-key-compound-final",
  family: "C05",
  contracts: ["C05"],
  sources: ["tests/contracts/engine/write/compiled-key-transition-behavior.ts"],
  prepare() {
    const zone = s
      .model({
        region: s.string(),
        code: s.string(),
        label: s.string(),
        spots: s.toMany(() => spot),
      })
      .id(["region", "code"])
      .map("g2_zones");
    const spot = s
      .model({
        id: s.string().id(),
        name: s.string(),
        zoneRegion: s.string().nullable(),
        zoneCode: s.string().nullable(),
        zone: s
          .toOne(() => zone)
          .fields("zoneRegion", "zoneCode")
          .references("region", "code")
          .onUpdate("setNull"),
      })
      .map("g2_spots");
    const schema = { zone, spot };
    const args = {
      where: { region_code: { region: "eu", code: "west" } },
      data: { code: "east", spots: { create: { id: "sp1", name: "created" } } },
      select: { region: true, code: true, label: true },
    } as const;
    const initial = {
      zones: [
        { region: "eu", code: "decoy", label: "same-region" },
        { region: "eu", code: "west", label: "selected" },
        { region: "us", code: "west", label: "same-code" },
      ],
      spots: [
        {
          id: "decoy-code",
          name: "untouched",
          zoneRegion: "us",
          zoneCode: "west",
        },
        {
          id: "decoy-region",
          name: "untouched",
          zoneRegion: "eu",
          zoneCode: "decoy",
        },
      ],
    };
    return {
      initial,
      tables: {
        zones: { name: "g2_zones", order: ["region", "code"] },
        spots: { name: "g2_spots", order: ["id"] },
      },
      publicInput: { model: "zone", operation: "update", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g2_zones(region TEXT NOT NULL,code TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(region,code));
          CREATE TABLE g2_spots(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,zoneRegion TEXT,zoneCode TEXT,FOREIGN KEY(zoneRegion,zoneCode) REFERENCES g2_zones(region,code) ON UPDATE SET NULL);
          INSERT INTO g2_zones VALUES('eu','west','selected'),('eu','decoy','same-region'),('us','west','same-code');
          INSERT INTO g2_spots VALUES('decoy-code','untouched','us','west'),('decoy-region','untouched','eu','decoy');
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "zone",
            "update",
            args
          );
        return createClient({ schema, driver }).zone.update(args);
      },
      inspect(database) {
        return {
          zones: database
            .prepare("SELECT * FROM g2_zones ORDER BY region,code")
            .all(),
          spots: database.prepare("SELECT * FROM g2_spots ORDER BY id").all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, {
          zones: [
            initial.zones[0],
            { region: "eu", code: "east", label: "selected" },
            initial.zones[2],
          ],
          spots: [
            ...initial.spots,
            { id: "sp1", name: "created", zoneRegion: "eu", zoneCode: "east" },
          ],
        });
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        assert.deepEqual(observation.outcome, {
          kind: "success",
          value: { region: "eu", code: "east", label: "selected" },
        });
      },
    };
  },
};

function arithmeticScenario(
  id: "g2-key-arithmetic-final" | "g2-key-arithmetic-rollback"
): KeyScenario {
  return {
    id,
    family: "C05",
    contracts: ["C05"],
    sources: [
      "tests/contracts/engine/write/compiled-key-transition-behavior.ts",
    ],
    prepare() {
      const rollback = id === "g2-key-arithmetic-rollback";
      let moved = false;
      const counter = s
        .model({
          id: s.int().id(),
          tag: s.string().unique(),
          ticks: s.toMany(() => tick),
        })
        .map("g2_counters");
      const tick = s
        .model({
          id: s.string().id(),
          counterId: s.int().nullable(),
          counter: s
            .toOne(() => counter)
            .fields("counterId")
            .references("id")
            .onUpdate("setNull"),
        })
        .map("g2_ticks");
      const schema = { counter, tick };
      const args = {
        where: { tag: "selected" },
        data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
        select: { id: true, tag: true },
      } as const;
      const initial = {
        counters: [
          { id: 10, tag: "selected" },
          { id: 10000, tag: "decoy" },
        ],
        ticks: [
          { id: "decoy-tick", counterId: 10000 },
          ...(rollback ? [{ id: "tk1", counterId: 10000 }] : []),
        ],
      };
      const observeState = (state: StateRows) => {
        // Only the stored transition establishes this cut, not SQL text or step count.
        if (
          rollback &&
          !moved &&
          (state.counters as { id: number; tag: string }[]).some(
            (row) => row.id === 15 && row.tag === "selected"
          )
        ) {
          moved = true;
          return "arithmetic-root-moved";
        }
        return undefined;
      };
      return {
        initial,
        tables: {
          counters: { name: "g2_counters", order: ["id"] },
          ticks: { name: "g2_ticks", order: ["id"] },
        },
        observeState,
        publicInput: { model: "counter", operation: "update", args },
        requiredCuts: rollback ? ["arithmetic-root-moved"] : [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_counters(id INTEGER PRIMARY KEY,tag TEXT NOT NULL UNIQUE);
          CREATE TABLE g2_ticks(id TEXT PRIMARY KEY NOT NULL,counterId INTEGER REFERENCES g2_counters(id) ON UPDATE SET NULL);
          INSERT INTO g2_counters VALUES(10,'selected'),(10000,'decoy');
          INSERT INTO g2_ticks VALUES('decoy-tick',10000);
        `);
          if (rollback)
            database.exec("INSERT INTO g2_ticks VALUES('tk1',10000);");
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "counter",
              "update",
              args
            );
          return createClient({ schema, driver }).counter.update(args);
        },
        inspect(database) {
          return {
            counters: database
              .prepare("SELECT * FROM g2_counters ORDER BY id")
              .all(),
            ticks: database.prepare("SELECT * FROM g2_ticks ORDER BY id").all(),
          };
        },
        afterStatement(database) {
          return observeState(this.inspect(database));
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            rollback
              ? initial
              : {
                  counters: [{ id: 15, tag: "selected" }, initial.counters[1]],
                  ticks: [...initial.ticks, { id: "tk1", counterId: 15 }],
                }
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(
            observation.reachedCuts,
            rollback ? ["arithmetic-root-moved"] : []
          );
          if (rollback) {
            assert.equal(observation.outcome.kind, "failure");
            if (observation.outcome.kind !== "failure") return;
            assert.equal(
              observation.outcome.failure.name,
              "UniqueConstraintError"
            );
            assert.equal(observation.outcome.failure.code, "V3001");
            return;
          }
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { id: 15, tag: "selected" },
          });
        },
      };
    },
  };
}

function nullableReferenceScenario(
  id: "g2-key-null-final-refused" | "g2-key-null-old-empty"
): KeyScenario {
  return {
    id,
    family: "C05",
    contracts: ["C05"],
    sources: [
      "tests/contracts/engine/write/compiled-key-transition-behavior.ts",
    ],
    prepare() {
      const refused = id === "g2-key-null-final-refused";
      const bay = s
        .model({
          id: s.string().id(),
          area: s.string(),
          slot: s.string().nullable(),
          pads: s.toMany(() => pad),
        })
        .unique(["area", "slot"])
        .map("g2_bays");
      const pad = s
        .model({
          id: s.string().id(),
          bayArea: s.string().nullable(),
          baySlot: s.string().nullable(),
          bay: s
            .toOne(() => bay)
            .fields("bayArea", "baySlot")
            .references("area", "slot")
            .onUpdate("setNull"),
        })
        .map("g2_pads");
      const schema = { bay, pad };
      const args = {
        where: { id: "b1" },
        data: { slot: refused ? null : "west", pads: { create: { id: "p1" } } },
        select: { id: true, area: true, slot: true },
      } as const;
      const initial = {
        bays: [
          { id: "b1", area: "eu", slot: refused ? "west" : null },
          { id: "b2", area: "eu", slot: "decoy" },
          { id: "b3", area: "us", slot: "west" },
        ],
        pads: [
          { id: "decoy-area", bayArea: "eu", baySlot: "decoy" },
          { id: "decoy-slot", bayArea: "us", baySlot: "west" },
          { id: "p0", bayArea: "eu", baySlot: null },
        ],
      };
      const inspect = (database: Database.Database) => ({
        bays: database.prepare("SELECT * FROM g2_bays ORDER BY id").all(),
        pads: database.prepare("SELECT * FROM g2_pads ORDER BY id").all(),
      });
      const observeState = (state: StateRows) => {
        if (refused)
          assert.deepEqual(
            state,
            initial,
            "NULL final reference must refuse before effects"
          );
        return undefined;
      };
      return {
        initial,
        tables: {
          bays: { name: "g2_bays", order: ["id"] },
          pads: { name: "g2_pads", order: ["id"] },
        },
        observeState,
        publicInput: { model: "bay", operation: "update", args },
        requiredCuts: [],
        seed(database) {
          database.exec(`
          CREATE TABLE g2_bays(id TEXT PRIMARY KEY NOT NULL,area TEXT NOT NULL,slot TEXT,UNIQUE(area,slot));
          CREATE TABLE g2_pads(id TEXT PRIMARY KEY NOT NULL,bayArea TEXT,baySlot TEXT,FOREIGN KEY(bayArea,baySlot) REFERENCES g2_bays(area,slot) ON UPDATE SET NULL);
          INSERT INTO g2_bays VALUES('b2','eu','decoy'),('b3','us','west');
          INSERT INTO g2_pads VALUES('decoy-area','eu','decoy'),('decoy-slot','us','west'),('p0','eu',NULL);
        `);
          database
            .prepare("INSERT INTO g2_bays VALUES('b1','eu',?)")
            .run(refused ? "west" : null);
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "bay",
              "update",
              args
            );
          return createClient({ schema, driver }).bay.update(args);
        },
        inspect,
        afterStatement(database) {
          return observeState(inspect(database));
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(
            observation.final,
            refused
              ? initial
              : {
                  bays: [
                    { id: "b1", area: "eu", slot: "west" },
                    initial.bays[1],
                    initial.bays[2],
                  ],
                  pads: [
                    ...initial.pads,
                    { id: "p1", bayArea: "eu", baySlot: "west" },
                  ],
                }
          );
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!refused) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: { id: "b1", area: "eu", slot: "west" },
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          assert.equal(observation.outcome.failure.name, "NestedWriteError");
          assert.equal(observation.outcome.failure.code, "V7001");
          assert.equal(
            observation.outcome.failure.message,
            "Cannot update relation key field 'slot' to null while mutating relation 'pads'. A null reference names no row for that relation to point at."
          );
        },
      };
    },
  };
}

// Registry order is independent of the schema-family grouping above.
export const keyTransitionScenarios: KeyScenario[] = [
  alternateLocatorScenario("g2-key-alt-locator"),
  compoundScenario,
  arithmeticScenario("g2-key-arithmetic-final"),
  nullableReferenceScenario("g2-key-null-final-refused"),
  alternateLocatorScenario("g2-key-setnull-occupied-refused"),
  nullableReferenceScenario("g2-key-null-old-empty"),
  arithmeticScenario("g2-key-arithmetic-rollback"),
];
