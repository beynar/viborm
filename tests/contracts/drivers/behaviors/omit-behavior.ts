import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { ValidationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const account = s
  .model({
    id: s.string().id(),
    email: s.string(),
    passwordHash: s.string(),
    displayName: s.string(),
    notes: s.oneToMany(() => note),
  })
  .map("omit_accounts");

const note = s
  .model({
    id: s.string().id(),
    body: s.string(),
    draft: s.string(),
    accountId: s.string(),
    account: s
      .manyToOne(() => account)
      .fields("accountId")
      .references("id"),
  })
  .map("omit_notes");

const vaulted = s
  .model({
    id: s.string().id(),
    label: s.string(),
    secret: s.string(),
  })
  .omit({ secret: true })
  .map("omit_vaulted");

const schema = { account, note, vaulted };

type OmitClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};
type OmitClient = VibORMClient<OmitClientConfig>;

export interface OmitBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * `omit` end-to-end, per driver (W5-U4).
 *
 * The point of running this live rather than only at the parse boundary is that
 * `omit` is a PROJECTION: the column has to be missing from the SQL, not merely
 * deleted from the parsed row. Every assertion below therefore reads a value
 * that exists in the table and checks the key is absent from the answer —
 * `toEqual` on the whole object, not `toBeUndefined()` on one key, so an extra
 * key fails the test.
 *
 * That whole-object equality is what proves the SQL, not just the parse: the
 * result parser REFUSES a row carrying a known scalar the request did not ask
 * for ("rejects known but unrequested … scalar columns",
 * `tests/query-engine/request-result-shape-contracts.test.ts`). A projection
 * that still fetched the column would therefore throw here rather than quietly
 * pass — the assertions below cannot be satisfied by post-hoc key deletion.
 *
 * Three layers are exercised together because their INTERACTION is the contract:
 *  - query-level `omit`, on reads and on every write that returns a row;
 *  - client-level `omit` (`createClient({ omit: … })`), including the per-field
 *    `{ field: false }` re-include and the "an explicit `select` wins" rule;
 *  - model-level `.omit()`, which neither of the other two can undo.
 */
