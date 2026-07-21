import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  constructRoutedOperation,
  setV1FallbackDisabled,
} from "../../src/query-engine-v2/routing";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";
import { operationFragmentSchema } from "./create-nested-upsert-behavior";
import {
  FALLBACK_OFF_RESIDUAL,
  FALLBACK_OFF_RESIDUAL_COUNT,
} from "./fallback-off-residual";

/**
 * The decline-surface gate (P6-prerequisite 2, the P6-rerun probe made a committed
 * invariant). The two blocked P6 attempts failed because family-level assertions
 * (route-inventory: "every family is in ROUTED_OPERATIONS") cannot see SHAPE-level
 * declines: a family constructs on V2 for the shapes V2 owns, and hands whole trees
 * to V1 for the shapes it declines with {@link UnsupportedOperationError}. A large
 * subset of those declines are ACCEPT-AND-EXECUTE shapes V1 runs correctly today —
 * reachable behavior living behind the router's V1 fallback arm. P6's deletion
 * premise ("no reachable behavior lives behind the fallback") is therefore an
 * invariant about the decline surface, and this gate machine-checks it.
 *
 * The whole file runs with the V1 fallback DISABLED ({@link setV1FallbackDisabled}
 * — inert in production, engaged only here): a V2 decline RE-THROWS instead of
 * routing to V1, so any shape that secretly depended on the fallback surfaces as a
 * hard failure rather than silently passing through V1.
 *
 * Two halves, both machine-checked:
 *
 *  1. **The absorbed slice carries NO fallback (must pass).** Every create shape V2
 *     owns — including the newly-absorbed child-held one-to-one `create` — executes
 *     end-to-end on V2 with the fallback OFF and persists the correct state. This is
 *     P6's premise proven for the slice it holds. FALSIFY it by re-introducing a
 *     decline for a listed shape (e.g. narrowing the child-held type guard back to
 *     one-to-many only): the corresponding test then throws instead of persisting.
 *
 *  2. **The reachable residual STILL lives behind the fallback (P6 not yet met).**
 *     {@link FALLBACK_OFF_RESIDUAL} (tests/query-engine-v2/fallback-off-residual.ts)
 *     is the MEASURED accept-and-execute + reject-parity decline surface: 43
 *     nested-write-conformance scenarios whose whole tree V2 declines with the
 *     fallback OFF, across EIGHT decline families (parent-held to-one
 *     update/delete/upsert; nested-relation-in-nested-update; m2m
 *     nested-create/update-with-relations; top-level upsert with nested arms;
 *     nested-create-under-update / D4; inverse-side to-one upsert; connectOrCreate
 *     create-arm depth; to-many upsert identity). This CORRECTS the census the gate
 *     carried through T1/T2 — a curated three-then-one to-one pin list that hid the
 *     true surface (the T2 "theater replay" lesson: the census is a run of the FULL
 *     conformance suite fallback-off, not a hand-maintained list). The bidirectional
 *     machine-check is the `VIBORM_FALLBACK_OFF=1` census harness in the conformance
 *     file, now part of `pnpm test:gates`: a pinned scenario MUST decline on both
 *     substrates; a non-pinned one MUST run natively on V2. Below, this gate pins
 *     the census SIZE (so no entry can be silently trimmed) and re-proves one
 *     representative construct-time decline. **P6 may bulk-delete V1's runtime only
 *     when this set is EMPTY. It is not: 43 shapes remain, V1 is NOT deletable.**
 *     The day a family is absorbed, its entries leave FALLBACK_OFF_RESIDUAL, the
 *     count drops by the family size, and those scenarios must then pass
 *     fallback-off natively — both this gate and the conformance census move
 *     together, or the run is red.
 */

// The absorbed create decline surface is exercised end-to-end below. The residual
// is pinned by construction (no I/O needed — a decline is observable at construct
// time). A minimal engine, mirroring route-inventory.test.ts's `pgEngine`.
function pgEngine(schema: Record<string, Model<any>>): QueryEngine {
  hydrateSchemaNames(schema);
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(schema, schemas)
  );
}

async function freshClient(schema: Record<string, Model<any>>) {
  const client = createClient({
    schema,
    driver: new PGliteDriver({ client: new PGlite() }),
  });
  await push(client as never, { force: true } as never);
  return client as any;
}

