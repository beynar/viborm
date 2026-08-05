// biome-ignore-all lint/suspicious/noMisplacedAssertion: `expectParseBoundaryAnswersFirst`
// is the shared witness assertion of this whole file and is invoked only from test cases.
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import {
  NestedWriteError,
  QueryEngineError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { RelationInfo } from "@query-engine/types";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import {
  constructRoutedOperation,
  ROUTED_OPERATIONS,
} from "../../src/query-engine/write-engine/routing";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * N7-U-A — THE CONVERSION WITNESSES.
 *
 * The final census-floor audit (PLAN "The floor — final census disposition") found 25 of
 * the 68 `UnsupportedOperationError` sites in `src/query-engine/write-engine/*.ts` refusing NOTHING:
 * a defensive type guard, an `unknown -> Record` narrowing, or the `default:` arm of a
 * switch total over the parse boundary's own key set. 23 were converted to
 * `QueryEngineError` internal invariants (the N2-U1 / X1c disposition — a branch
 * unreachable BY CONSTRUCTION is not a capability boundary), dropping the census pin
 * 68 -> 45. TWO of the 25 were re-measured as REACHABLE and kept.
 *
 * THE CONVERSION LAW (this repo's own precedent, route-inventory.test.ts): *"a conversion
 * owes a behavioral witness of the shape, not just a reachability argument."* This file is
 * that debt, paid site by site, so the family is auditable in one place:
 *
 *   · Nineteen sites HAVE a public spelling. Each gets a test that feeds the shape through
 *     the PUBLIC client surface — `await client.<model>.<op>(payload)`, the same path
 *     `PendingOperation` walks — and asserts the class that answers FIRST is the parse
 *     boundary's `ValidationError` (or, for the mismatched-arity edge, the upstream
 *     `NestedWriteError` the own-write analyzer raises), never the converted site. Each also asserts it is NOT an
 *     `UnsupportedOperationError`, which is the claim the census pin now encodes.
 *
 *   · Four sites have NO public spelling at all (`UpdateOperation` :622 / :1202,
 *     `nested-target-parts` :308, `ReadOperation` :90). The law's own escape clause
 *     covers them — "or names the structural invariant when no public spelling exists" —
 *     so they are pinned STRUCTURALLY: the invariant that makes them unreachable is
 *     asserted directly, and the assertion fails the day the invariant does.
 *
 * TWO sites are deliberately absent, because their (c-i) claims FAILED re-verification:
 * `CreateOperation` :822 and `RelationUpsertPart` :708. Their witnesses are here too, at
 * the bottom — REACHABILITY tests asserting they still throw `UnsupportedOperationError`,
 * pinning the reclassification so the next reader cannot mistake either for a converted
 * site.
 */

// Top-level so Biome's `useTopLevelRegex` rule is satisfied — every witness below matches
// one of the parse boundary's own answers.
const EXPECTED_OBJECT = /Expected object/;
const EXPECTED_BOOLEAN = /Expected boolean/;
const NO_UNION_MEMBER = /did not match any union member/;
const MISSING_REQUIRED = /Missing required field/;
const NO_UNIQUE_DISCRIMINATOR = /requires at least one unique discriminator/;
const MISMATCHED_FK = /mismatched foreign-key metadata/;
const NEEDS_PLANNED_PARENT = /requires a planned parent id/;
const NON_NULLABLE_PK = /Expected integer|Expected object/;
const NOT_A_READ_BASE = /is not a read base/;
// E3 — the upsert UPDATE arm's direction boundary replaced the child-held adopt
// builder's relation-type gate as the answer a parent-held to-one grandchild meets.
const ARM_EDGE_IS_PARENT_HELD =
  /does not support a parent-held to-one write on relation .* one level deeper on the update arm/;

const schemas = createSchemaRegistry(nestedWriteBehaviorSchema);

/** The public client surface, on an in-memory PGlite. Every payload below is refused at
 *  CONSTRUCTION — before any I/O — so no table has to exist for the witness to hold. */
function publicClient(
  schema: Record<string, Model<any>> = nestedWriteBehaviorSchema
) {
  return createClient({ schema, driver: new PGliteDriver() } as any) as any;
}

/** The routing seam production's `PendingOperation.resolveOperation` calls. Used only
 *  where a purpose-built schema has no client fixture. */
function routedEngine(schema: Record<string, Model<any>>) {
  hydrateSchemaNames(schema);
  return new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

/** The refusal a payload actually meets, as a class + message — never swallowed. */
async function refusalOf(run: () => unknown): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error(
    "the payload CONSTRUCTED: the shape this witness claims is unreachable now reaches the engine"
  );
}

/**
 * The whole point, in one assertion: the parse boundary answers first, so the converted
 * site never sees this payload — and in particular the answer is NOT the
 * `UnsupportedOperationError` the census used to count here.
 */
async function expectParseBoundaryAnswersFirst(
  run: () => unknown,
  messageFragment: string | RegExp
): Promise<void> {
  const error = await refusalOf(run);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).not.toBeInstanceOf(UnsupportedOperationError);
  expect(error.message).toMatch(messageFragment);
}

