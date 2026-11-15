/**
 * Composition (Permissions plan K7, §4.7 as amended by spike F6 in §11.2; OD-1
 * option (2)).
 *
 * (a) One control name, one declaration across a chain: a second one is
 * refused where it is applied, naming both extensions. (b) The order guard
 * stays (`rows` never follows a client, model or model-mapped query
 * consumer); an official entry is its rows step and its methods step, and a
 * chain applies every rows step first. (c) A definition may name a control an
 * earlier extension declares, never a later one.
 *
 * The rows-with-controls entry here is the shape `viborm/permissions` takes before
 * its own unit lands, from public exports only: a bound-only actor and
 * `$as` in its rows step (a binding admits only its own extension's
 * controls), `can` in its methods step. Witness ids are the matrix's
 * (`tests/package/fixtures/permissions-app/witnesses.ts`, C12); W-C1 runs through
 * the entry itself (`permissions-entry-behavior.ts`), the chain it takes is pinned
 * here.
 *
 * Runs on in-memory SQLite.
 */

import {
  ClientInitializationError,
  NotFoundError,
  ValidationError,
} from "@errors";
import {
  accepts,
  arg,
  bound,
  createClient,
  defaults,
  args as extArgs,
  extension,
  methods as extMethods,
  modelMethods,
  oneOf,
  parts,
  s,
  when,
  writes,
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

const me = arg("actor");
const inRowOrganization = {
  organization: { is: { members: { some: { userId: me } } } },
};
const NOTHING = { id: { in: [] } };

/** `$as`, declared apart: inline, the factory's contextual type makes `Self` void. */
type AsMethods = {
  $as<Self>(this: Self, actor: string): Self;
};
interface Readable {
  findFirst(args: object): PromiseLike<unknown>;
}
/** Whether the actor may take `action` on a row matching `where`. */
async function can(this: Readable, action: "view" | "edit", where: object) {
  return (await this.findFirst({ where, as: action })) !== null;
}

/**
 * The entry: a bound-only actor, its rows in two modes, `$as` (it binds the
 * actor, so it lives in the extension that declares it) and `can`.
 */
const typed = parts<typeof schema>();
const policy = typed.extension(
  "permissionsLike",
  typed.args({
    actor: bound(v.string()).required(),
    as: oneOf("view", "edit").default("view"),
  }),
  // Two modes: rows the actor views (`related` always), and of those, in
  // `as: "edit"`, the ones it edits.
  typed.rule({
    user: {
      root: [{ id: me }, when(arg("as"), "edit", NOTHING)],
      related: { id: me },
    },
    organization: {
      root: [
        { members: { some: { userId: me } } },
        when(arg("as"), "edit", NOTHING),
      ],
      related: { members: { some: { userId: me } } },
    },
    member: {
      root: [
        { userId: me },
        when(arg("as"), "edit", { userId: me, role: "admin" }),
      ],
      related: { userId: me },
    },
    document: {
      root: [
        { OR: [{ ownerId: me }, inRowOrganization] },
        when(arg("as"), "edit", { ownerId: me }),
      ],
      related: { OR: [{ ownerId: me }, inRowOrganization] },
    },
    page: {
      root: [inRowOrganization, when(arg("as"), "edit", inRowOrganization)],
      related: inRowOrganization,
    },
  }),
  typed.methods((scope) => {
    const client: AsMethods = {
      $as: (actor) => scope.$bind({ actor }) as never,
    };
    return client;
  }),
  typed.modelMethods(() => ({
    user: { can },
    organization: { can },
    member: { can },
    document: { can },
    page: { can },
  }))
);

const tombstones = softDelete({
  models: {
    page: { deletedAt: "deletedAt" },
    member: { deletedAt: "deletedAt" },
  },
});

const sorted = (rows: readonly { id: string }[]) =>
  rows.map((row) => row.id).sort();

describe("composition: one name, one control (K7(a))", () => {
  test("W-C5: a second declaration of a control name is refused at $extends, naming both extensions; so is a reused rows control", async () => {
    const base = await seeded();
    const governed = base.$extends(policy);
    const apply = (client: object, definition: object) => () =>
      Reflect.apply(Reflect.get(client, "$extends"), client, [definition]);
    // Accepted today, every update failed one of the two schemas (C10).
    const audit = extension(
      "audit",
      extArgs({ actor: accepts(v.number()).on(writes) })
    );
    expect(apply(governed, audit)).toThrow(ClientInitializationError);
    expect(apply(governed, audit)).toThrow(
      'Extension "audit" declares argument "actor", which extension "permissionsLike" already declares.'
    );
    expect(
      apply(
        base.$extends(
          extension("tenancy", extArgs({ as: oneOf("a").default("a") }))
        ),
        extension("other", extArgs({ as: oneOf("b").default("b") }))
      )
    ).toThrow(
      'Extension "other" declares argument "as", which extension "tenancy" already declares.'
    );
    // Distinct names compose, the official cache's `cache` included.
    expect(
      apply(
        governed,
        extension("labels", extArgs({ label: accepts(v.string()) }))
      )
    ).not.toThrow();
  });

  test("W-C5: one extension declaring an argument twice is refused at $extends, as two extensions are", () => {
    const base = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });
    clients.push(base);
    const apply = (client: object, definition: object) => () =>
      Reflect.apply(Reflect.get(client, "$extends"), client, [definition]);
    expect(
      apply(
        base,
        extension(
          "self",
          extArgs({ deleted: oneOf("x") }),
          extArgs({ deleted: oneOf("a").default("a") })
        )
      )
    ).toThrow(
      'Extension "self" declares argument "deleted", which extension "self" already declares.'
    );
  });
});