let previous = false;
beforeAll(() => {
  previous = setV1FallbackDisabled(true);
});
afterAll(() => {
  setV1FallbackDisabled(previous);
});

const opf = operationFragmentSchema;
const nb = nestedWriteBehaviorSchema;
const m2m = manyToManySchema;

// Two parent-held to-one relations on one record, both referencing `account` —
// the sibling-coupling witness the P6-prereq-2 incident lives in. Absorbed in T1
// (TO-ONE.md), so the create-then-connect scenario now executes on V2 with the
// fallback OFF (its own before-parent coverage ledger resolves the connect).
const t1CrossSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.oneToMany(() => record).name("primary"),
      secondaryRecords: s.oneToMany(() => record).name("secondary"),
    })
    .map("decline_gate_cross_accounts");
  const record = s
    .model({
      id: s.int().id(),
      primaryId: s.int().nullable(),
      secondaryId: s.int().nullable(),
      primary: s
        .manyToOne(() => account)
        .fields("primaryId")
        .references("id")
        .name("primary")
        .optional(),
      secondary: s
        .manyToOne(() => account)
        .fields("secondaryId")
        .references("id")
        .name("secondary")
        .optional(),
    })
    .map("decline_gate_cross_records");
  return { account, record };
})();

describe("decline-surface gate: absorbed create shapes carry NO fallback (P6 premise, absorbed slice)", () => {
  test("root scalar create executes on V2 (fallback off)", async () => {
    const c = await freshClient(opf);
    const created = await c.user.create({ data: { name: "root" } });
    expect(created).toMatchObject({ name: "root" });
    await c.$disconnect();
  });

  test("nested child-held to-many create executes on V2 (fallback off)", async () => {
    const c = await freshClient(opf);
    await c.user.create({
      data: {
        name: "with-posts",
        posts: {
          create: [
            { id: 1, title: "t1", slug: "s1" },
            { id: 2, title: "t2", slug: "s2" },
          ],
        },
      },
    });
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts.map((p: { userId: number }) => p.userId)).toEqual([1, 1]);
    await c.$disconnect();
  });

  // The falsification target: this is the shape absorbed in P6-prereq-2. Narrowing
  // the child-held type guard back to one-to-many only makes THIS test throw an
  // UnsupportedOperationError (the fallback that would have hidden it is OFF).
  test("child-held ONE-TO-ONE create executes on V2 (fallback off) — the newly absorbed shape", async () => {
    const c = await freshClient(nb);
    await c.user.create({
      data: {
        id: "u1",
        name: "a",
        profile: { create: { id: "pr1", bio: "b" } },
      },
    });
    const profiles = await c.profile.findMany();
    expect(profiles).toEqual([{ id: "pr1", bio: "b", userId: "u1" }]);
    await c.$disconnect();
  });

  test("nested createMany under create executes on V2 (fallback off)", async () => {
    const c = await freshClient(opf);
    await c.user.create({
      data: {
        name: "cm",
        posts: {
          createMany: {
            data: [
              { id: 3, title: "t3", slug: "s3" },
              { id: 4, title: "t4", slug: "s4" },
            ],
          },
        },
      },
    });
    const posts = await c.post.findMany({ orderBy: { id: "asc" } });
    expect(posts).toHaveLength(2);
    await c.$disconnect();
  });

  test("parent-held to-one connect executes on V2 (fallback off)", async () => {
    const c = await freshClient(opf);
    await c.user.create({ data: { name: "owner" } });
    const post = await c.post.create({
      data: { id: 5, title: "t5", slug: "s5", author: { connect: { id: 1 } } },
      select: { id: true, userId: true },
    });
    expect(post).toEqual({ id: 5, userId: 1 });
    await c.$disconnect();
  });

  // T1: the parent-held to-one `create` family (the before-parent-write ordering),
  // absorbed under create roots. It executes end-to-end on V2 with the fallback
  // OFF — the target INSERTs first, its identity Ref'd into the record FK.
  // Re-narrowing the parent-held type guard back to connect-only makes this throw.
  test("parent-held to-one create executes on V2 (fallback off) — the newly absorbed shape", async () => {
    const c = await freshClient(opf);
    const post = await c.post.create({
      data: {
        id: 6,
        title: "t6",
        slug: "s6",
        author: { create: { name: "x" } },
      },
      select: { id: true, userId: true },
    });
    expect(post).toEqual({ id: 6, userId: 1 });
    await c.$disconnect();
  });

  // T1: THE P6-prereq-2 KILL-SIGNAL INCIDENT, now on V2 with the fallback OFF. A
  // sibling `connect` observing the before-parent `create` of the same target —
  // the construction-time coverage ledger resolves it with no probe. Absorbing
  // parent-held create standalone broke exactly this; disabling the ledger (or
  // re-narrowing the type guard) makes this throw instead of persisting.
  test("INCIDENT: sibling create-then-connect executes on V2 (fallback off)", async () => {
    const c = await freshClient(t1CrossSchema);
    await c.record.create({
      data: {
        id: 1,
        primary: { create: { id: 2, label: "created" } },
        secondary: { connect: { id: 2 } },
      },
    });
    const records = await c.record.findMany();
    expect(records).toEqual([{ id: 1, primaryId: 2, secondaryId: 2 }]);
    await c.$disconnect();
  });

  test("M2M create-through-junction executes on V2 (fallback off)", async () => {
    const c = await freshClient(m2m);
    await c.post.create({
      data: { id: "p1", title: "t", tags: { create: { id: "t1", name: "x" } } },
    });
    const tags = await c.tag.findMany();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ id: "t1", name: "x" });
    await c.$disconnect();
  });

  // T2 (TO-ONE.md §7): the parent-held to-one `connectOrCreate` under UPDATE — a
  // before-root target INSERT (missing arm) or existence guard (found arm) whose
  // FK the root parent UPDATE absorbs. Was residual entry 1; executes on V2 with
  // the fallback OFF. Re-narrowing the parent-held update guard makes this throw.
  test("parent-held connectOrCreate under update executes on V2 (fallback off) — absorbed", async () => {
    const c = await freshClient(opf);
    await c.user.create({ data: { name: "owner" } }); // id=1
    await c.post.create({ data: { id: 6, title: "t6", slug: "s6" } });
    const updated = await c.post.update({
      where: { id: 6 },
      data: {
        author: {
          connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
        },
      },
      select: { id: true, userId: true },
    });
    expect(updated).toEqual({ id: 6, userId: 1 });
    await c.$disconnect();
  });

  // T2 (TO-ONE.md §7): the inverse-side (child-held) to-one `update` — a correlated
  // targeted update whose locator is the FK correlation alone (no unique selector).
  // Was residual entry 2; executes on V2 with the fallback OFF. Re-narrowing the
  // child-held type guard back to one-to-many only makes this throw.
  test("inverse-side to-one update executes on V2 (fallback off) — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "a" } });
    await c.profile.create({ data: { id: "pr1", bio: "old", userId: "u1" } });
    await c.user.update({
      where: { id: "u1" },
      data: { profile: { update: { bio: "new" } } },
    });
    const profiles = await c.profile.findMany();
    expect(profiles).toEqual([{ id: "pr1", bio: "new", userId: "u1" }]);
    await c.$disconnect();
  });

  // T3-r2 (TO-ONE.md §7.2, family F): the inverse-side (child-held) to-one `upsert`
  // — a correlated locate (WHERE fk = parent, no unique selector). Both arms and a
  // second-parent correlation witness: u2's profile must be untouched by u1's
  // upsert (create arm), and by u1's second upsert (update arm). Was residual
  // family F; executes on V2 with the fallback OFF. Re-narrowing the inverse-side
  // upsert case back to the default V1-route makes this throw.
  test("inverse-side to-one upsert executes on V2 (fallback off) — absorbed", async () => {
    const c = await freshClient(nb);
    await c.user.create({ data: { id: "u1", name: "a" } });
    // Correlation witness: a second parent with its own connected profile.
    await c.user.create({ data: { id: "u2", name: "b" } });
    await c.profile.create({
      data: { id: "pr2", bio: "witness", userId: "u2" },
    });

    // Absent arm: no profile correlated to u1 → create it (fk = u1).
    await c.user.update({
      where: { id: "u1" },
      data: {
        profile: {
          upsert: {
            create: { id: "pr1", bio: "created" },
            update: { bio: "x" },
          },
        },
      },
    });
    // Found arm: u1 now has a correlated profile → update it (create arm ignored).
    await c.user.update({
      where: { id: "u1" },
      data: {
        profile: {
          upsert: {
            create: { id: "pr-unused", bio: "nope" },
            update: { bio: "updated" },
          },
        },
      },
    });

    const profiles = await c.profile.findMany({ orderBy: { id: "asc" } });
    expect(profiles).toEqual([
      { id: "pr1", bio: "updated", userId: "u1" },
      // The witness parent's child is untouched — no cross-parent leak.
      { id: "pr2", bio: "witness", userId: "u2" },
    ]);
    await c.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// The reachable accept-and-execute + reject-parity residual: shapes V1 runs (or
// V1-rejects with its own typed message) today but V2 still DECLINES, so the
// router hands their whole tree to V1. The AUTHORITATIVE census is
// {@link FALLBACK_OFF_RESIDUAL} (tests/query-engine-v2/fallback-off-residual.ts):
// 43 nested-write-conformance scenarios, MEASURED by running the FULL conformance
// suite with `VIBORM_FALLBACK_OFF=1` (that run — the bidirectional machine-check
// that these EXACTLY are the fallback carriers — is part of `pnpm test:gates`).
// **P6 may delete V1 only when FALLBACK_OFF_RESIDUAL is EMPTY.** It is not.
//
// This replaces the curated single-entry `FALLBACK_CARRYING_RESIDUAL` the gate
// carried through T1/T2, which understated the surface as "exactly one entry"
// while the measured truth was 43 across eight families (the T2 theater-replay
// lesson). Below: pin the census size (no silent trimming) and re-prove one
// representative shape declines at CONSTRUCTION (no I/O — a decline is observable
// before any effect), so the gate keeps a fast construct-time tripwire alongside
// the full conformance census.
// ---------------------------------------------------------------------------
const REPRESENTATIVE_CONSTRUCT_DECLINE = {
  // Family A — a parent-held (FK-holder-side) to-one `update` under an update root
  // (`post` holds `userId` → `author`). Still declines (`interpretParentHeldToOne`
  // default). Family F, the former representative, was absorbed (T3-r2) and now runs
  // natively, so a still-declining family carries the construct-time tripwire. A
  // construct-time probe: no seed, no execution.
  label: "parent-held to-one update under update root (family A)",
  schema: nb as Record<string, Model<any>>,
  operation: "update",
  args: {
    where: { id: "po1" },
    data: {
      author: { update: { name: "renamed" } },
    },
  } as Record<string, unknown>,
  rootModel: nb.post as Model<any>,
} as const;

describe("decline-surface gate: the reachable residual STILL lives behind the fallback (P6 blocked)", () => {
  test("the fallback-carrying residual is NON-EMPTY — V1 is not deletable", () => {
    // The census is a fact, not prose. When this reaches 0, P6 may delete V1.
    expect(FALLBACK_OFF_RESIDUAL.size).toBeGreaterThan(0);
  });

  test("the census is the MEASURED surface (43), not a curated pin list", () => {
    // Guards against silently trimming the census without a real absorption: the
    // set and its declared count must agree, and the count is the T3 measurement.
    // Absorbing a family drops BOTH by the same amount (and its scenarios must then
    // pass the fallback-off conformance run). 43 corrects the T1/T2 "one entry".
    expect(FALLBACK_OFF_RESIDUAL.size).toBe(FALLBACK_OFF_RESIDUAL_COUNT);
    expect(FALLBACK_OFF_RESIDUAL_COUNT).toBe(42);
  });

  test(`still declines at construction (routes to V1): ${REPRESENTATIVE_CONSTRUCT_DECLINE.label}`, () => {
    const shape = REPRESENTATIVE_CONSTRUCT_DECLINE;
    const engine = pgEngine(shape.schema);
    // Fallback disabled: a decline RE-THROWS, so a shape that still routes to V1
    // surfaces its UnsupportedOperationError here rather than returning undefined.
    expect(() =>
      constructRoutedOperation(
        engine,
        shape.rootModel,
        shape.operation,
        shape.args
      )
    ).toThrow(UnsupportedOperationError);
  });
});
