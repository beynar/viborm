import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForbiddenError, NotFoundError, ValidationError } from "@errors";
import { s } from "@schema";
import { permissions, type Rule } from "@src/permissions";
import { v } from "@src/validation";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const organization = s.model({
  id: s.string().id(),
  members: s.toMany(() => membership),
  documents: s.toMany(() => document),
});
const membership = s.model({
  id: s.string().id(),
  userId: s.string(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
});
const document = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  title: s.string(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
});

function createBase(driver: AnyDriver) {
  return createClient({
    schema: { organization, membership, document },
    driver,
  });
}
export type AdversarialClient = ReturnType<typeof createBase>;

const member: Rule = { members: { some: { userId: { actor: "userId" } } } };
const owner: Rule = { ownerId: { actor: "userId" } };
const tenant: Rule = { organizationId: { actor: "organizationId" } };
const policy = permissions({
  actor: v.object({ userId: v.string(), organizationId: v.string() }),
  models: {
    organization: {
      mandatory: { id: { actor: "organizationId" } },
      "read, update": member,
      operations: { read: "read", update: "update" },
    },
    membership: {
      mandatory: tenant,
      read: { userId: { actor: "userId" } },
    },
    document: {
      mandatory: { AND: [tenant, { organization: { is: member } }] },
      read: {},
      "update, delete": owner,
      create: { AND: [tenant, owner] },
      operations: { read: "read", update: "update", delete: "delete" },
    },
  },
});

