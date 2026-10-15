/**
 * Composition (RBAC plan K7, §4.7 as amended by spike F6 in §11.2; OD-1
 * option (2)).
 *
 * (a) One control name, one declaration across a chain: a second one is
 * refused where it is applied, naming both extensions. (b) The order guard
 * stays (`rows` never follows a client, model or model-mapped query
 * consumer); an official entry is its rows step and its methods step, and a
 * chain applies every rows step first. (c) A definition may name a control an
 * earlier extension declares, never a later one.
 *
 * The rows-with-controls entry here is the shape `viborm/rbac` takes before
 * its own unit lands, from public exports only: a bound-only actor and
 * `$as` in its rows step (a binding admits only its own extension's
 * controls), `can` in its methods step. Witness ids are the matrix's
 * (`tests/package/fixtures/rbac-app/witnesses.ts`, C12); W-C1 waits for the
 * entry itself, the chain it will take is pinned here.
 *
 * Runs on in-memory SQLite.
 */

import {
  ClientInitializationError,
  NotFoundError,
  ValidationError,
} from "@errors";
import {
  createClient,
  defineExtension,
  type ExtensionState,
  type MergeExtensionState,
  s,
  type VibORMClient,
  type VibORMConfig,
} from "@src/index";
import { softDelete } from "@src/soft-delete/index";
import { v } from "@src/validation";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  memberships: s.toMany(() => member),
});
const organization = s.model({
  id: s.string().id(),
  name: s.string(),
  members: s.toMany(() => member),
  documents: s.toMany(() => document),
  pages: s.toMany(() => page),
});
const member = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  userId: s.string(),
  role: s.string(),
  deletedAt: s.dateTime().nullable(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const document = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  ownerId: s.string(),
  title: s.string(),
  createdBy: s.string(),
  updatedBy: s.string().nullable(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
});
const page = s.model({
  id: s.string().id(),
  organizationId: s.string(),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
});
const schema = { user, organization, member, document, page };

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

const dead = new Date("2026-01-01T00:00:00Z");

async function seeded() {
  const base = createClient({ schema, driver: createInMemorySQLite3Driver() });
  clients.push(base);
  await syncLiveSchema(base);
  for (const id of ["u1", "u2", "u3"]) {
    await base.user.create({ data: { id, name: id } });
  }
  for (const id of ["o1", "o2"]) {
    await base.organization.create({ data: { id, name: id } });
  }
  await base.member.createMany({
    data: [
      { id: "m11", organizationId: "o1", userId: "u1", role: "admin" },
      // u2's membership of o1 is tombstoned: it grants nothing.
      {
        id: "m21",
        organizationId: "o1",
        userId: "u2",
        role: "member",
        deletedAt: dead,
      },
      { id: "m22", organizationId: "o2", userId: "u2", role: "member" },
    ],
  });
  await base.page.createMany({
    data: [
      { id: "p1", organizationId: "o1", title: "live" },
      { id: "p2", organizationId: "o1", title: "dead", deletedAt: dead },
      { id: "p3", organizationId: "o2", title: "other" },
    ],
  });
  await base.document.createMany({
    data: [
      {
        id: "d1",
        organizationId: "o1",
        ownerId: "u1",
        title: "a",
        createdBy: "seed",
      },
      {
        id: "d2",
        organizationId: "o2",
        ownerId: "u3",
        title: "b",
        createdBy: "seed",
      },
    ],
  });
  return base;
}

// --- a rows-with-controls entry, from public exports only -------------------

const me = { control: "actor" } as const;
const inRowOrganization = {
  organization: { is: { members: { some: { userId: me } } } },
} as const;
const NOTHING = { id: { in: [] } };
type Where = Readonly<Record<string, unknown>>;
/** Two modes: rows the actor views, and of those, the ones it edits. */
const modes = (view: Where, edit: Where) => ({
  view: { root: view, related: view },
  edit: { root: { AND: [view, edit] }, related: view },
});
const rowModes = {
  user: modes({ id: me }, NOTHING),
  organization: modes({ members: { some: { userId: me } } }, NOTHING),
  member: modes({ userId: me }, { userId: me, role: "admin" }),
  document: modes(
    { OR: [{ ownerId: me }, inRowOrganization] },
    { ownerId: me }
  ),
  page: modes(inRowOrganization, inRowOrganization),
};
type Governed = keyof typeof rowModes;

/** `$as`, declared apart: inline, the factory's contextual type makes `Self` void. */
type AsMethods = {
  $as<Self>(this: Self, actor: string): Self;
};

