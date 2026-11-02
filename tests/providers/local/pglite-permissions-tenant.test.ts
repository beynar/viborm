/**
 * PGlite Driver Tests — a policy's `tenant`: inside the policy's own rules,
 * a set PostgreSQL computes over a whole table (a shared body, a reaching
 * set) holds only the actor's tenant, where a test reads it positively
 * (`rows.bound`). Nothing else changes: the rows a call reads through a
 * relation, and every other extension's predicates. On data that keeps every
 * relation inside one tenant (the acceptance estate) the policy answers what
 * it answers without `tenant`; on data that does not, `tenant` only ever
 * takes access away.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete/index";
import { v } from "@src/validation";
import { loadPermissionsSeed } from "@tests/contracts/public-client/permissions-app-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import {
  GOVERNED_MODELS,
  TOMBSTONED_MODELS,
} from "@tests/package/fixtures/permissions-app/oracle";
import { schema } from "@tests/package/fixtures/permissions-app/schema";
import { actors } from "@tests/package/fixtures/permissions-app/seed";
import { policy } from "@tests/types/permissions/acceptance-policy";
import { beforeEach, describe, expect, test } from "vitest";

type Row = Record<string, unknown>;
type Delegate = {
  findMany(args?: object): Promise<Row[]>;
  findFirst(args?: object): Promise<Row | null>;
};
type Governed = { $as(actor: unknown): Record<string, Delegate> };

const TENANT: {
  readonly field: "organizationId";
  readonly actor: "organizationId";
  readonly except?: readonly string[];
} = { field: "organizationId", actor: "organizationId" };
const tombstones = softDelete({
  models: Object.fromEntries(
    TOMBSTONED_MODELS.map((model) => [model, { deletedAt: "deletedAt" }])
  ),
});
const tenanted = permissions({ ...policy.config, tenant: TENANT });

/** Each actor shape the seed holds: sessions, roles, teams, keys. */
const JUDGED = [
  "u01",
  "u02",
  "u03",
  "u04",
  "u05",
  "u20",
  "u22",
  "u42",
  "u56",
  "k02-pages-read",
  "k21-everything",
];
const keysOf = (model: string) =>
  model === "teamMember" ? { teamId: true, userId: true } : { id: true };
/**
 * The actor's tenant's rows of `model`: a call the declaration fits reads
 * no other (the estate also lets a member of two organisations act on the
 * other one, which a policy declaring its tenant does not).
 */
const inTenant = (model: string, organizationId: string): object => {
  if (model === "organization") return { id: organizationId };
  if (model === "teamMember") return { team: { is: { organizationId } } };
  if (model === "user") return { members: { some: { organizationId } } };
  return Object.hasOwn(
    (
      schema[model as keyof typeof schema] as unknown as {
        "~": { state: { scalars: object } };
      }
    )["~"].state.scalars,
    "organizationId"
  )
    ? { organizationId }
    : {};
};

const WITH = /^WITH (?:RECURSIVE )?/;
const TENANT_TEST = /"organizationId" = (?:\$\d+|\?)/;
const TENANT_TESTS = /"organizationId" = (?:\$\d+|\?)/g;

/** The `WITH` bodies of a statement, and what follows them. */
function partsOf(statement: string): { bodies: string[]; main: string } {
  const bodies: string[] = [];
  const head = WITH.exec(statement);
  if (!head) return { bodies, main: statement };
  let at = head[0].length;
  for (;;) {
    const open = statement.indexOf("(", at);
    let depth = 0;
    let close = open;
    for (; close < statement.length; close++) {
      if (statement[close] === "(") depth++;
      else if (statement[close] === ")" && --depth === 0) break;
    }
    bodies.push(statement.slice(open, close + 1));
    at = close + 1;
    if (!statement.startsWith(", ", at)) break;
    at += 2;
  }
  return { bodies, main: statement.slice(at) };
}
const tenantTests = (text: string) => (text.match(TENANT_TESTS) ?? []).length;

