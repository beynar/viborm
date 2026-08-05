import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import {
  literalParentId,
  perFieldParentId,
  type UpsertParentBinding,
} from "../../src/query-engine/write-engine/RelationUpsertPart";
import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "./e4-compound-adopt-behavior";

/**
 * E4-U2 on both substrates, plus the two things only this file can say: the
 * per-component refusal, and the STRUCTURAL proof that the per-field source cannot
 * reach a correlated consumer.
 *
 * The E0 audit named that composition the wave's single silent-collapse risk: a
 * `correlated` part compares the located row's foreign key against the parent AT
 * COMPILE, per column, and a source it could not read per column would have to be read
 * some other way — the "some other way" being exactly the collapse. The engine does not
 * defend against it at runtime; the type refuses to express it. See
 * {@link UpsertParentBinding}.
 */

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

async function setup(driver: PGliteDriver) {
  const client = createClient({ schema: compoundAdoptSchema, driver }) as any;
  await push(client, { force: true });
  return client;
}

const substrates = [
  {
    name: "transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

for (const substrate of substrates) {
  // One client per leg: the schema is migrated once and each test resets by DELETE.
  let shared: any;
  registerCompoundAdoptBehavior(substrate.name, async () => {
    shared ??= await setup(substrate.make());
    return shared;
  });
}

describe("E4-U2 the boundary the per-field source did not move", () => {
  test("the many-to-many junction keeps the single-parent-column refusal", async () => {
    // `edgeParentId` still exists, and still refuses arity > 1 — for the junction, whose
    // join row keys its parent half with ONE column
    // (`getManyToManyJoinInfo` → `getRequiredSinglePrimaryKeyField`). The message is the
    // same sentence; what changed is that only the m2m branch can still reach it.
    const source = await import(
      "../../src/query-engine/write-engine/CreateOperation"
    );
    expect(typeof source.CreateOperation).toBe("function");
    const text = await (await import("node:fs/promises")).readFile(
      new URL(
        "../../src/query-engine/write-engine/CreateOperation.ts",
        import.meta.url
      ),
      "utf8"
    );
    // The adopt kinds no longer call it; the junction does. One caller, one reason.
    const junctionCalls = text.split("this.edgeParentId(").length - 1;
    expect(junctionCalls).toBe(1);
  });

  test("a correlated binding cannot be given a per-field source (type-level)", () => {
    // THE STRUCTURAL PROOF. These two are the whole statement, and they are checked by
    // `tsc --noEmit`, not by this assertion: the first must compile, the second must not.
    const globalAdopt: UpsertParentBinding = {
      correlation: "global-adopt",
      parentId: perFieldParentId({ region: literalParentId("eu") }),
    };
    // @ts-expect-error a correlated part reads its parent per column at compile, so the
    // binding offers it the whole-value kinds only; a per-field source is not one.
    const correlated: UpsertParentBinding = {
      correlation: "correlated",
      parentId: perFieldParentId({ region: literalParentId("eu") }),
    };
    expect(globalAdopt.parentId.kind).toBe("per-field");
    expect(correlated.correlation).toBe("correlated");
  });
});