/**
 * The entry's two steps. `$as` binds the actor, so it lives where the actor
 * is declared: the rows step. That makes the rows step a client consumer,
 * after which no other `rows` may come (the order guard), so it is the last
 * rows step of a chain.
 */
const policy = {
  rows: <C extends VibORMConfig, X extends ExtensionState>(
    base: VibORMClient<C, X>
  ) => {
    const definition = {
      name: "rbacLike",
      controls: { actor: { schema: v.string(), bound: true, required: true } },
      rows: { control: "as", default: "view", models: rowModes },
      client: (scope: {
        $bind(values: Readonly<Record<string, unknown>>): unknown;
      }): AsMethods => {
        const methods: AsMethods = {
          $as: (actor) => scope.$bind({ actor }) as never,
        };
        return methods;
      },
    } as const;
    // One cast: for a client generic over its state, the client-method guard
    // (`keyof X["client"]`) stays deferred and refuses every client method.
    const extend = base.$extends as unknown as (
      d: typeof definition
    ) => VibORMClient<C, MergeExtensionState<X, typeof definition>>;
    return extend(definition);
  },
  methods: <C extends VibORMConfig, X extends ExtensionState>(
    client: VibORMClient<C, X>
  ) => {
    const can = (delegate: never) => {
      const findFirst = (
        delegate as { findFirst: (args: object) => PromiseLike<unknown> }
      ).findFirst;
      return {
        can: async (action: "view" | "edit", where: object) =>
          (await findFirst({ where, as: action })) !== null,
      };
    };
    const definition = {
      name: "rbacLike.methods",
      model: Object.fromEntries(
        Object.keys(rowModes).map((model) => [model, can])
      ) as { readonly [M in Governed]: typeof can },
    } as const;
    const extend = client.$extends as unknown as (
      d: typeof definition
    ) => VibORMClient<C, MergeExtensionState<X, typeof definition>>;
    return extend(definition);
  },
};

const tombstones = softDelete({
  models: {
    page: { deletedAt: "deletedAt" },
    member: { deletedAt: "deletedAt" },
  },
});

const sorted = (rows: readonly { id: string }[]) =>
  rows.map((row) => row.id).sort();

describe("composition: one name, one control (K7(a))", () => {
  test("W-C5: a second declaration of a control name is refused at $extends, naming both extensions; so is a reused rows control, and a rows control repeating its own controls", async () => {
    const base = await seeded();
    const governed = policy.rows(base);
    const apply = (client: object, definition: object) => () =>
      Reflect.apply(Reflect.get(client, "$extends"), client, [definition]);
    // Accepted today, every update failed one of the two schemas (C10).
    const audit = defineExtension({
      name: "audit",
      controls: { actor: { schema: v.number(), on: "writes" } },
    });
    expect(apply(governed, audit)).toThrow(ClientInitializationError);
    expect(apply(governed, audit)).toThrow(
      'Extension "audit" declares control "actor", which extension "rbacLike" already declares.'
    );
    expect(
      apply(
        base.$extends({
          name: "tenancy",
          rows: { control: "as", default: "a", models: {} },
        }),
        {
          name: "other",
          rows: { control: "as", default: "b", models: {} },
        }
      )
    ).toThrow(
      'Extension "other" declares control "as", which extension "tenancy" already declares.'
    );
    expect(
      apply(base, {
        name: "self",
        controls: { deleted: { oneOf: ["x"] } },
        rows: { control: "deleted", default: "a", models: {} },
      })
    ).toThrow(
      'Extension "self" declares control "deleted", which extension "self" already declares.'
    );
    // Distinct names compose, the official cache's `cache` included.
    expect(
      apply(governed, {
        name: "labels",
        controls: { label: { schema: v.string() } },
      })
    ).not.toThrow();
  });
});