describe("PGlite: a policy's tenant on the acceptance estate", () => {
  const family = usePGliteSchemaFamily(schema);
  let base: ReturnType<typeof family>["client"];
  let plain: Governed;
  let bounded: Governed;
  const statements: string[] = [];

  beforeEach(async () => {
    base = family().client;
    await loadPermissionsSeed(base);
    const recorded = base.$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    plain = policy.methods(
      tombstones.methods(policy.rows(tombstones.rows(recorded)))
    ) as unknown as Governed;
    bounded = tenanted.methods(
      tombstones.methods(tenanted.rows(tombstones.rows(recorded)))
    ) as unknown as Governed;
  }, 300_000);

  test("every governed model answers the same rows and $access with and without it", async () => {
    for (const name of JUDGED) {
      const actor = actors[name]!;
      for (const model of GOVERNED_MODELS) {
        const args = {
          where: inTenant(model, actor.organizationId),
          select: { ...keysOf(model), $access: true },
        };
        expect(
          await bounded.$as(actor)[model]!.findMany(args),
          `${name} ${model}`
        ).toEqual(await plain.$as(actor)[model]!.findMany(args));
      }
    }
  }, 300_000);

  test("a bounded read of one row answers the same with and without it", async () => {
    for (const name of JUDGED.slice(0, 4)) {
      const actor = actors[name]!;
      for (const model of GOVERNED_MODELS) {
        const rows = await (base as unknown as Record<string, Delegate>)[
          model
        ]!.findMany({
          where: inTenant(model, actor.organizationId),
          select: keysOf(model),
          take: 3,
        });
        for (const where of rows) {
          const args = { where, select: { ...keysOf(model), $access: true } };
          expect(
            await bounded.$as(actor)[model]!.findFirst(args),
            `${name} ${model} ${JSON.stringify(where)}`
          ).toEqual(await plain.$as(actor)[model]!.findFirst(args));
        }
      }
    }
  }, 300_000);

  test("the bound reaches the sets the statement computes, never its correlated reads", async () => {
    const read = async (governed: Governed) => {
      statements.length = 0;
      await governed
        .$as(actors.u02!)
        .document!.findMany({ select: { id: true, $access: true } });
      return partsOf(
        statements.reduce((a, b) => (b.length > a.length ? b : a))
      );
    };
    const without = await read(plain);
    const within = await read(bounded);
    const inBodies = (parts: { bodies: string[] }) =>
      parts.bodies.reduce((sum, body) => sum + tenantTests(body), 0);
    expect(within.bodies.length).toBeGreaterThan(0);
    expect(inBodies(within)).toBeGreaterThan(inBodies(without));
    expect(tenantTests(within.main)).toBe(tenantTests(without.main));
  });
});

describe("PGlite: a policy's tenant on rows that cross tenants", () => {
  const page = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    grants: s.toMany(() => grant),
  });
  const grant = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    userId: s.string(),
    revoked: s.boolean(),
  });
  const schema = { page, grant };
  const actor = { userId: "ada", organizationId: "a" };
  // Both rules read the revoked grants under a `NOT`, and `update` reads the
  // actor's grants: the statement computes the repeated body once, as a set.
  const policyOf = (tenant?: typeof TENANT) =>
    permissions({
      actor: v.object({ userId: v.string(), organizationId: v.string() }),
      levels: ["read", "update"],
      ...(tenant === undefined ? {} : { tenant }),
      models: {
        page: {
          mandatory: { organizationId: { actor: "organizationId" } },
          read: { NOT: { grants: { some: { revoked: true } } } },
          update: {
            grants: { some: { userId: { actor: "userId" } } },
            NOT: { grants: { some: { revoked: true } } },
          },
        },
        grant: { read: {} },
      },
    });
  const family = usePGliteSchemaFamily(schema);
  let base: ReturnType<typeof family>["client"];

  beforeEach(async () => {
    base = family().client;
    await base.page.createMany({
      data: [
        { id: "granted-elsewhere", organizationId: "a" },
        { id: "revoked-elsewhere", organizationId: "a" },
      ],
    });
    // Grants written in another tenant than their page's: a relation the
    // declaration says never crosses tenants, crossing.
    await base.grant.createMany({
      data: [
        {
          id: "g1",
          organizationId: "b",
          pageId: "granted-elsewhere",
          userId: "ada",
          revoked: false,
        },
        {
          id: "g2",
          organizationId: "a",
          pageId: "revoked-elsewhere",
          userId: "ada",
          revoked: false,
        },
        {
          id: "g3",
          organizationId: "b",
          pageId: "revoked-elsewhere",
          userId: "eve",
          revoked: true,
        },
      ],
    });
  });

  test("it never grants what the policy without it refuses", async () => {
    const access = async (tenant?: typeof TENANT) =>
      (await (policyOf(tenant)(base as never) as unknown as Governed)
        .$as(actor)
        .page!.findMany({
          select: { id: true, $access: true },
          orderBy: { id: "asc" },
        })) as { id: string; $access: Record<string, boolean> }[];
    const without = await access();
    const within = await access(TENANT);
    for (const row of within) {
      const other = without.find((candidate) => candidate.id === row.id);
      expect(other, row.id).toBeDefined();
      for (const [action, holds] of Object.entries(row.$access))
        if (holds)
          expect(other!.$access[action], `${row.id} ${action}`).toBe(true);
    }
    // The revoked grant of the other tenant still hides its page.
    expect(without.map((row) => row.id)).toEqual(["granted-elsewhere"]);
    expect(within.map((row) => row.id)).toEqual(["granted-elsewhere"]);
  });

  test("a relation the caller reads is the same with and without it", async () => {
    const open = (tenant?: typeof TENANT) =>
      permissions({
        actor: v.object({ userId: v.string(), organizationId: v.string() }),
        levels: ["read"],
        ...(tenant === undefined ? {} : { tenant }),
        models: {
          page: {
            mandatory: { organizationId: { actor: "organizationId" } },
            read: true,
          },
          grant: { read: true },
        },
      });
    const pages = async (tenant?: typeof TENANT) =>
      (open(tenant)(base as never) as unknown as Governed)
        .$as(actor)
        .page!.findMany({
          select: {
            id: true,
            grants: { select: { id: true }, orderBy: { id: "asc" } },
          },
          orderBy: { id: "asc" },
        });
    expect(await pages()).toEqual([
      { id: "granted-elsewhere", grants: [{ id: "g1" }] },
      { id: "revoked-elsewhere", grants: [{ id: "g2" }, { id: "g3" }] },
    ]);
    expect(await pages(TENANT)).toEqual(await pages());
  });
});