// ---------------------------------------------------------------------------
// A local PK-less model. Three converted sites read `getPrimaryKeyFields(model)` and
// refuse an empty list; §3.A A16 says no such model is legal, and the where-unique parse
// says so first (a PK-less whereUnique has no discriminator to require).
// ---------------------------------------------------------------------------
const pkLessSchema = (() => {
  const note = s
    .model({ label: s.string(), body: s.string() })
    .map("n7_pkless_notes");
  return { note };
})();

// ---------------------------------------------------------------------------
// A junction whose TARGET primary key carries `autoGenerate: "now"` — the one spelling
// the audit's `resolveCreatePk` probe had NOT constructed. `.now()` implies a default, so
// the boundary fills the key and the create arm resolves an identity.
// ---------------------------------------------------------------------------
const nowPkJunctionSchema = (() => {
  const doc: any = s
    .model({
      id: s.string().id(),
      title: s.string(),
      marks: s.manyToMany(() => mark),
    })
    .map("n7_now_docs");
  const mark: any = s
    .model({
      id: s.dateTime().id().now(),
      name: s.string(),
      docs: s.manyToMany(() => doc),
    })
    .map("n7_now_marks");
  return { doc, mark };
})();

// ---------------------------------------------------------------------------
// A junction whose TARGET primary key carries NO default at all — the other end of the
// same enumeration: the boundary makes such a key REQUIRED, so it answers first.
// ---------------------------------------------------------------------------
const requiredPkJunctionSchema = (() => {
  const page: any = s
    .model({
      id: s.string().id(),
      title: s.string(),
      stamps: s.manyToMany(() => stamp),
    })
    .map("n7_req_pages");
  const stamp: any = s
    .model({
      id: s.int().id(),
      name: s.string(),
      pages: s.manyToMany(() => page),
    })
    .map("n7_req_stamps");
  return { page, stamp };
})();

