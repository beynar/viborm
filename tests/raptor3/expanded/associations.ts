import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import type { ScenarioDefinition } from "../harness/protocol";

const recipes = [
  ["g1-parent-fresh-create", "parent", "fresh-create"],
  ["g1-parent-selected-create", "parent", "selected-create"],
  ["g1-parent-fresh-connect-foreign", "parent", "fresh-connect-foreign"],
  ["g1-parent-selected-connect-missing", "parent", "selected-connect-missing"],
  ["g1-parent-fresh-coc-missing", "parent", "fresh-coc-missing"],
  [
    "g1-parent-selected-coc-found-foreign",
    "parent",
    "selected-coc-found-foreign",
  ],
  ["g1-parent-selected-upsert-found", "parent", "selected-upsert-found"],
  ["g1-parent-selected-upsert-missing", "parent", "selected-upsert-missing"],
  ["g1-parent-fresh-upsert-refused", "parent", "fresh-upsert-refused"],
  ["g1-child-fresh-create", "child", "fresh-create"],
  ["g1-child-selected-create", "child", "selected-create"],
  ["g1-child-fresh-connect-foreign", "child", "fresh-connect-foreign"],
  ["g1-child-selected-connect-missing", "child", "selected-connect-missing"],
  ["g1-child-fresh-coc-missing", "child", "fresh-coc-missing"],
  [
    "g1-child-selected-coc-found-foreign",
    "child",
    "selected-coc-found-foreign",
  ],
  [
    "g1-child-fresh-upsert-found-foreign",
    "child",
    "fresh-upsert-found-foreign",
  ],
  ["g1-child-selected-upsert-missing", "child", "selected-upsert-missing"],
  ["g1-child-selected-upsert-foreign", "child", "selected-upsert-foreign"],
  ["g1-junction-fresh-create", "junction", "fresh-create"],
  ["g1-junction-selected-create", "junction", "selected-create"],
  ["g1-junction-fresh-connect-foreign", "junction", "fresh-connect-foreign"],
  [
    "g1-junction-selected-connect-missing",
    "junction",
    "selected-connect-missing",
  ],
  ["g1-junction-selected-connect-owned", "junction", "selected-connect-owned"],
  ["g1-junction-fresh-coc-missing", "junction", "fresh-coc-missing"],
  [
    "g1-junction-selected-coc-found-foreign",
    "junction",
    "selected-coc-found-foreign",
  ],
  [
    "g1-junction-fresh-upsert-found-foreign",
    "junction",
    "fresh-upsert-found-foreign",
  ],
  [
    "g1-junction-selected-upsert-missing",
    "junction",
    "selected-upsert-missing",
  ],
  [
    "g1-junction-selected-upsert-foreign",
    "junction",
    "selected-upsert-foreign",
  ],
  ["g1-selected-upsert-reparent", "child", "selected-upsert-reparent"],
  [
    "g1-selected-upsert-explicit-fk-conflict",
    "child",
    "selected-upsert-explicit-fk-conflict",
  ],
] as const;

