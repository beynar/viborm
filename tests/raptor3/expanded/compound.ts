import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const literalCases = [
  "g1-compound-agree-partial",
  "g1-compound-agree-complete",
  "g1-compound-conflict",
  "g1-compound-null",
  "g1-compound-selected-owned-key",
  "g1-compound-create-owned-key",
] as const;

const literalScenarios: ScenarioDefinition[] = literalCases.map((id) => ({
  id,
  family: "C03",
  contracts: ["C02", "C03", "C13"],
  sources: [
    "tests/contracts/engine/write/adopt-owned-fk-agreement-behavior.ts",
  ],
  prepare() {
    const pair = s
      .model({
        a: s.string(),
        b: s.string(),
        label: s.string(),
        kids: s.toMany(() => kid),
      })
      .id(["a", "b"])
      .map("g1_pairs");
    const kid = s
      .model({
        id: s.string().id(),
        slug: s.string().unique(),
        label: s.string(),
        pa: s.string().nullable().map("parent_a"),
        pb: s.string().nullable().map("parent_b"),
        pair: s
          .toOne(() => pair)
          .fields("pa", "pb")
          .references("a", "b"),
      })
      .map("g1_kids");
    const schema = { pair, kid };
    const selected = id === "g1-compound-selected-owned-key";
    const createOwned = id === "g1-compound-create-owned-key";
    const admitted =
      id === "g1-compound-agree-partial" || id === "g1-compound-agree-complete";
    const update = {
      label: "changed",
      pa:
        id === "g1-compound-null"
          ? null
          : id === "g1-compound-conflict"
            ? "west"
            : "north",
      ...(id === "g1-compound-agree-complete" ? { pb: { set: "west" } } : {}),
    };
    const data = {
      label: "requested",
      kids: {
        upsert: {
          where: { slug: "found" },
          create: {
            id: "unused",
            slug: "unused",
            label: "unused",
            ...(createOwned ? { pa: "north", pb: "west" } : {}),
          },
          update,
        },
      },
    };
    const select = { a: true, b: true, label: true } as const;
    const createArgs = { data: { a: "north", b: "west", ...data }, select };
    const updateArgs = {
      where: { a_b: { a: "north", b: "west" } },
      data,
      select,
    };
    const pairs = [
      { a: "north", b: "north", label: "same-first" },
      ...(selected ? [{ a: "north", b: "west", label: "selected" }] : []),
      { a: "old", b: "pair", label: "foreign" },
      { a: "west", b: "west", label: "same-second" },
    ];
    const kids = [
      {
        id: "decoy",
        slug: "decoy",
        label: "untouched",
        parent_a: "north",
        parent_b: "north",
      },
      {
        id: "target",
        slug: "found",
        label: "stored",
        parent_a: selected ? "north" : "old",
        parent_b: selected ? "west" : "pair",
      },
    ];
    const initial = { pairs, kids };
    const final = admitted
      ? {
          pairs: [
            pairs[0],
            { a: "north", b: "west", label: "requested" },
            ...pairs.slice(1),
          ],
          kids: [
            kids[0],
            {
              id: "target",
              slug: "found",
              label: "changed",
              parent_a: "north",
              parent_b: "west",
            },
          ],
        }
      : initial;
    return {
      publicInput: {
        model: "pair",
        operation: selected ? "update" : "create",
        args: selected ? updateArgs : createArgs,
      },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_pairs (a TEXT NOT NULL, b TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(a,b));
          CREATE TABLE g1_kids (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, parent_a TEXT, parent_b TEXT, FOREIGN KEY(parent_a,parent_b) REFERENCES g1_pairs(a,b));
        `);
        for (const row of pairs)
          database
            .prepare("INSERT INTO g1_pairs VALUES (?,?,?)")
            .run(row.a, row.b, row.label);
        for (const row of kids)
          database
            .prepare("INSERT INTO g1_kids VALUES (?,?,?,?,?)")
            .run(row.id, row.slug, row.label, row.parent_a, row.parent_b);
        if (admitted) {
          database.exec(`
            CREATE TRIGGER g1_no_transient_null
            BEFORE UPDATE OF parent_a,parent_b ON g1_kids
            WHEN OLD.parent_a IS NOT NULL AND OLD.parent_b IS NOT NULL
              AND (NEW.parent_a IS NULL OR NEW.parent_b IS NULL)
            BEGIN
              SELECT RAISE(ABORT,'C03 compound reference must not become transiently NULL');
            END;
          `);
        }
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema, driver }).execute(
            "pair",
            selected ? "update" : "create",
            selected ? updateArgs : createArgs
          );
        const client = createClient({ schema, driver });
        return selected
          ? await client.pair.update(updateArgs)
          : await client.pair.create(createArgs);
      },
      inspect(database) {
        return {
          pairs: database.prepare("SELECT * FROM g1_pairs ORDER BY a,b").all(),
          kids: database.prepare("SELECT * FROM g1_kids ORDER BY id").all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, final);
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        if (admitted) {
          assert.deepEqual(observation.outcome, {
            kind: "success",
            value: { a: "north", b: "west", label: "requested" },
          });
          return;
        }
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        assert.equal(
          observation.outcome.failure.name,
          selected || createOwned
            ? "ValidationError"
            : "UnsupportedOperationError"
        );
        assert.match(
          observation.outcome.failure.message,
          selected || createOwned
            ? /Unknown key: pa/
            : /Relation 'kids' owns 'pa, pb'; omit it from nested create and update data\./
        );
      },
    };
  },
}));

const generatedParent: ScenarioDefinition = {
  id: "g1-compound-generated-parent",
  family: "C03",
  contracts: ["C03", "C04"],
  sources: [
    "tests/contracts/engine/write/adopt-owned-fk-agreement-behavior.ts",
  ],
  prepare() {
    const parent = s
      .model({
        id: s.int().id().increment(),
        tag: s.string(),
        children: s.toMany(() => child),
      })
      .unique(["id", "tag"])
      .map("g1_generated_parents");
    const child = s
      .model({
        id: s.string().id(),
        slug: s.string().unique(),
        parentId: s.int(),
        parentTag: s.string(),
        parent: s
          .toOne(() => parent)
          .fields("parentId", "parentTag")
          .references("id", "tag"),
      })
      .map("g1_generated_children");
    const args = {
      data: {
        tag: "new",
        children: {
          upsert: {
            where: { slug: "found" },
            create: { id: "unused", slug: "unused" },
            update: { parentId: 41, parentTag: "new" },
          },
        },
      },
    };
    const initial = {
      parents: [{ id: 7, tag: "decoy" }],
      children: [
        { id: "target", slug: "found", parentId: 7, parentTag: "decoy" },
      ],
      sequences: [{ name: "g1_generated_parents", seq: 40 }],
    };
    return {
      publicInput: { model: "parent", operation: "create", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_generated_parents (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, UNIQUE(id,tag));
          CREATE TABLE g1_generated_children (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, parentId INTEGER NOT NULL, parentTag TEXT NOT NULL, FOREIGN KEY(parentId,parentTag) REFERENCES g1_generated_parents(id,tag));
          INSERT INTO g1_generated_parents VALUES (7,'decoy');
          INSERT INTO g1_generated_children VALUES ('target','found',7,'decoy');
          UPDATE sqlite_sequence SET seq=40;
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({
            schema: { parent, child },
            driver,
          }).execute("parent", "create", args);
        return await createClient({
          schema: { parent, child },
          driver,
        }).parent.create(args);
      },
      inspect(database) {
        return {
          parents: database
            .prepare("SELECT * FROM g1_generated_parents ORDER BY id")
            .all(),
          children: database
            .prepare("SELECT * FROM g1_generated_children ORDER BY id")
            .all(),
          sequences: database
            .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
            .all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, initial);
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        assert.equal(
          observation.outcome.failure.name,
          "UnsupportedOperationError"
        );
        assert.equal(
          observation.outcome.failure.message,
          "Relation 'children' owns 'parentId, parentTag'; omit it from nested create and update data."
        );
      },
    };
  },
};

const unknownComponent: ScenarioDefinition = {
  id: "g1-compound-unknown-component",
  family: "C03",
  contracts: ["C03"],
  sources: [
    "tests/contracts/engine/write/compound-relation-adoption-behavior.ts",
  ],
  prepare() {
    const zone = s
      .model({
        id: s.int().id(),
        area: s.string(),
        slot: s.string().nullable(),
        spots: s.toMany(() => spot),
      })
      .unique(["area", "slot"])
      .map("g1_zones");
    const spot = s
      .model({
        id: s.int().id(),
        zoneArea: s.string().nullable(),
        zoneSlot: s.string().nullable(),
        zone: s
          .toOne(() => zone)
          .fields("zoneArea", "zoneSlot")
          .references("area", "slot"),
      })
      .map("g1_spots");
    const args = {
      data: {
        id: 1,
        area: "new",
        slot: null,
        spots: { connectOrCreate: { where: { id: 1 }, create: { id: 1 } } },
      },
    };
    const initial = {
      zones: [{ id: 7, area: "old", slot: "decoy" }],
      spots: [{ id: 7, zoneArea: "old", zoneSlot: "decoy" }],
    };
    return {
      publicInput: { model: "zone", operation: "create", args },
      requiredCuts: [],
      seed(database) {
        database.exec(`
          CREATE TABLE g1_zones (id INTEGER PRIMARY KEY, area TEXT NOT NULL, slot TEXT, UNIQUE(area,slot));
          CREATE TABLE g1_spots (id INTEGER PRIMARY KEY, zoneArea TEXT, zoneSlot TEXT, FOREIGN KEY(zoneArea,zoneSlot) REFERENCES g1_zones(area,slot));
          INSERT INTO g1_zones VALUES (7,'old','decoy');
          INSERT INTO g1_spots VALUES (7,'old','decoy');
        `);
      },
      async invoke(driver, candidateFactory) {
        if (candidateFactory)
          return candidateFactory({ schema: { zone, spot }, driver }).execute(
            "zone",
            "create",
            args
          );
        return await createClient({
          schema: { zone, spot },
          driver,
        }).zone.create(args);
      },
      inspect(database) {
        return {
          zones: database.prepare("SELECT * FROM g1_zones ORDER BY id").all(),
          spots: database.prepare("SELECT * FROM g1_spots ORDER BY id").all(),
        };
      },
      assert(observation) {
        assert.deepEqual(observation.initial, initial);
        assert.deepEqual(observation.final, initial);
        assert.deepEqual(observation.defaults, []);
        assert.deepEqual(observation.reachedCuts, []);
        assert.equal(observation.outcome.kind, "failure");
        if (observation.outcome.kind !== "failure") return;
        assert.equal(
          observation.outcome.failure.name,
          "UnsupportedOperationError"
        );
        assert.equal(
          observation.outcome.failure.message,
          "query-engine-v2 create cannot resolve the parent id for relation 'spots': referenced field 'slot' is neither this record's primary key nor a knowable value in its own create data."
        );
      },
    };
  },
};

export const compoundScenarios = [
  ...literalScenarios,
  generatedParent,
  unknownComponent,
];