// ---------------------------------------------------------------------------
// A child FK whose arity does NOT match its references — the second half of
// `RelationUpsertPart`'s child-held-FK invariant.
// ---------------------------------------------------------------------------
const mismatchedAritySchema = (() => {
  const owner: any = s
    .model({ id: s.string().id(), kids: s.oneToMany(() => kid) })
    .map("n7_arity_owners");
  const kid: any = s
    .model({
      id: s.string().id(),
      ownerA: s.string(),
      ownerB: s.string(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerA", "ownerB")
        .references("id"),
    })
    .map("n7_arity_kids");
  return { owner, kid };
})();

// ---------------------------------------------------------------------------
// A `manyToOne` declared WITHOUT `.fields()` — the shape that FALSIFIED
// `CreateOperation` :822's "schema impossibility" claim.
// ---------------------------------------------------------------------------
const fieldsLessManyToOneSchema = (() => {
  const left: any = s
    .model({
      id: s.string().id(),
      name: s.string(),
      // No `.fields()`: `holdsFK` is false, `type` stays "manyToOne".
      inverse: s.manyToOne(() => right).optional(),
    })
    .map("n7_inverse_lefts");
  const right: any = s
    .model({
      id: s.string().id(),
      title: s.string(),
      leftId: s.string().nullable(),
      left: s
        .manyToOne(() => left)
        .fields("leftId")
        .references("id")
        .optional(),
    })
    .map("n7_inverse_rights");
  return { left, right };
})();

describe("N7-U-A (c-i) conversion witnesses — CreateOperation", () => {
  test(":892 — a to-one kind outside create/connect/connectOrCreate under a create root", async () => {
    const client = publicClient();
    for (const kind of ["update", "delete", "disconnect", "upsert", "set"]) {
      await expectParseBoundaryAnswersFirst(
        () =>
          client.post.create({
            data: { id: "p", title: "t", author: { [kind]: { id: "u" } } },
          }),
        `Unknown key: ${kind}`
      );
    }
  });

  test(":1194 — a nested kind outside the five create-tree kinds on a child-held to-many", async () => {
    const client = publicClient();
    for (const kind of [
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "set",
      "disconnect",
    ]) {
      await expectParseBoundaryAnswersFirst(
        () =>
          client.user.create({
            data: {
              id: "u",
              name: "n",
              posts: { [kind]: { where: { id: "p" }, data: { title: "x" } } },
            },
          }),
        `Unknown key: ${kind}`
      );
    }
    // `upsert` is a to-many key the create factory does not offer; the boundary refuses it
    // through the relation union rather than by name.
    await expectParseBoundaryAnswersFirst(
      () =>
        client.user.create({
          data: {
            id: "u",
            name: "n",
            posts: { upsert: { where: { id: "p" }, update: { title: "x" } } },
          },
        }),
      NO_UNION_MEMBER
    );
  });

  test(":1843 — a non-record to-one connect target under create", async () => {
    const client = publicClient();
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.create({
          data: { id: "p", title: "t", author: { connect: 5 } },
        }),
      EXPECTED_OBJECT
    );
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.create({
          data: { id: "p", title: "t", author: { connect: [5] } },
        }),
      EXPECTED_OBJECT
    );
  });

  test(":1867 — every requireRecord caller on the create path", async () => {
    const client = publicClient();
    // The relation payload itself (`interpretRelation`'s `relationInput`).
    await expectParseBoundaryAnswersFirst(
      () => client.user.create({ data: { id: "u", name: "n", posts: 5 } }),
      EXPECTED_OBJECT
    );
    // `connectOrCreate.where` and `.create`.
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.create({
          data: {
            id: "p",
            title: "t",
            author: {
              connectOrCreate: { where: 5, create: { id: "u", name: "n" } },
            },
          },
        }),
      EXPECTED_OBJECT
    );
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.create({
          data: {
            id: "p",
            title: "t",
            author: { connectOrCreate: { where: { id: "u" }, create: 5 } },
          },
        }),
      EXPECTED_OBJECT
    );
    // The nested `createMany` envelope.
    await expectParseBoundaryAnswersFirst(
      () =>
        client.user.create({
          data: { id: "u", name: "n", posts: { createMany: 5 } },
        }),
      EXPECTED_OBJECT
    );
  });
});