export const associationScenarios: ScenarioDefinition[] = recipes.map(
  ([id, orientation, recipe]) => ({
    id,
    family: "C02",
    contracts: ["C02", "C03", "C04"],
    sources: [
      "tests/contracts/engine/write/parent-held-lookup-behavior.ts",
      "tests/contracts/engine/write/junction-adopt-create-relations.test.ts",
      "tests/contracts/engine/write/upsert-family.test.ts",
      "tests/contracts/engine/write/depth-seam-behavior.ts",
      "tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior.ts",
    ],
    prepare() {
      const owner = s
        .model({
          id: s.int().id(),
          label: s.string(),
          favoriteId: s.int().nullable(),
          favorite: s
            .toOne(() => favorite)
            .fields("favoriteId")
            .references("id"),
          children: s.toMany(() => child),
          tags: s
            .toMany(() => tag)
            .through("g1_owner_tags")
            .source("ownerId")
            .target("tagId"),
        })
        .map("g1_owners");
      const favorite = s
        .model({
          id: s.int().id().increment(),
          code: s.string().unique(),
          label: s.string(),
          owners: s.toMany(() => owner),
        })
        .map("g1_favorites");
      const child = s
        .model({
          id: s.int().id().increment(),
          code: s.string().unique(),
          label: s.string(),
          ownerId: s.int().nullable(),
          owner: s
            .toOne(() => owner)
            .fields("ownerId")
            .references("id"),
        })
        .map("g1_children");
      const tag = s
        .model({
          id: s.int().id().increment(),
          code: s.string().unique(),
          label: s.string(),
          owners: s.toMany(() => owner),
        })
        .map("g1_tags");
      const schema = { owner, favorite, child, tag };
      const fresh = recipe.startsWith("fresh-");
      const reparent = recipe === "selected-upsert-reparent";
      const explicitConflict =
        recipe === "selected-upsert-explicit-fk-conflict";
      const missingConnect = recipe === "selected-connect-missing";
      const freshUpsertRefused = recipe === "fresh-upsert-refused";
      const foreignUpsert = recipe === "selected-upsert-foreign";
      const ownedConnect = recipe === "selected-connect-owned";
      const refusal =
        missingConnect ||
        freshUpsertRefused ||
        explicitConflict ||
        foreignUpsert;
      const produces =
        recipe.endsWith("-create") ||
        (recipe.endsWith("-missing") && !missingConnect);
      const changesLabel = recipe.includes("upsert") && !produces;
      const targetId = produces ? 41 : 11;
      const create = {
        ...(foreignUpsert ? { id: 42 } : {}),
        code: "created",
        label: "new",
      };
      const where = { code: missingConnect || produces ? "absent" : "match" };
      const relationInput = {
        ...(recipe.endsWith("-create") ? { create } : {}),
        ...(recipe.includes("-connect-")
          ? { connect: ownedConnect ? [where, where] : where }
          : {}),
        ...(recipe.includes("-coc-")
          ? { connectOrCreate: { where, create } }
          : {}),
        ...(recipe.includes("upsert")
          ? {
              upsert: {
                where,
                create,
                update: {
                  label: "changed",
                  ...(reparent || explicitConflict
                    ? {
                        owner: {
                          connectOrCreate: {
                            where: { id: 3 },
                            create: { id: 3, label: "incoming" },
                          },
                        },
                      }
                    : {}),
                  ...(explicitConflict ? { ownerId: 1 } : {}),
                },
              },
            }
          : {}),
      };
      const favoriteInput = {
        ...(recipe.endsWith("-create") ? { create } : {}),
        ...(recipe.includes("-connect-") ? { connect: where } : {}),
        ...(recipe.includes("-coc-")
          ? { connectOrCreate: { where, create } }
          : {}),
        ...(recipe.includes("upsert")
          ? { upsert: { create, update: { label: "changed" } } }
          : {}),
      };
      const data = {
        label: "requested",
        ...(orientation === "parent" ? { favorite: favoriteInput } : {}),
        ...(orientation === "child" ? { children: relationInput } : {}),
        ...(orientation === "junction" ? { tags: relationInput } : {}),
      };
      const select = { id: true, label: true, favoriteId: true } as const;
      const createArgs = { data: { id: 1, ...data }, select };
      const updateArgs = { where: { id: 1 }, data, select };
      const initialOwners = [
        ...(!fresh
          ? [
              {
                id: 1,
                label: "selected",
                favoriteId: recipe === "selected-upsert-found" ? 11 : null,
              },
            ]
          : []),
        { id: 2, label: "foreign", favoriteId: 11 },
        { id: 3, label: "incoming", favoriteId: null },
      ];
      const targets = [
        { id: 7, code: "decoy", label: "untouched" },
        { id: 11, code: "match", label: "stored" },
      ];
      const initial = {
        owners: initialOwners,
        favorites: targets,
        children: targets.map((target) => ({
          ...target,
          ownerId: (reparent || explicitConflict) && target.id === 11 ? 1 : 2,
        })),
        tags: targets,
        memberships: [
          ...(ownedConnect ? [{ ownerId: 1, tagId: 11 }] : []),
          { ownerId: 2, tagId: 7 },
          { ownerId: 2, tagId: 11 },
        ],
        sequences: ["g1_children", "g1_favorites", "g1_tags"].map((name) => ({
          name,
          seq: 40,
        })),
      };
      const finalTargets = targets.map((target) =>
        target.id === 11 && changesLabel
          ? { ...target, label: "changed" }
          : target
      );
      if (produces)
        finalTargets.push({ id: 41, code: "created", label: "new" });
      const requestedOwner = {
        id: 1,
        label: "requested",
        favoriteId: orientation === "parent" ? targetId : null,
      };
      const final = refusal
        ? initial
        : {
            owners: [
              requestedOwner,
              ...initialOwners.filter((row) => row.id !== 1),
            ],
            favorites: orientation === "parent" ? finalTargets : targets,
            children:
              orientation === "child"
                ? finalTargets.map((target) => ({
                    ...target,
                    ownerId: target.id === targetId ? (reparent ? 3 : 1) : 2,
                  }))
                : initial.children,
            tags: orientation === "junction" ? finalTargets : targets,
            memberships:
              orientation === "junction" && !ownedConnect
                ? [{ ownerId: 1, tagId: targetId }, ...initial.memberships]
                : initial.memberships,
            sequences: initial.sequences.map((row) => ({
              ...row,
              seq:
                produces &&
                row.name ===
                  (orientation === "parent"
                    ? "g1_favorites"
                    : orientation === "child"
                      ? "g1_children"
                      : "g1_tags")
                  ? 41
                  : 40,
            })),
          };
      return {
        publicInput: {
          model: "owner",
          operation: fresh ? "create" : "update",
          args: fresh ? createArgs : updateArgs,
        },
        requiredCuts: [],
        seed(database) {
          database.exec(`
            CREATE TABLE g1_favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL);
            CREATE TABLE g1_owners (id INTEGER PRIMARY KEY, label TEXT NOT NULL, favoriteId INTEGER REFERENCES g1_favorites(id));
            CREATE TABLE g1_children (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL, ownerId INTEGER REFERENCES g1_owners(id));
            CREATE TABLE g1_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL);
            CREATE TABLE g1_owner_tags (ownerId INTEGER NOT NULL REFERENCES g1_owners(id), tagId INTEGER NOT NULL REFERENCES g1_tags(id), PRIMARY KEY(ownerId,tagId));
          `);
          for (const target of targets) {
            database
              .prepare("INSERT INTO g1_favorites VALUES (?,?,?)")
              .run(target.id, target.code, target.label);
            database
              .prepare("INSERT INTO g1_tags VALUES (?,?,?)")
              .run(target.id, target.code, target.label);
          }
          for (const row of initialOwners)
            database
              .prepare("INSERT INTO g1_owners VALUES (?,?,?)")
              .run(row.id, row.label, row.favoriteId);
          for (const row of initial.children)
            database
              .prepare("INSERT INTO g1_children VALUES (?,?,?,?)")
              .run(row.id, row.code, row.label, row.ownerId);
          database.exec(
            "INSERT INTO g1_owner_tags VALUES (2,7),(2,11); UPDATE sqlite_sequence SET seq=40;"
          );
          if (ownedConnect)
            database.exec("INSERT INTO g1_owner_tags VALUES (1,11);");
        },
        async invoke(driver, candidateFactory) {
          if (candidateFactory)
            return candidateFactory({ schema, driver }).execute(
              "owner",
              fresh ? "create" : "update",
              fresh ? createArgs : updateArgs
            );
          const client = createClient({ schema, driver });
          // This runtime contract matrix deliberately includes refused inputs and
          // constructs one mutation bag dynamically. Bridge only these fixture
          // arguments; the real public methods still own admission. This is not a DX probe.
          const publicOwner = client.owner as unknown as {
            create(args: typeof createArgs): Promise<unknown>;
            update(args: typeof updateArgs): Promise<unknown>;
          };
          return fresh
            ? await publicOwner.create(createArgs)
            : await publicOwner.update(updateArgs);
        },
        inspect(database) {
          return {
            owners: database
              .prepare("SELECT * FROM g1_owners ORDER BY id")
              .all(),
            favorites: database
              .prepare("SELECT * FROM g1_favorites ORDER BY id")
              .all(),
            children: database
              .prepare("SELECT * FROM g1_children ORDER BY id")
              .all(),
            tags: database.prepare("SELECT * FROM g1_tags ORDER BY id").all(),
            memberships: database
              .prepare("SELECT * FROM g1_owner_tags ORDER BY ownerId,tagId")
              .all(),
            sequences: database
              .prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")
              .all(),
          };
        },
        assert(observation) {
          assert.deepEqual(observation.initial, initial);
          assert.deepEqual(observation.final, final);
          assert.deepEqual(observation.defaults, []);
          assert.deepEqual(observation.reachedCuts, []);
          if (!refusal) {
            assert.deepEqual(observation.outcome, {
              kind: "success",
              value: requestedOwner,
            });
            return;
          }
          assert.equal(observation.outcome.kind, "failure");
          if (observation.outcome.kind !== "failure") return;
          if (foreignUpsert) {
            const relation = orientation === "child" ? "children" : "tags";
            assert.deepEqual(observation.outcome.failure, {
              name: "NestedWriteError",
              code: "V7001",
              message: `Cannot upsert relation '${relation}': target record was not found for this parent.`,
              meta: Object.assign(Object.create(null), { relation }),
            });
            return;
          }
          assert.equal(
            observation.outcome.failure.name,
            missingConnect ? "NestedWriteError" : "ValidationError"
          );
          if (freshUpsertRefused)
            assert.match(
              observation.outcome.failure.message,
              /Unknown key: upsert/
            );
          if (explicitConflict)
            assert.match(
              observation.outcome.failure.message,
              /Unknown key: ownerId/
            );
          if (missingConnect) {
            assert.equal(observation.outcome.failure.code, "V7001");
            const relation =
              orientation === "parent"
                ? "favorite"
                : orientation === "child"
                  ? "children"
                  : "tags";
            assert.equal(
              observation.outcome.failure.message,
              `Cannot connect relation '${relation}': target record was not found.`
            );
          }
        },
      };
    },
  })
);