export function runOmitBehavior({
  driverName,
  createDriver,
}: OmitBehaviorOptions) {
  describe(`${driverName} omit`, () => {
    let client: OmitClient | undefined;
    let driver: AnyDriver | undefined;

    const seed = async (target: OmitClient) => {
      await target.account.create({
        data: {
          id: "a1",
          email: "ada@example.com",
          passwordHash: "hash-1",
          displayName: "Ada",
        },
      });
      await target.note.createMany({
        data: [
          { id: "n1", body: "first", draft: "wip-1", accountId: "a1" },
          { id: "n2", body: "second", draft: "wip-2", accountId: "a1" },
        ],
      });
      await target.vaulted.create({
        data: { id: "v1", label: "keys", secret: "s3cr3t" },
      });
    };

    beforeEach(async () => {
      driver = createDriver();
      client = createClient({ schema, driver });
      await push(client, { force: true });
      await seed(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
      driver = undefined;
    });

    /**
     * A SECOND client over the SAME driver, differing only in its `omit`
     * config. Same connection, same rows, same schema — so every difference
     * below is attributable to the option and nothing else.
     */
    const withClientOmit = () =>
      createClient({
        schema,
        driver: driver as AnyDriver,
        omit: { account: { passwordHash: true }, note: { draft: true } },
      });

    // -----------------------------------------------------------------------
    // Query-level
    // -----------------------------------------------------------------------

    test("findMany drops exactly the omitted scalar", async () => {
      const rows = await client!.account.findMany({
        omit: { passwordHash: true },
      });
      expect(rows).toEqual([
        { id: "a1", email: "ada@example.com", displayName: "Ada" },
      ]);
    });

    test("findUnique / findFirst honor omit", async () => {
      expect(
        await client!.account.findUnique({
          where: { id: "a1" },
          omit: { passwordHash: true, displayName: true },
        })
      ).toEqual({ id: "a1", email: "ada@example.com" });

      expect(
        await client!.account.findFirst({ omit: { passwordHash: true } })
      ).toEqual({ id: "a1", email: "ada@example.com", displayName: "Ada" });
    });

    test("omit composes with include, and the relation keeps its own shape", async () => {
      const rows = await client!.account.findMany({
        omit: { passwordHash: true },
        include: { notes: { orderBy: { id: "asc" } } },
      });
      expect(rows).toEqual([
        {
          id: "a1",
          email: "ada@example.com",
          displayName: "Ada",
          notes: [
            { id: "n1", body: "first", draft: "wip-1", accountId: "a1" },
            { id: "n2", body: "second", draft: "wip-2", accountId: "a1" },
          ],
        },
      ]);
    });

    test("nested omit reduces the relation payload only", async () => {
      const rows = await client!.account.findMany({
        include: { notes: { omit: { draft: true }, orderBy: { id: "asc" } } },
      });
      expect(rows).toEqual([
        {
          id: "a1",
          email: "ada@example.com",
          passwordHash: "hash-1",
          displayName: "Ada",
          notes: [
            { id: "n1", body: "first", accountId: "a1" },
            { id: "n2", body: "second", accountId: "a1" },
          ],
        },
      ]);
    });

    test("omit at both levels applies independently", async () => {
      const rows = await client!.account.findMany({
        omit: { passwordHash: true, displayName: true },
        include: {
          notes: {
            omit: { draft: true, accountId: true },
            orderBy: { id: "asc" },
          },
        },
      });
      expect(rows).toEqual([
        {
          id: "a1",
          email: "ada@example.com",
          notes: [
            { id: "n1", body: "first" },
            { id: "n2", body: "second" },
          ],
        },
      ]);
    });

    // -----------------------------------------------------------------------
    // Writes that return a row
    // -----------------------------------------------------------------------

    test("create / update / upsert / delete honor omit", async () => {
      expect(
        await client!.account.create({
          data: {
            id: "a2",
            email: "grace@example.com",
            passwordHash: "hash-2",
            displayName: "Grace",
          },
          omit: { passwordHash: true },
        })
      ).toEqual({ id: "a2", email: "grace@example.com", displayName: "Grace" });

      expect(
        await client!.account.update({
          where: { id: "a2" },
          data: { displayName: "Grace H" },
          omit: { passwordHash: true, email: true },
        })
      ).toEqual({ id: "a2", displayName: "Grace H" });

      expect(
        await client!.account.upsert({
          where: { id: "a2" },
          create: {
            id: "a2",
            email: "x@example.com",
            passwordHash: "x",
            displayName: "x",
          },
          update: { displayName: "Grace Hopper" },
          omit: { passwordHash: true },
        })
      ).toEqual({
        id: "a2",
        email: "grace@example.com",
        displayName: "Grace Hopper",
      });

      expect(
        await client!.account.delete({
          where: { id: "a2" },
          omit: { passwordHash: true, email: true },
        })
      ).toEqual({ id: "a2", displayName: "Grace Hopper" });
    });

    test("a bulk write with omit returns the projected rows, not a count", async () => {
      const created = await client!.note.createMany({
        data: [{ id: "n3", body: "third", draft: "wip-3", accountId: "a1" }],
        omit: { draft: true },
      });
      expect(created).toEqual([{ id: "n3", body: "third", accountId: "a1" }]);

      const updated = await client!.note.updateMany({
        where: { id: "n3" },
        data: { body: "third!" },
        omit: { draft: true, accountId: true },
      });
      expect(updated).toEqual([{ id: "n3", body: "third!" }]);

      const deleted = await client!.note.deleteMany({
        where: { id: "n3" },
        omit: { draft: true, accountId: true },
      });
      expect(deleted).toEqual([{ id: "n3", body: "third!" }]);
    });

    test("a bulk write WITHOUT a projection still counts", async () => {
      expect(
        await client!.note.updateMany({
          where: { id: "n1" },
          data: { body: "edited" },
        })
      ).toEqual({ count: 1 });
    });

    // -----------------------------------------------------------------------
    // Refusals
    // -----------------------------------------------------------------------

    test("select + omit is refused before any I/O", async () => {
      await expect(
        client!.account.findMany({
          select: { id: true },
          omit: { passwordHash: true },
        } as never)
      ).rejects.toThrow(ValidationError);
    });

    test("an omit that hides every field is refused", async () => {
      await expect(
        client!.vaulted.findMany({ omit: { id: true, label: true } })
      ).rejects.toThrow(ValidationError);
    });

    // -----------------------------------------------------------------------
    // Model-level `.omit()` — the layer nothing above it can undo
    // -----------------------------------------------------------------------

    test("a model-level omitted column never comes back", async () => {
      expect(await client!.vaulted.findMany({})).toEqual([
        { id: "v1", label: "keys" },
      ]);
      expect(await client!.vaulted.findMany({ omit: { label: true } })).toEqual(
        [{ id: "v1" }]
      );
    });

    test("neither select nor omit can re-include it", async () => {
      await expect(
        client!.vaulted.findMany({ select: { secret: true } } as never)
      ).rejects.toThrow(ValidationError);
      await expect(
        client!.vaulted.findMany({ omit: { secret: false } } as never)
      ).rejects.toThrow(ValidationError);
    });

    // -----------------------------------------------------------------------
    // Client-level
    // -----------------------------------------------------------------------

    test("client-level omit hides the field on every read of that model", async () => {
      const scoped = withClientOmit();
      expect(await scoped.account.findMany({})).toEqual([
        { id: "a1", email: "ada@example.com", displayName: "Ada" },
      ]);
      expect(await scoped.account.findUnique({ where: { id: "a1" } })).toEqual({
        id: "a1",
        email: "ada@example.com",
        displayName: "Ada",
      });
    });

    test("client-level omit reaches relation payloads", async () => {
      const scoped = withClientOmit();
      expect(
        await scoped.account.findMany({
          include: { notes: { orderBy: { id: "asc" } } },
        })
      ).toEqual([
        {
          id: "a1",
          email: "ada@example.com",
          displayName: "Ada",
          notes: [
            { id: "n1", body: "first", accountId: "a1" },
            { id: "n2", body: "second", accountId: "a1" },
          ],
        },
      ]);
    });

    test("a local omit: { field: false } re-includes a globally hidden field", async () => {
      const scoped = withClientOmit();
      expect(
        await scoped.account.findMany({ omit: { passwordHash: false } })
      ).toEqual([
        {
          id: "a1",
          email: "ada@example.com",
          passwordHash: "hash-1",
          displayName: "Ada",
        },
      ]);
    });

    test("a local omit adds to the global one instead of replacing it", async () => {
      const scoped = withClientOmit();
      expect(
        await scoped.account.findMany({ omit: { displayName: true } })
      ).toEqual([{ id: "a1", email: "ada@example.com" }]);
    });

    test("an explicit select overrides the client default", async () => {
      const scoped = withClientOmit();
      expect(
        await scoped.account.findMany({
          select: { id: true, passwordHash: true },
        })
      ).toEqual([{ id: "a1", passwordHash: "hash-1" }]);
    });

    test("client-level omit does not turn a bulk write into a row-returning one", async () => {
      const scoped = withClientOmit();
      expect(
        await scoped.note.updateMany({
          where: { id: "n2" },
          data: { body: "edited" },
        })
      ).toEqual({ count: 1 });
    });

    test("a client that configures nothing is unaffected", async () => {
      expect(await client!.account.findMany({})).toEqual([
        {
          id: "a1",
          email: "ada@example.com",
          passwordHash: "hash-1",
          displayName: "Ada",
        },
      ]);
    });
  });
}

export const omitContract = defineContract({
  id: "drivers.omit",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runOmitBehavior,
});