describe("N7-U-A (c-i) conversion witnesses — UpdateOperation", () => {
  test(":489 — a model with no primary key, at the update root", async () => {
    const client = publicClient(pkLessSchema);
    await expectParseBoundaryAnswersFirst(
      () => client.note.update({ where: { label: "x" }, data: { body: "y" } }),
      MISSING_REQUIRED
    );
    await expectParseBoundaryAnswersFirst(
      () => client.note.update({ where: {}, data: { body: "y" } }),
      NO_UNIQUE_DISCRIMINATOR
    );
  });

  test(":1738 — ALL ELEVEN to-many kinds construct, so the default arm is unreachable", async () => {
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(nestedWriteBehaviorSchema, schemas)
    );
    const kinds: Record<string, unknown> = {
      create: { id: "p", title: "t" },
      createMany: { data: [{ id: "p", title: "t" }] },
      connect: { id: "p" },
      connectOrCreate: { where: { id: "p" }, create: { id: "p", title: "t" } },
      disconnect: { id: "p" },
      set: { id: "p" },
      update: { where: { id: "p" }, data: { title: "x" } },
      updateMany: { where: { id: "p" }, data: { title: "x" } },
      delete: { id: "p" },
      deleteMany: { id: "p" },
      upsert: {
        where: { id: "p" },
        create: { id: "p", title: "t" },
        update: { title: "x" },
      },
    };
    expect(Object.keys(kinds)).toHaveLength(11);
    for (const [kind, payload] of Object.entries(kinds)) {
      expect(
        constructRoutedOperation(
          engine,
          nestedWriteBehaviorSchema.user,
          "update",
          { where: { id: "u" }, data: { posts: { [kind]: payload } } }
        ),
        `to-many kind '${kind}' must construct, or the default arm is reachable`
      ).toBeDefined();
    }
  });

  test(":2248 — a to-many-only kind on a parent-held to-one", async () => {
    const client = publicClient();
    for (const kind of ["set", "createMany", "updateMany", "deleteMany"]) {
      await expectParseBoundaryAnswersFirst(
        () =>
          client.post.update({
            where: { id: "p" },
            data: { author: { [kind]: { id: "u" } } },
          }),
        `Unknown key: ${kind}`
      );
    }
  });

  test(":3265 — interpretToOneLink reached with a kind other than connect/disconnect", async () => {
    const client = publicClient();
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.update({
          where: { id: "p" },
          data: { author: { set: { id: "u" } } },
        }),
      "Unknown key: set"
    );
  });

  test(":3589 / :3595 — multiple targets and a non-record target on a to-one link", async () => {
    const client = publicClient();
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.update({
          where: { id: "p" },
          data: { author: { connect: [{ id: "a" }, { id: "b" }] } },
        }),
      EXPECTED_OBJECT
    );
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.update({
          where: { id: "p" },
          data: { author: { disconnect: [{ id: "a" }, { id: "b" }] } },
        }),
      EXPECTED_BOOLEAN
    );
    await expectParseBoundaryAnswersFirst(
      () =>
        client.post.update({
          where: { id: "p" },
          data: { author: { connect: 5 } },
        }),
      EXPECTED_OBJECT
    );
  });

  test(":3612 — requireRecord(args.where / args.data) behind the whole-args parse", async () => {
    const client = publicClient();
    await expectParseBoundaryAnswersFirst(
      () => client.user.update({ where: 5, data: { name: "x" } }),
      EXPECTED_OBJECT
    );
    await expectParseBoundaryAnswersFirst(
      () => client.user.update({ where: { id: "u" }, data: 5 }),
      EXPECTED_OBJECT
    );
    // The same helper's other callers: every nested to-one arm's `update` / `upsert` /
    // `create` / `connectOrCreate` slot.
    for (const payload of [
      { author: { update: 5 } },
      { author: { upsert: 5 } },
      { author: { upsert: { update: 5, create: { id: "u", name: "n" } } } },
      { author: { create: 5 } },
      { author: { connectOrCreate: 5 } },
    ]) {
      await expectParseBoundaryAnswersFirst(
        () => client.post.update({ where: { id: "p" }, data: payload }),
        EXPECTED_OBJECT
      );
    }
  });

  test(":622 / :1202 — STRUCTURAL: no public spelling exists", () => {
    // :622 — `separated.relations` is keyed by the model's own relation set and
    // `parentSchemas.relations` is built from THE SAME set (`getRelationsSchemas` iterates
    // `source["~"].state.relations`). A relation the payload can name always has a schema.
    for (const [modelName, model] of Object.entries(
      nestedWriteBehaviorSchema
    )) {
      const registered = schemas.getModelSchemas(model as Model<any>).relations;
      for (const relationName of Object.keys(
        (model as any)["~"].state.relations ?? {}
      )) {
        expect(
          (registered as Record<string, unknown>)[relationName],
          `${modelName}.${relationName} must have a registered relation schema`
        ).toBeDefined();
      }
    }
    // :1202 (and its depth twin, nested-target-parts :308) — the guard asks
    // `!(isToOne || type === "oneToMany")` on a relation that is neither many-to-many
    // (dispatched to the junction above) nor parent-held (dispatched to the to-one
    // family). `RelationInfo["type"]` is a closed four-member union, and every member
    // that can arrive satisfies the predicate, so the guard is false for all of them.
    const types: RelationInfo["type"][] = [
      "oneToOne",
      "oneToMany",
      "manyToOne",
      "manyToMany",
    ];
    for (const type of types) {
      const dispatchedAway = type === "manyToMany";
      const isToOne = type === "oneToOne" || type === "manyToOne";
      expect(
        dispatchedAway || isToOne || type === "oneToMany",
        `relation type '${type}' must be dispatched away or admitted by the child-held gate`
      ).toBe(true);
    }
    // The same claim, on live schema metadata rather than on the union alone: every
    // relation in both fixture corpora is m2m, to-one, or one-to-many.
    for (const corpus of [nestedWriteBehaviorSchema, manyToManySchema]) {
      for (const model of Object.values(corpus)) {
        for (const relation of Object.values(
          (model as any)["~"].state.relations ?? {}
        )) {
          const relationType = (relation as any)["~"].state.type as
            | RelationInfo["type"]
            | undefined;
          if (!relationType) continue;
          expect(types).toContain(relationType);
        }
      }
    }
  });
});