function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One shared behavioral matrix. Expected rows come from the fixture, not the compiler. */
export function runPermissionsAdversarialBehavior(substrate: {
  name: string;
  createDriver: () => AnyDriver;
  prepare: (client: AdversarialClient) => Promise<void>;
  release?: () => Promise<void>;
}) {
  describe(`${substrate.name}: Permissions adversarial boundaries`, () => {
    let base: AdversarialClient;
    const governed = () => base.$extends(policy);
    const alice = () =>
      governed().$as({ userId: "alice", organizationId: "a" });
    test("credential scopes restrict nested writes and preserve model and tenant checks", async () => {
      const actor = { userId: "alice", organizationId: "a" };
      const rootOnly = governed().$as(actor, ["organization.update"]);
      const hiddenRelations = await rootOnly.organization.findUnique({
        where: { id: "a" },
        include: { documents: true, members: true },
      });
      expect(hiddenRelations?.documents).toEqual([]);
      expect(hiddenRelations?.members).toEqual([]);
      await expect(
        rootOnly.organization.update({
          where: { id: "a" },
          data: {
            documents: {
              update: { where: { id: "alice-a" }, data: { title: "denied" } },
            },
          },
        })
      ).rejects.toThrow();
      const both = governed().$as(actor, [
        "organization.update",
        "document.update",
      ]);
      const visibleRelations = await both.organization.findUnique({
        where: { id: "a" },
        include: { documents: { orderBy: { id: "asc" } }, members: true },
      });
      expect(visibleRelations?.documents.map(({ id }) => id)).toEqual([
        "alice-a",
        "bob-a",
      ]);
      expect(visibleRelations?.members).toEqual([]);
      await both.organization.update({
        where: { id: "a" },
        data: {
          documents: {
            update: { where: { id: "alice-a" }, data: { title: "scoped" } },
          },
        },
      });
      expect(
        (await base.document.findUnique({ where: { id: "alice-a" } }))?.title
      ).toBe("scoped");
      await expect(
        both.document.update({
          where: { id: "bob-a" },
          data: { title: "denied" },
        })
      ).rejects.toThrow();
      await expect(
        both.document.update({
          where: { id: "bob-b" },
          data: { title: "denied" },
        })
      ).rejects.toThrow();
    });
    beforeAll(async () => {
      base = createBase(substrate.createDriver());
      await substrate.prepare(base);
    }, 60_000);
    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    });
    beforeEach(async () => {
      await base.document.deleteMany();
      await base.membership.deleteMany();
      await base.organization.deleteMany();
      await base.organization.createMany({ data: [{ id: "a" }, { id: "b" }] });
      await base.membership.createMany({
        data: [
          { id: "alice-a", userId: "alice", organizationId: "a" },
          { id: "bob-a", userId: "bob", organizationId: "a" },
          { id: "bob-b", userId: "bob", organizationId: "b" },
        ],
      });
      await base.document.createMany({
        data: [
          {
            id: "alice-a",
            ownerId: "alice",
            organizationId: "a",
            title: "original",
          },
          {
            id: "bob-a",
            ownerId: "bob",
            organizationId: "a",
            title: "original",
          },
          {
            id: "bob-b",
            ownerId: "bob",
            organizationId: "b",
            title: "original",
          },
        ],
      });
    });

    test("tenant predicates govern rows, aggregates, and included relations", async () => {
      const db = alice();
      expect(
        (await db.document.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        )
      ).toEqual(["alice-a", "bob-a"]);
      expect(
        await db.document.findUnique({ where: { id: "bob-b" } })
      ).toBeNull();
      expect(await db.document.count()).toBe(2);
      const rows = await db.organization.findMany({
        include: { documents: true, members: true },
      });
      expect(rows.map((row) => row.id)).toEqual(["a"]);
      expect(rows[0]?.documents.map((row) => row.id).sort()).toEqual([
        "alice-a",
        "bob-a",
      ]);
      expect(rows[0]?.members.map((row) => row.id)).toEqual(["alice-a"]);
    });

    test("unbound actors fail closed and simultaneous actor views remain isolated", async () => {
      const db = governed();
      await expect(db.document.findMany()).rejects.toBeInstanceOf(
        ValidationError
      );
      const views = [
        db.$as({ userId: "alice", organizationId: "a" }),
        db.$as({ userId: "bob", organizationId: "b" }),
      ];
      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          views[index % 2]!.document.findMany({ orderBy: { id: "asc" } })
        )
      );
      expect(answers.map((rows) => rows.map((row) => row.id))).toEqual(
        Array.from({ length: 8 }, (_, index) =>
          index % 2 ? ["bob-b"] : ["alice-a", "bob-a"]
        )
      );
    });

    test("bulk writes affect only owned rows within the bound tenant", async () => {
      expect(
        await alice().document.updateMany({ data: { title: "changed" } })
      ).toEqual({ count: 1 });
      expect(
        await base.document.findMany({
          orderBy: { id: "asc" },
          select: { id: true, title: true },
        })
      ).toEqual([
        { id: "alice-a", title: "changed" },
        { id: "bob-a", title: "original" },
        { id: "bob-b", title: "original" },
      ]);
      expect(await alice().document.deleteMany()).toEqual({ count: 1 });
      expect(await base.document.count()).toBe(2);
    });

    test("ownership changes and cross-tenant moves cannot escape placement", async () => {
      await expect(
        alice().document.update({
          where: { id: "alice-a" },
          data: { ownerId: "bob" },
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        alice().document.update({
          where: { id: "alice-a" },
          data: { organizationId: "b" },
        })
      ).rejects.toThrow();
      expect(
        await base.document.findUnique({ where: { id: "alice-a" } })
      ).toMatchObject({
        ownerId: "alice",
        organizationId: "a",
        title: "original",
      });
    });

    test("a rejected member of createMany leaves no partial insertion", async () => {
      await expect(
        alice().document.createMany({
          data: [
            {
              id: "new-allowed",
              ownerId: "alice",
              organizationId: "a",
              title: "new",
            },
            {
              id: "new-denied",
              ownerId: "alice",
              organizationId: "b",
              title: "new",
            },
          ],
        })
      ).rejects.toThrow();
      expect(await base.document.count()).toBe(3);
    });

    test("nested create and update cannot grant access through an authorized parent", async () => {
      await expect(
        alice().organization.update({
          where: { id: "a" },
          data: {
            documents: {
              create: { id: "nested-denied", ownerId: "bob", title: "new" },
            },
          },
        })
      ).rejects.toThrow();
      await expect(
        alice().organization.update({
          where: { id: "a" },
          data: {
            documents: {
              update: { where: { id: "bob-a" }, data: { title: "changed" } },
            },
          },
        })
      ).rejects.toThrow();
      expect(await base.document.count()).toBe(3);
      expect(
        (await base.document.findUnique({ where: { id: "bob-a" } }))?.title
      ).toBe("original");
    });

    test("a successful can check does not outlive a committed membership revocation", async () => {
      const db = alice();
      expect(await db.document.can("update", { id: "alice-a" })).toBe(true);
      await base.membership.delete({ where: { id: "alice-a" } });
      expect(await db.document.can("update", { id: "alice-a" })).toBe(false);
      await expect(
        db.document.update({
          where: { id: "alice-a" },
          data: { title: "changed" },
        })
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await base.document.findUnique({ where: { id: "alice-a" } }))?.title
      ).toBe("original");
    });

    test("revocation committed while a prepared write waits is judged when it executes", async () => {
      const reached = signal();
      const resume = signal();
      const db = alice().$extends({
        name: "pause-before-write",
        query: async ({ model, operation, proceed }) => {
          if (model === "document" && operation === "update") {
            reached.resolve();
            await resume.promise;
          }
          return proceed();
        },
      });
      const pending = db.document.update({
        where: { id: "alice-a" },
        data: { title: "changed" },
      });
      // Attach the rejection consumer before dispatch, so no rejection is unhandled.
      const refused = expect(pending).rejects.toBeInstanceOf(NotFoundError);
      try {
        await Promise.race([
          reached.promise,
          refused.then(() => {
            throw new Error("The write never reached the execution barrier");
          }),
        ]);
        await base.membership.delete({ where: { id: "alice-a" } });
      } finally {
        resume.resolve();
      }
      await refused;
      expect(
        (await base.document.findUnique({ where: { id: "alice-a" } }))?.title
      ).toBe("original");
    });
  });
}