describe("composition: references to earlier controls (K7(c))", () => {
  test("K7(c): a definition naming a control no earlier extension declares is refused at $extends, before the declaring one as after none", async () => {
    const base = await seeded();
    const audit = extension(
      "audit",
      defaults({ document: { update: { updatedBy: me } } })
    );
    const apply = (client: object) => () =>
      Reflect.apply(Reflect.get(client, "$extends"), client, [audit]);
    expect(apply(base)).toThrow(ClientInitializationError);
    expect(apply(base)).toThrow(
      'Extension "audit" references undeclared argument "actor".'
    );
    expect(apply(base.$extends(tombstones))).toThrow(
      'references undeclared argument "actor"'
    );
  });

  test("W-C8: audit after the rows-with-controls entry stamps createdBy and updatedBy from the actor's path, on create and update", async () => {
    const base = await seeded();
    const audit = extension(
      "audit",
      defaults({
        document: {
          create: { createdBy: arg("actor", "userId") },
          update: { updatedBy: arg("actor", "userId") },
        },
      })
    );
    type ObjectAs = {
      $as<Self>(this: Self, actor: { readonly userId: string }): Self;
    };
    const governed = base.$extends(
      extension(
        "permissionsLike",
        extArgs({ actor: bound(v.object({ userId: v.string() })).required() }),
        extMethods((scope) => {
          const methods: ObjectAs = {
            $as: (actor) => scope.$bind({ actor }) as never,
          };
          return methods;
        })
      )
    );
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
    const audit = extension(
      "audit",
      defaults({ document: { update: { updatedBy: "audit" } } })
    );
    const db = base.$extends(tombstones).$extends(policy).$extends(audit);
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
    // permissions, applied after soft delete's rows, can hide the organization.
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
      'Argument "actor" is required'
    );
    await expect(db.page.findMany()).rejects.toBeInstanceOf(ValidationError);

    // A method runs through the whole chain it is called on: one typed
    // before a later rows step reads what those rows hide as missing. Only
    // its types could lie, so TypeScript refuses that order (below); the
    // runtime does not.
    const typedBefore = base.$extends(
      extension(
        "mine",
        modelMethods((scope) => ({
          document: {
            withOrg: (id: string) =>
              scope.document.findFirst({
                where: { id },
                include: { organization: true },
              }),
          },
        }))
      )
    );
    const late = Reflect.apply(typedBefore.$extends, typedBefore, [policy]) as {
      $as(actor: string): typeof typedBefore;
    };
    expect(await late.$as("u3").document.withOrg("d2")).toEqual(
      expect.objectContaining({ id: "d2", organization: null })
    );
    // A rows step after a method typed against its client is refused by
    // TypeScript, not by the runtime.
    expect(() =>
      // @ts-expect-error a rule hiding rows after a result consumer
      typedBefore.$extends(tombstones)
    ).not.toThrow();
  });

  test("soft delete is one step, applied before or after the rows-with-controls entry: the same rows, restores and refusals", async () => {
    const base = await seeded();
    const before = base.$extends(tombstones).$extends(policy);
    // `$as` binds the entry's own actor, so its methods read `scope`: the
    // entry is a result consumer, and TypeScript refuses soft delete after
    // it. The runtime composes it all the same.
    const governed = base.$extends(policy);
    expect(() =>
      // @ts-expect-error a rule hiding rows after a result consumer
      governed.$extends(tombstones)
    ).not.toThrow();
    const after: typeof before = Reflect.apply(governed.$extends, governed, [
      tombstones,
    ]);
    for (const db of [before, after]) {
      const u1 = db.$as("u1");
      const u2 = db.$as("u2");
      expect(sorted(await u1.page.findMany())).toEqual(["p1"]);
      expect(sorted(await u1.page.findMany({ deleted: "only" }))).toEqual([
        "p2",
      ]);
      // u2's tombstoned membership of o1 grants nothing, in either order.
      expect(sorted(await u2.page.findMany())).toEqual(["p3"]);
      expect(await u1.page.can("view", { id: "p1" })).toBe(true);
      await expect(
        u2.page.restore({ where: { id: "p2" } })
      ).rejects.toBeInstanceOf(NotFoundError);
      const restored = await u1.page.restore({
        where: { id: "p2" },
        include: { organization: true },
      });
      expectTypeOf(restored.organization).toEqualTypeOf<{
        id: string;
        name: string;
      } | null>();
      expect(restored.organization?.id).toBe("o1");
      await u1.page.delete({ where: { id: "p2" } });
      expect(sorted(await u1.page.findMany())).toEqual(["p1"]);
    }
  });
});