describe("composition: references to earlier controls (K7(c))", () => {
  test("K7(c): a definition naming a control no earlier extension declares is refused at $extends, before the declaring one as after none", async () => {
    const base = await seeded();
    const audit = {
      name: "audit",
      data: { models: { document: { update: { updatedBy: me } } } },
    };
    const apply = (client: object) => () =>
      Reflect.apply(Reflect.get(client, "$extends"), client, [audit]);
    expect(apply(base)).toThrow(ClientInitializationError);
    expect(apply(base)).toThrow(
      'Extension "audit" references undeclared control "actor".'
    );
    expect(apply(tombstones.rows(base))).toThrow(
      'references undeclared control "actor"'
    );
  });

  test("W-C8: audit after the rows-with-controls entry stamps createdBy and updatedBy from the actor's path, on create and update", async () => {
    const base = await seeded();
    const audit = defineExtension({
      name: "audit",
      data: {
        models: {
          document: {
            create: { createdBy: { control: "actor", path: "userId" } },
            update: { updatedBy: { control: "actor", path: "userId" } },
          },
        },
      },
    });
    type ObjectAs = {
      $as<Self>(this: Self, actor: { readonly userId: string }): Self;
    };
    const governed = base.$extends({
      name: "rbacLike",
      controls: {
        actor: {
          schema: v.object({ userId: v.string() }),
          bound: true,
          required: true,
        },
      },
      client: (scope) => {
        const methods: ObjectAs = {
          $as: (actor) => scope.$bind({ actor }) as never,
        };
        return methods;
      },
    });
    const call = governed.$extends(audit).$as({ userId: "u1" });
    await call.document.update({ where: { id: "d1" }, data: { title: "a2" } });
    await call.document.create({
      data: { id: "d3", organizationId: "o1", ownerId: "u1", title: "c" },
    });
    expect(
      await base.document.findMany({
        where: { id: { in: ["d1", "d3"] } },
        select: { id: true, createdBy: true, updatedBy: true },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "d1", createdBy: "seed", updatedBy: "u1" },
      { id: "d3", createdBy: "u1", updatedBy: null },
    ]);
  });
});

describe("composition: rows steps first (K7(b), OD-1 option (2))", () => {
  test("OD-1 option (2): soft delete and a rows-with-controls entry compose with audit as plan §1.1's server.ts, rows steps first, the order guard unchanged", async () => {
    const base = await seeded();
    // A stamp naming no control: what composes here is the order. W-C8 owns
    // audit's reference to the actor.
    const audit = defineExtension({
      name: "audit",
      data: { models: { document: { update: { updatedBy: "audit" } } } },
    });
    const governed = policy.rows(tombstones.rows(base)).$extends(audit);
    const db = policy.methods(tombstones.methods(governed));
    const u1 = db.$as("u1");
    const u2 = db.$as("u2");
    expectTypeOf(u1).toEqualTypeOf<typeof db>();

    expect(sorted(await u1.page.findMany())).toEqual(["p1"]);
    expect(sorted(await u1.page.findMany({ deleted: "with" }))).toEqual([
      "p1",
      "p2",
    ]);
    // u2's tombstoned membership of o1 grants nothing.
    expect(sorted(await u2.page.findMany())).toEqual(["p3"]);
    expect(sorted(await u2.organization.findMany())).toEqual(["o2"]);

    const restored = await u1.page.restore({
      where: { id: "p2" },
      include: { organization: true },
    });
    // rbac, applied after soft delete's rows, can hide the organization.
    expectTypeOf(restored.organization).toEqualTypeOf<{
      id: string;
      name: string;
    } | null>();
    expect([restored.deletedAt, restored.organization?.id]).toEqual([
      null,
      "o1",
    ]);
    await expect(
      u2.page.restore({ where: { id: "p1" } })
    ).rejects.toBeInstanceOf(NotFoundError);

    await u1.document.update({ where: { id: "d1" }, data: { title: "a2" } });
    expect(
      await base.document.findUnique({
        where: { id: "d1" },
        select: { updatedBy: true },
      })
    ).toEqual({ updatedBy: "audit" });
    expect([
      await u1.member.can("edit", { id: "m11" }),
      await u1.document.can("edit", { id: "d2" }),
      await u2.page.can("view", { id: "p3" }),
    ]).toEqual([true, false, true]);
    await expect(db.page.findMany()).rejects.toThrow(
      'Control "actor" is required'
    );
    await expect(db.page.findMany()).rejects.toBeInstanceOf(ValidationError);

    // The guard stays: a rows step after the entry's `$as`, or after a model
    // method typed before it, is refused where it is applied.
    expect(() => tombstones.rows(policy.rows(base))).toThrow(
      "cannot follow an extension that defines model-mapped query, client, or model behavior"
    );
    const typedBefore = base.$extends({
      name: "mine",
      model: {
        document: (d) => ({
          withOrg: (id: string) =>
            d.findFirst({ where: { id }, include: { organization: true } }),
        }),
      },
    });
    expect(() => policy.rows(typedBefore)).toThrow(ClientInitializationError);
  });
});