describe("N7-U-A (c-i) conversion witnesses — the Part builders", () => {
  test("RelationUpsertPart :708 — the ROOT dispatches direction before the builder", async () => {
    const client = publicClient();
    // Under CREATE, the inverse-side to-one has no `upsert` arm at all: the parse boundary
    // answers before any builder runs.
    await expectParseBoundaryAnswersFirst(
      () =>
        client.user.create({
          data: {
            id: "u",
            name: "n",
            profile: {
              upsert: { create: { id: "pr", bio: "b" }, update: { bio: "c" } },
            },
          },
        }),
      "Unknown key: upsert"
    );
    // Under UPDATE, the same shape is DISPATCHED (T3-r2's `buildInverseToOneUpsertPart`)
    // rather than refused, and the inverse to-one's `connectOrCreate` is the arm :708
    // explicitly admits. This is the half of the audit's claim that HOLDS — the half that
    // does not is pinned at the bottom of this file.
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(nestedWriteBehaviorSchema, schemas)
    );
    for (const payload of [
      {
        profile: {
          upsert: { create: { id: "pr", bio: "b" }, update: { bio: "c" } },
        },
      },
      {
        profile: {
          connectOrCreate: {
            where: { id: "pr" },
            create: { id: "pr", bio: "b" },
          },
        },
      },
    ]) {
      expect(
        constructRoutedOperation(
          engine,
          nestedWriteBehaviorSchema.user,
          "update",
          { where: { id: "u" }, data: payload }
        )
      ).toBeDefined();
    }
  });

  test("RelationUpsertPart :814 — a mismatched-arity child FK is refused UPSTREAM", async () => {
    const client = publicClient(mismatchedAritySchema);
    for (const payload of [
      {
        kids: {
          upsert: { where: { id: "k" }, create: { id: "k" }, update: {} },
        },
      },
      {
        kids: { connectOrCreate: { where: { id: "k" }, create: { id: "k" } } },
      },
    ]) {
      const error = await refusalOf(() =>
        client.owner.update({ where: { id: "o" }, data: payload })
      );
      // The relation-mutation legality walk runs before any Part is built.
      expect(error).toBeInstanceOf(NestedWriteError);
      expect(error).not.toBeInstanceOf(UnsupportedOperationError);
      expect(error.message).toMatch(MISMATCHED_FK);
    }
    // The :708 lesson applied here: a "no reachable payload" claim is only as strong as
    // the caller list, and the GRANDCHILD fold is the caller that was missing from :708's.
    // The own-write analyzer walks the WHOLE tree before any Part is built, so the deeper
    // spelling is refused by the same legality walk, at the same place in time.
    const deep = await refusalOf(() =>
      client.owner.update({
        where: { id: "o" },
        data: {
          kids: {
            update: {
              where: { id: "k" },
              data: {
                owner: {
                  connectOrCreate: {
                    where: { id: "o2" },
                    create: { id: "o2" },
                  },
                },
              },
            },
          },
        },
      })
    );
    expect(deep).not.toBeInstanceOf(UnsupportedOperationError);
    expect(deep.message).toMatch(MISMATCHED_FK);
  });

  test("RelationUpsertPart :1134 / :1144 — the upsert-item narrowings", async () => {
    const client = publicClient();
    for (const payload of [
      { posts: { upsert: 5 } },
      { posts: { upsert: [5] } },
      { posts: { connectOrCreate: 5 } },
      {
        posts: {
          upsert: {
            where: 5,
            create: { id: "p", title: "t" },
            update: { title: "x" },
          },
        },
      },
      {
        posts: {
          upsert: { where: { id: "p" }, create: 5, update: { title: "x" } },
        },
      },
      {
        posts: {
          upsert: {
            where: { id: "p" },
            create: { id: "p", title: "t" },
            update: 5,
          },
        },
      },
    ]) {
      await expectParseBoundaryAnswersFirst(
        () => client.user.update({ where: { id: "u" }, data: payload }),
        EXPECTED_OBJECT
      );
    }
  });

  test("RelationJunctionPart :1199 — every spelling of a junction target's primary key", async () => {
    // (a) A generated-but-DEFAULTED key (`autoGenerate: "now"`) — the spelling the audit's
    //     probe had not constructed. The boundary fills it, so the arm resolves.
    const nowEngine = routedEngine(nowPkJunctionSchema);
    expect(
      constructRoutedOperation(nowEngine, nowPkJunctionSchema.doc, "update", {
        where: { id: "d" },
        data: { marks: { create: { name: "m" } } },
      })
    ).toBeDefined();
    expect(
      constructRoutedOperation(nowEngine, nowPkJunctionSchema.doc, "create", {
        data: { id: "d", title: "t", marks: { create: { name: "m" } } },
      })
    ).toBeDefined();
    // (b) A key with NO default is REQUIRED: the boundary answers first.
    const requiredEngine = routedEngine(requiredPkJunctionSchema);
    await expectParseBoundaryAnswersFirst(
      () =>
        constructRoutedOperation(
          requiredEngine,
          requiredPkJunctionSchema.page,
          "update",
          {
            where: { id: "p" },
            data: { stamps: { create: { name: "x" } } },
          }
        ),
      MISSING_REQUIRED
    );
    // (c) An explicit `null` fails the non-nullable primary key.
    await expectParseBoundaryAnswersFirst(
      () =>
        constructRoutedOperation(
          requiredEngine,
          requiredPkJunctionSchema.page,
          "update",
          {
            where: { id: "p" },
            data: { stamps: { create: { id: null, name: "x" } } },
          }
        ),
      NON_NULLABLE_PK
    );
    // (d) An `increment` key takes the produced-identity branch ABOVE the converted line
    //     (`manyToManySchema.label` is auto-increment), so it does not reach it either.
    const m2mEngine = routedEngine(manyToManySchema);
    expect(
      constructRoutedOperation(m2mEngine, manyToManySchema.article, "update", {
        where: { id: 1 },
        data: { labels: { create: { name: "x" } } },
      })
    ).toBeDefined();
  });

  test("RelationWritePart :439 — the owned FK spelled in a nested upsert CREATE arm", async () => {
    const client = publicClient();
    await expectParseBoundaryAnswersFirst(
      () =>
        client.user.update({
          where: { id: "u" },
          data: {
            posts: {
              upsert: {
                where: { id: "p" },
                create: { id: "p", title: "t", userId: "u" },
                update: { title: "x" },
              },
            },
          },
        }),
      "Unknown key: userId"
    );
  });

  test("nested-target-parts :573 — ALL ELEVEN kinds are handled one level deeper", () => {
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(nestedWriteBehaviorSchema, schemas)
    );
    const kinds: Record<string, unknown> = {
      create: { id: "pt", tagId: "t" },
      createMany: { data: [{ id: "pt", tagId: "t" }] },
      connect: { id: "pt" },
      connectOrCreate: {
        where: { id: "pt" },
        create: { id: "pt", tagId: "t" },
      },
      disconnect: { id: "pt" },
      set: { id: "pt" },
      update: { where: { id: "pt" }, data: { tagId: "t" } },
      updateMany: { where: { id: "pt" }, data: { tagId: "t" } },
      delete: { id: "pt" },
      deleteMany: { id: "pt" },
      upsert: {
        where: { id: "pt" },
        create: { id: "pt", tagId: "t" },
        update: { tagId: "t" },
      },
    };
    expect(Object.keys(kinds)).toHaveLength(11);
    for (const [kind, payload] of Object.entries(kinds)) {
      let refusal: unknown;
      try {
        constructRoutedOperation(
          engine,
          nestedWriteBehaviorSchema.user,
          "update",
          {
            where: { id: "u" },
            data: {
              posts: {
                update: {
                  where: { id: "p" },
                  data: { postTags: { [kind]: payload } },
                },
              },
            },
          }
        );
      } catch (error) {
        refusal = error;
      }
      // Either the kind constructs, or it meets a DIFFERENT already-classified guard
      // inside the built Part (`set` / `disconnect` need a planned parent id). Neither is
      // the deleted `default:` arm, and neither is an `UnsupportedOperationError`.
      if (refusal) {
        expect(refusal, `kind '${kind}'`).toBeInstanceOf(QueryEngineError);
        expect(refusal).not.toBeInstanceOf(UnsupportedOperationError);
        expect((refusal as Error).message).toMatch(NEEDS_PLANNED_PARENT);
      }
    }
  });
});

