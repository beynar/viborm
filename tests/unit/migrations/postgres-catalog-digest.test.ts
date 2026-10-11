/**
 * The PostgreSQL catalog digest (plan D5, decision 7) is `fingerprintLive` of
 * a full introspection, computed by the server in one statement: on PGlite,
 * for every schema of the corpus, pushed into a schema of its own, and again
 * after the catalog drifts behind the estate's back. Where the digest cannot
 * reproduce a fact exactly it abstains, and the caller introspects: a partial
 * index is the witness. A digest that disagrees with an introspection that
 * matches the snapshot is VibORM's defect, said as such, never drift.
 *
 * `postgres-catalog-digest-docker.test.ts` proves the same corpus on a real
 * PostgreSQL server.
 */

import { createClient } from "@drivers/pglite";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { postgresCatalogDigest } from "@migrations/drivers/postgres/catalog-digest";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  catalogDigestCorpus,
  digestAndFingerprint,
} from "./_catalog-digest-corpus";

vi.mock(
  "@migrations/drivers/postgres/catalog-digest",
  async (
    original: () => Promise<
      typeof import("@migrations/drivers/postgres/catalog-digest")
    >
  ) => {
    const actual = await original();
    return {
      ...actual,
      postgresCatalogDigest: vi.fn(actual.postgresCatalogDigest),
    };
  }
);

const database = openTestPGlite();

beforeAll(() => database.waitReady);

describe("the catalog digest equals fingerprintLive of an introspection", () => {
  for (const [index, item] of catalogDigestCorpus.entries()) {
    it(item.id, async () => {
      const namespace = `digest_${index}`;
      await database.exec(`CREATE SCHEMA "${namespace}"`);
      const orm = createClient({
        client: database,
        schema: item.build(),
        namespace,
      });
      await createMigrationClient(orm).push();
      const pushed = await digestAndFingerprint(orm);
      expect(pushed.digest).toBe(pushed.fingerprint);

      for (const statement of item.drift) {
        await database.exec(statement.replaceAll("{ns}", namespace));
      }
      const drifted = await digestAndFingerprint(orm);
      expect(drifted.digest).toBe(drifted.fingerprint);
      if (item.drift.length > 0) {
        expect(drifted.digest).not.toBe(pushed.digest);
      }
    });
  }

  it("reads only the managed tables a scoped client lists, and their enums", async () => {
    await database.exec(`CREATE SCHEMA "digest_scoped"`);
    await database.exec(
      `CREATE TYPE "digest_scoped"."legacy_kind" AS ENUM ('a', 'b');
       CREATE TABLE "digest_scoped"."legacy" ("id" text PRIMARY KEY, "kind" "digest_scoped"."legacy_kind")`
    );
    const orm = createClient({
      client: database,
      schema: {
        account: s
          .model({
            id: s.string().id(),
            state: s.enum(["on", "off"]).default("on"),
          })
          .map("accounts"),
      },
      namespace: "digest_scoped",
    });
    await createMigrationClient(orm, { tables: ["accounts"] }).push();
    const scoped = await digestAndFingerprint(orm, ["accounts"]);
    expect(scoped.digest).toBe(scoped.fingerprint);

    // A table outside the list is not the estate's: its change is no drift.
    await database.exec(
      `ALTER TABLE "digest_scoped"."legacy" ADD COLUMN "note" text`
    );
    expect((await digestAndFingerprint(orm, ["accounts"])).digest).toBe(
      scoped.digest
    );
    const whole = await digestAndFingerprint(orm);
    expect(whole.digest).toBe(whole.fingerprint);
    expect(whole.digest).not.toBe(scoped.digest);
  });

  it("abstains on a partial index, whose predicate only a scratch view canonicalizes", async () => {
    await database.exec(`CREATE SCHEMA "digest_partial"`);
    const orm = createClient({
      client: database,
      schema: {
        account: s
          .model({ id: s.string().id(), email: s.string().nullable() })
          .index(["email"], { where: `"email" IS NOT NULL` })
          .map("accounts"),
      },
      namespace: "digest_partial",
    });
    await createMigrationClient(orm).push();

    expect((await digestAndFingerprint(orm)).digest).toBeUndefined();
  });

  it("a digest that disagrees with a matching introspection is a defect, not drift", async () => {
    await database.exec(`CREATE SCHEMA "digest_defect"`);
    const storage = new MemoryEstateStorage();
    const migrations = (fields: Parameters<typeof s.model>[0]) =>
      createMigrationClient(
        createClient({
          client: database,
          schema: { account: s.model(fields).map("accounts") },
          namespace: "digest_defect",
        }),
        { storage }
      );
    const first = migrations({ id: s.string().id() });
    await first.generate({ name: "base" });
    await first.apply();
    const next = migrations({
      id: s.string().id(),
      note: s.string().nullable(),
    });
    await next.generate({ name: "note" });

    vi.mocked(postgresCatalogDigest).mockResolvedValueOnce("0".repeat(64));
    await expect(next.apply()).rejects.toMatchObject({
      code: "V9001",
      message: expect.stringContaining("catalog digest"),
    });
    expect((await next.apply()).outcome).toBe("applied");
  });
});