describe("PGlite: a policy's tenant beside another extension's related rows", () => {
  const page = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    grants: s.toMany(() => grant),
  });
  const team = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    archived: s.boolean(),
    grants: s.toMany(() => grant),
  });
  const grant = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    teamId: s.string(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
    revoked: s.boolean(),
  });
  const schema = { page, team, grant };
  const family = usePGliteSchemaFamily(schema);
  let base: ReturnType<typeof family>["client"];
  // Another layer: a grant of an archived team is no grant. Inside the
  // policy's rules it is the range every grant quantifier reads, its own
  // `team is` body a set wherever two rules repeat it.
  const archive = defineExtension({
    name: "archive",
    rows: {
      control: "archive",
      default: "live",
      models: {
        grant: { live: { related: { team: { is: { archived: false } } } } },
      },
    },
  });
  const policyOf = (tenant?: typeof TENANT) =>
    permissions({
      actor: v.object({ userId: v.string(), organizationId: v.string() }),
      levels: ["read", "update"],
      ...(tenant === undefined ? {} : { tenant }),
      models: {
        page: {
          mandatory: { organizationId: { actor: "organizationId" } },
          read: { grants: { none: { revoked: true } } },
          update: { grants: { none: { revoked: true } }, id: { not: "-" } },
        },
      },
    });

  beforeEach(async () => {
    base = family().client;
    await base.page.create({ data: { id: "p", organizationId: "a" } });
    // The revoked grant's team is another organization's: a relation that
    // crosses tenants, inside the range of a negative test.
    await base.team.create({
      data: { id: "t", organizationId: "b", archived: false },
    });
    await base.grant.create({
      data: {
        id: "g",
        organizationId: "a",
        pageId: "p",
        teamId: "t",
        revoked: true,
      },
    });
  });

  test("the range of a negative test is never narrowed by the bound", async () => {
    for (const tenant of [undefined, TENANT]) {
      const governed = policyOf(tenant)(
        base.$extends(archive) as never
      ) as unknown as Governed;
      expect(
        await governed
          .$as({ userId: "ada", organizationId: "a" })
          .page!.findMany({ select: { id: true, $access: true } }),
        tenant === undefined ? "without tenant" : "with tenant"
      ).toEqual([]);
    }
  });
});