describe("N7-U-A (c-i) conversion witnesses — the roots", () => {
  test("UpsertOperation :207 / DeleteOperation :89 — a model with no primary key", async () => {
    const client = publicClient(pkLessSchema);
    await expectParseBoundaryAnswersFirst(
      () =>
        client.note.upsert({
          where: { label: "x" },
          create: { label: "x", body: "y" },
          update: { body: "z" },
        }),
      MISSING_REQUIRED
    );
    await expectParseBoundaryAnswersFirst(
      () => client.note.delete({ where: { label: "x" } }),
      MISSING_REQUIRED
    );
  });

  test("ReadOperation :90 — STRUCTURAL: the routed read set is a subset of the read bases", () => {
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(nestedWriteBehaviorSchema, schemas)
    );
    // Every routed name either constructs or refuses for a reason of its own — none of
    // them reaches "is not a read base", because `constructOperation` only builds a
    // `ReadOperation` for names in its own read set.
    for (const operation of ROUTED_OPERATIONS) {
      let refusal: unknown;
      try {
        constructRoutedOperation(
          engine,
          nestedWriteBehaviorSchema.user,
          operation,
          operation === "create"
            ? { data: { id: "u", name: "n" } }
            : operation === "upsert"
              ? {
                  where: { id: "u" },
                  create: { id: "u", name: "n" },
                  update: { name: "n" },
                }
              : operation === "createMany"
                ? { data: [{ id: "u", name: "n" }] }
                : { where: { id: "u" }, data: { name: "n" } }
        );
      } catch (error) {
        refusal = error;
      }
      if (refusal) {
        expect(
          (refusal as Error).message,
          `routed operation '${operation}'`
        ).not.toMatch(NOT_A_READ_BASE);
      }
    }
    // A name OUTSIDE the routed set never reaches an operation constructor at all.
    expect(
      constructRoutedOperation(
        engine,
        nestedWriteBehaviorSchema.user,
        "findManyOrThrow",
        {}
      )
    ).toBeUndefined();
    expect(ROUTED_OPERATIONS.has("findManyOrThrow")).toBe(false);
  });
});

