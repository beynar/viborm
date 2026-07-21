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
 *     {@link FALLBACK_CARRYING_RESIDUAL} enumerates the reachable accept-and-execute
 *     shapes V2 still declines. T1 (TO-ONE.md) absorbed the parent-held to-one
 *     `create` family under CREATE roots (including the create-then-connect
 *     incident — now in the absorbed slice above), so the residual is the
 *     remaining UPDATE/UPSERT-root to-one decline surface (T2/T3): parent-held
 *     to-one `connectOrCreate` under update, inverse-side to-one `update`/`upsert`
 *     arms. Each is asserted to STILL decline, so the census is a falsifiable fact,
 *     not prose. **P6 may bulk-delete V1's runtime only when this list is EMPTY.**
 *     It is not empty: V1 remains reachable and is NOT deletable. The day a shape is
 *     absorbed, it moves from the residual half to the absorbed half — both this
 *     gate and the route-inventory census move together.
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
      data: { id: 6, title: "t6", slug: "s6", author: { create: { name: "x" } } },
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
});

// ---------------------------------------------------------------------------
// The reachable accept-and-execute residual: shapes V1 runs correctly today but
// V2 still DECLINES, so the router hands their whole tree to V1. Each entry is a
// constructor whose decline is asserted below. **P6 may delete V1 only when this
// list is EMPTY.** It is not — these are the create/update/upsert decline surface
// the 56 fallback-disabled conformance failures measured.
// ---------------------------------------------------------------------------
interface ResidualShape {
  readonly label: string;
  readonly schema: Record<string, Model<any>>;
  readonly operation: string;
  readonly args: Record<string, unknown>;
  readonly rootModel: Model<any>;
}

const FALLBACK_CARRYING_RESIDUAL: readonly ResidualShape[] = [
  // NOTE (T1, TO-ONE.md): "parent-held to-one create (before-parent-write
  // ordering)" — the own-write-entangled boundary the P6-prereq-2 incident named
  // — is now ABSORBED under create roots (the construction-time before-parent
  // coverage ledger resolves the sibling connect). It moved from this residual to
  // the absorbed-slice describe above (the create-then-connect INCIDENT test).
  // The remaining residual is the UPDATE/UPSERT-root to-one decline surface (T2/T3).
  {
    label: "parent-held to-one connectOrCreate under update",
    schema: opf,
    operation: "update",
    args: {
      where: { id: 6 },
      data: {
        author: {
          connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
        },
      },
    },
    rootModel: opf.post,
  },
  {
    label: "inverse-side to-one update (child holds FK)",
    schema: nb,
    operation: "update",
    args: {
      where: { id: "u1" },
      data: { profile: { update: { bio: "new" } } },
    },
    rootModel: nb.user,
  },
  {
    label: "inverse-side to-one upsert (nested-relation arm)",
    schema: nb,
    operation: "update",
    args: {
      where: { id: "u1" },
      data: {
        profile: {
          upsert: {
            create: { id: "pr1", bio: "b" },
            update: { bio: "u" },
          },
        },
      },
    },
    rootModel: nb.user,
  },
];

describe("decline-surface gate: the reachable residual STILL lives behind the fallback (P6 blocked)", () => {
  test("the fallback-carrying residual is NON-EMPTY — V1 is not deletable", () => {
    // The census is a fact, not prose. When this reaches 0, P6 may delete V1.
    expect(FALLBACK_CARRYING_RESIDUAL.length).toBeGreaterThan(0);
  });

  for (const shape of FALLBACK_CARRYING_RESIDUAL) {
    test(`still declines (routes to V1): ${shape.label}`, () => {
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
  }
});