describe("PGlite: rows.bound, the capability tenant is built on", () => {
  const page = s.model({ id: s.string().id(), grants: s.toMany(() => grant) });
  const grant = s.model({
    id: s.string().id(),
    tenant: s.string(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    userId: s.string(),
  });
  const schema = { page, grant };
  const family = usePGliteSchemaFamily(schema);
  let base: ReturnType<typeof family>["client"];
  const granted = { grants: { some: { userId: { control: "user" } } } };
  // `tenant` is read by `bound` alone; `granted` repeats, so the statement
  // computes it once, as a set.
  const sharing = (bound: {
    readonly [model: string]: Readonly<Record<string, unknown>>;
  }) =>
    defineExtension({
      name: "sharing",
      controls: {
        user: { schema: v.string(), required: true },
        tenant: { schema: v.string() },
      },
      rows: {
        control: "as",
        default: "default",
        models: { page: { default: {} } },
        verbs: {
          page: {
            predicates: {
              seen: {
                OR: [
                  { AND: [granted, { id: { not: "x" } }] },
                  { AND: [granted, { id: { not: "y" } }] },
                ],
              },
            },
            read: "seen",
          },
        },
        bound,
      },
    });

  beforeEach(async () => {
    base = family().client;
    await base.page.create({ data: { id: "p" } });
    await base.grant.create({
      data: { id: "g", tenant: "b", pageId: "p", userId: "ada" },
    });
  });

  test("a bound that alone reads a control bounds the sets with the call's value", async () => {
    const statements: string[] = [];
    const recorded = base.$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    const db = recorded.$extends(
      sharing({ grant: { tenant: { control: "tenant" } } }) as never
    ) as unknown as Record<string, Delegate>;
    const pages = (args: object) =>
      db.page!.findMany({ ...args, select: { id: true } });
    expect(await pages({ user: "ada" })).toEqual([{ id: "p" }]);
    expect(await pages({ user: "ada", tenant: "b" })).toEqual([{ id: "p" }]);
    statements.length = 0;
    expect(await pages({ user: "ada", tenant: "a" })).toEqual([]);
    expect(partsOf(statements.at(-1)!).bodies.join(" ")).toContain(
      '"tenant" = '
    );
  });

  test("a bound naming an undeclared control is refused when applied", () => {
    expect(() =>
      base.$extends(
        sharing({ grant: { tenant: { control: "nope" } } }) as never
      )
    ).toThrow('references undeclared control "nope"');
  });
});

describe("PGlite: a policy's tenant beside another extension's negative test", () => {
  const page = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    blocks: s.toMany(() => block),
  });
  const block = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    active: s.boolean(),
  });
  const schema = { page, block };
  const family = usePGliteSchemaFamily(schema);
  let base: ReturnType<typeof family>["client"];
  // Another layer: a page with an active block is hidden from every caller.
  const blocklist = defineExtension({
    name: "blocklist",
    rows: {
      control: "blocklist",
      default: "on",
      models: {
        page: { on: { root: { blocks: { none: { active: true } } } } },
      },
    },
  });
  const policyOf = (tenant?: typeof TENANT) =>
    permissions({
      actor: v.object({ userId: v.string(), organizationId: v.string() }),
      levels: ["read", "update"],
      ...(tenant === undefined ? {} : { tenant }),
      models: {
        page: {
          mandatory: { organizationId: { actor: "organizationId" } },
          read: true,
          update: true,
        },
        block: { read: true },
      },
    });

  beforeEach(async () => {
    base = family().client;
    await base.page.create({ data: { id: "p", organizationId: "a" } });
    // An active block written in another organization than its page's.
    await base.block.create({
      data: { id: "b", organizationId: "b", pageId: "p", active: true },
    });
  });

  test("it reads every tenant's rows, with tenant as without", async () => {
    for (const tenant of [undefined, TENANT]) {
      const as = (
        policyOf(tenant)(base.$extends(blocklist) as never) as unknown as {
          $as(
            actor: unknown
          ): Record<
            string,
            Delegate & { updateMany(args: object): Promise<{ count: number }> }
          >;
        }
      ).$as({ userId: "ada", organizationId: "a" });
      expect(await as.page!.findMany({ select: { id: true } })).toEqual([]);
      expect(
        await as.page!.updateMany({ data: {}, where: { id: "p" } })
      ).toEqual({ count: 0 });
    }
  });
});

// Reviewed by GPT-6.1 Sol: each reproduced, then fixed.
const recorder = (into: string[]) => ({
  name: "statements",
  statement(context: { statement: { toStatement(): string } }) {
    into.push(context.statement.toStatement());
    return context.statement;
  },
});