describe("N7-U-A — the TWO (c-i) claims that failed re-verification", () => {
  /**
   * DELIBERATE RETARGET (E4-U1). `CreateOperation` :822's comment called this "a schema
   * impossibility … kept as a defensive internal guard". N7-U-A overturned that: a
   * `manyToOne` with no `.fields()` reached it, and the SAME relation constructed under
   * `update`, down the very child-held path the create root withheld. The site was
   * reclassified (c-ii) and this test measured the ASYMMETRY that made the
   * reclassification honest.
   *
   * E4-U1 discharged it. The asymmetry is gone — the create root now builds the same
   * child-held arms the update root always did — so what this test pins is the other
   * half of the same claim: BOTH roots construct, and the payload the census counted is
   * a payload the engine answers. The class assertion survives in its own form: no
   * refusal at all, rather than a refusal of a different class.
   */
  test("CreateOperation :822 is ABSORBED — a fields-less manyToOne constructs at both roots", () => {
    const engine = routedEngine(fieldsLessManyToOneSchema);
    expect(
      constructRoutedOperation(
        engine,
        fieldsLessManyToOneSchema.left,
        "create",
        {
          data: {
            id: "l",
            name: "n",
            inverse: { create: { id: "r", title: "t" } },
          },
        }
      )
    ).toBeDefined();
    expect(
      constructRoutedOperation(
        engine,
        fieldsLessManyToOneSchema.left,
        "update",
        {
          where: { id: "l" },
          data: { inverse: { create: { id: "r", title: "t" } } },
        }
      )
    ).toBeDefined();
  });

  /**
   * DELIBERATE RETARGET (E3-U4). `RelationUpsertPart` :708 was filed "no reachable
   * payload identified", and N7-U-A's re-verification overturned that: `buildArmChildParts`
   * — the GRANDCHILD fold on an upsert's UPDATE arm — dispatched on the KIND alone and
   * handed any `connectOrCreate` to `buildConnectOrCreateParts` with the direction
   * unexamined, so a PARENT-HELD to-one grandchild arrived there with
   * `type === "manyToOne"`.
   *
   * E3 removed that kind dispatch. The arm now routes by DIRECTION first, through the
   * same located-target seam every other located-target caller uses, so the wrong
   * `relationInfo.type` no longer reaches the child-held adopt builder — its type gate is
   * an engine invariant again, and the (c-i) claim it lost is restored WITH the reason.
   *
   * This payload is still refused, still typed, and still at construction — that is what
   * this witness keeps pinning. Only WHICH boundary answers changed: the parent-held
   * direction now has its own wording at the arm (`assertArmEdgeIsChildHeld`), which says
   * the thing the caller can act on — the arm's own row holds that foreign key, so the
   * write belongs in the arm's UPDATE SET. The class assertion below is the load-bearing
   * half: an absorption may not turn a typed refusal into an internal error, and this
   * proves it did not.
   */
  test("the parent-held to-one connectOrCreate on an upsert update arm is refused by DIRECTION", () => {
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(nestedWriteBehaviorSchema, schemas)
    );
    let refusal: unknown;
    try {
      constructRoutedOperation(
        engine,
        nestedWriteBehaviorSchema.user,
        "update",
        {
          where: { id: "u" },
          data: {
            posts: {
              upsert: [
                {
                  where: { id: "p" },
                  create: { id: "p", title: "t" },
                  update: {
                    author: {
                      connectOrCreate: {
                        where: { id: "u2" },
                        create: { id: "u2", name: "n2" },
                      },
                    },
                  },
                },
              ],
            },
          },
        }
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UnsupportedOperationError);
    expect((refusal as Error).message).toMatch(ARM_EDGE_IS_PARENT_HELD);
  });
});
