import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { MemoryEstateStorage } from "@migrations";
import { generateV1 as generate } from "@migrations/generate-v1";
import { s } from "@src/schema";
import { getSchemas } from "@src/schema/schemas";
import { validateSchema } from "@src/schema/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

/**
 * **The definition gate has ONE timing.**
 *
 * This suite used to pin a CLIFF. The same missing inverse failed in three
 * different places at three different times: never at client construction for an
 * ordinary schema, at `push`/CLI through the full rule set, and — for the very
 * same models plus one unrelated polymorphic model — back at client construction
 * again, because `hasPolymorphicRelations` decided how much of the rule set ran.
 * Ambiguity was not a definition failure at all; it surfaced as a
 * `QueryEngineError` when a query happened to bind the relation.
 *
 * Plan §7.3 deletes all of that: structural resolution runs at EVERY boundary
 * that can produce effects, and `skipValidation` may drop advice but never the
 * gate. So what this file pins now is the absence of the cliff — one schema, one
 * verdict, at every door — which is falsifier §11.2.7 and §11.3.10.
 */

class DefinitionDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();

  constructor() {
    super("postgresql", "definition-timing");
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The definition driver owns no provider resource.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

/** One lone ordinary slot: `folder.notes` has no inverse on `note` (§11.2.7). */
const loneOrdinarySlot = () => {
  const note = s.model({ id: s.string().id(), body: s.string() });
  const folder = s.model({
    id: s.string().id(),
    notes: s.toMany(() => note),
  });
  return { folder, note };
};

/** A variant carrier whose row identities cannot share one id column (§11.3.10). */
const malformedVariantIdentity = () => {
  const post = s.model({ id: s.string().id() });
  const clip = s.model({ id: s.int().id() });
  const comment = s.model({
    id: s.string().id(),
    subject: s.toOne({ post: () => post, clip: () => clip }),
  });
  return { post, clip, comment };
};

/** Two unnamed back-references: ambiguity, which used to be a query-time surprise. */
const ambiguousCandidates = () => {
  const user = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    editorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    editor: s
      .toOne(() => user)
      .fields("editorId")
      .references("id"),
  });
  return { user, post };
};

const migrationClient = (
  schema: Record<string, ReturnType<typeof s.model>>
) => {
  const driver = new DefinitionDriver();
  return { $driver: driver, $schema: schema };
};

describe.each([
  ["a lone ordinary slot", loneOrdinarySlot, "R002"],
  ["a malformed variant identity", malformedVariantIdentity, "P002"],
  ["an ambiguous inverse", ambiguousCandidates, "R009"],
])("%s is refused at every effect-capable boundary", (_title, build, code) => {
  it("fails definition validation with that one code", () => {
    const result = validateSchema(build());

    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(code);
  });

  it("fails client construction", () => {
    expect(() =>
      createClient({ schema: build(), driver: new DefinitionDriver() })
    ).toThrow("Schema validation failed");
  });

  it("fails registry-only construction, with no client anywhere", () => {
    expect(() => getSchemas(build())).toThrow("Schema validation failed");
  });

  it("fails migration generate before a snapshot is read", async () => {
    await expect(
      generate(migrationClient(build()), new MemoryEstateStorage())
    ).rejects.toThrow("Schema validation failed");
  });

  it("fails push", async () => {
    await expect(syncLiveSchema(migrationClient(build()))).rejects.toThrow(
      "Schema validation failed"
    );
  });

  it("fails push({ skipValidation: true }) — advice is skippable, the gate is not", async () => {
    await expect(
      syncLiveSchema(migrationClient(build()), { skipValidation: true })
    ).rejects.toThrow("Schema validation failed");
  });
});

describe("the polymorphic cliff", () => {
  it("no longer decides how much of the gate an ordinary schema gets", () => {
    // Same lone slot, once alone and once beside a well-formed variant carrier
    // that has nothing to do with it. HEAD ran one rule in the first case and
    // the complete rule set in the second; both now get the same gate.
    const ordinary = loneOrdinarySlot();
    const withVariant = {
      ...loneOrdinarySlot(),
      ...malformedVariantIdentity(),
    };

    for (const schema of [ordinary, withVariant]) {
      expect(
        validateSchema(schema).errors.map((issue) => issue.code)
      ).toContain("R002");
    }
  });
});