describe("PGlite: a policy's tenant and a read-gated field", () => {
  const page = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    secret: s.string(),
    grants: s.toMany(() => grant),
  });
  const grant = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    pageId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    revoked: s.boolean(),
  });
  const family = usePGliteSchemaFamily({ page, grant });

  test("the field is masked where its gate holds, with tenant as without", async () => {
    const base = family().client;
    await base.page.create({
      data: { id: "p", organizationId: "a", secret: "s3cret" },
    });
    // A revoked grant of another organization closes the gate.
    await base.grant.create({
      data: { id: "g", organizationId: "b", pageId: "p", revoked: true },
    });
    const run = async (tenant?: typeof TENANT) =>
      (
        permissions({
          actor: v.object({ organizationId: v.string() }),
          ...(tenant === undefined ? {} : { tenant }),
          models: {
            page: {
              actions: { read: [], see: ["read"] },
              read: true,
              see: { NOT: { grants: { some: { revoked: true } } } },
              fields: { secret: { read: "see" } },
            },
            grant: { read: true },
          },
        })(base as never) as unknown as Governed
      )
        .$as({ organizationId: "a" })
        .page!.findMany({
          // A negated test over the gated field: an oracle for its value
          // wherever the gate opens.
          where: {
            AND: [{ secret: { not: "guess" } }, { secret: { not: "other" } }],
          },
          select: { id: true, $access: true },
        });
    expect(await run()).toEqual([]);
    expect(await run(TENANT)).toEqual([]);
  });
});

describe("PGlite: a policy's tenant compiled when applied", () => {
  const parent = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    createdAt: s.dateTime(),
    grants: s.toMany(() => share),
  });
  const share = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    parentId: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
    userId: s.string(),
  });
  const family = usePGliteSchemaFamily({ parent, share });

  test("a Date in a rule still bounds the policy's sets", async () => {
    const statements: string[] = [];
    const granted = {
      grants: { some: { userId: { actor: "userId" } } },
    } as const;
    const db = permissions({
      actor: v.object({ userId: v.string(), organizationId: v.string() }),
      tenant: TENANT,
      levels: ["read", "update"],
      models: {
        parent: {
          // A Date: the declaration cannot be copied, so it compiles when
          // applied.
          read: {
            createdAt: { lt: new Date("2100-01-01T00:00:00Z") },
            ...granted,
          },
          update: { ...granted, id: { not: "-" } },
        },
        share: { read: true },
      },
    })(
      family().client.$extends(recorder(statements) as never) as never
    ) as unknown as Governed;
    await db
      .$as({ userId: "ada", organizationId: "a" })
      .parent!.findMany({ select: { id: true, $access: true } });
    expect(partsOf(statements.at(-1)!).bodies.join(" ")).toMatch(TENANT_TEST);
  });
});

describe("PGlite: a policy's tenant on a walk keyed by the row's own key", () => {
  const node = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => node),
  });
  const family = usePGliteSchemaFamily({ node });

  test("its reaching set is bounded", async () => {
    // A relation budget of 1, over the file's database: every repeated walk
    // becomes a reaching set.
    const { database, namespace } = family();
    const base = createClient({
      schema: { node },
      driver: new PGliteDriver({
        client: database,
        namespace,
        relationsPerStatement: 1,
      }),
    });
    try {
      await base.node.create({ data: { id: "p", organizationId: "a" } });
      await base.node.create({
        data: { id: "foreign", organizationId: "b", parentId: "p" },
      });
      const statements: string[] = [];
      const below = {
        children: { recurse: { depth: false }, some: { id: "foreign" } },
      };
      const read = (tenant?: typeof TENANT) => {
        const db = permissions({
          actor: v.object({ organizationId: v.string() }),
          ...(tenant === undefined ? {} : { tenant }),
          models: {
            node: {
              actions: { read: [], see: ["read"], audit: ["read"] },
              read: true,
              see: below,
              audit: below,
            },
          },
        })(
          base.$extends(recorder(statements) as never) as never
        ) as unknown as Governed;
        return db.$as({ organizationId: "a" }).node!.findMany({
          where: { id: "p" },
          select: { id: true, $access: true },
        });
      };
      // The set's own rows are bounded; the row the walk reaches is not one.
      const without = await read();
      expect(await read(TENANT)).toEqual(without);
      const statement = statements.at(-1)!;
      expect(statement).toContain("WITH RECURSIVE");
      expect(partsOf(statement).bodies.join(" ")).toMatch(TENANT_TEST);
    } finally {
      await base.$disconnect();
    }
  });
});
