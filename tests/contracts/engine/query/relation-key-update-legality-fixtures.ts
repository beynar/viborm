// biome-ignore-all lint/suspicious/noMisplacedAssertion: expectParity is invoked only from test cases.
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { expect } from "vitest";

// The one schema and the one dual-substrate oracle every `relation-key-update-legality-*`
// slice runs on. `expectParity` runs each scenario twice — the live arm and the
// forced-batch arm — on the worker's ONE shared PGlite, each arm in its own private
// Postgres schema so it still starts from its own empty tables. The scenarios stay
// sliced across files by model family.

export const AUTHOR_ID_RELATION_KEY_ERROR = /relation key field 'authorId'/;
// M12: the general owned-foreign-key refusal, which precedes this file's rule wherever
// the rewritten relation key is the key the ENCLOSING relation owns.
/** N1 — the parse boundary omits the enclosing relation's own foreign key from nested
 *  update data, so the payload's key is unknown before an operation is constructed. */
export const POSTS_OWN_AUTHOR_ID_PARSE_ERROR = /Unknown key: authorId/;
export const CODE_RELATION_KEY_ERROR = /relation key field 'code'/;
export const ID_RELATION_KEY_ERROR = /relation key field 'id'/;
export const OCCUPIED_RELATION_ERROR = /current relation is occupied/;
export const SET_NULL_OCCUPIED_ERROR =
  /onUpdate\('setNull'\).*current relation is occupied/;
export const RESTRICT_OCCUPIED_ERROR =
  /onUpdate\('restrict'\).*current relation is occupied/;
export const TARGET_NOT_FOUND_ERROR =
  /target record was not found for this parent/;

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("relation_key_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    score: s.int(),
    authorId: s.int().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id")
      .onUpdate("cascade"),
  })
  .map("relation_key_posts");

const organization = s
  .model({
    id: s.int().id(),
    code: s.int().unique(),
    members: s.toMany(() => member),
  })
  .map("relation_key_organizations");

const member = s
  .model({
    id: s.int().id(),
    name: s.string(),
    organizationCode: s.int().nullable(),
    organization: s
      .toOne(() => organization)
      .fields("organizationCode")
      .references("code")
      .onUpdate("cascade"),
  })
  .map("relation_key_members");

// The NON-cascading sibling of organization/member: a rewritten non-PK referenced
// column whose nested create must take the post-SET value from the SET operand
// itself (UpdateOperation.resolveCreateParent's envelope unwrapping) — the cascade
// pair above never reaches that derivation (N5-U2: a cascading edge asks for no
// value at all).
const registry = s
  .model({
    id: s.int().id(),
    tag: s.int().unique(),
    entries: s.toMany(() => entry),
  })
  .map("relation_key_registries");

const entry = s
  .model({
    id: s.int().id(),
    name: s.string(),
    registryTag: s.int().nullable(),
    registry: s
      .toOne(() => registry)
      .fields("registryTag")
      .references("tag"),
  })
  .map("relation_key_entries");

const setNullParent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.toOne(() => setNullChild),
  })
  .map("relation_key_set_null_parents");

const setNullChild = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().unique().nullable(),
    parent: s
      .toOne(() => setNullParent)
      .fields("parentId")
      .references("id")
      .onUpdate("setNull"),
  })
  .map("relation_key_set_null_children");

// A NON-cascade ONE-TO-MANY: V1's occupied guard is cardinality-agnostic, so a
// child-held to-many under a referenced-PK transition rejects an occupied slot too.
const setNullList = s
  .model({
    id: s.int().id(),
    name: s.string(),
    items: s.toMany(() => setNullItem),
  })
  .map("relation_key_set_null_lists");

const setNullItem = s
  .model({
    id: s.int().id(),
    label: s.string(),
    listId: s.int().nullable(),
    list: s
      .toOne(() => setNullList)
      .fields("listId")
      .references("id")
      .onUpdate("setNull"),
  })
  .map("relation_key_set_null_items");

const restrictParent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.toOne(() => restrictChild),
  })
  .map("relation_key_restrict_parents");

const restrictChild = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().unique().nullable(),
    parent: s
      .toOne(() => restrictParent)
      .fields("parentId")
      .references("id")
      .onUpdate("restrict"),
  })
  .map("relation_key_restrict_children");

const cascadeParent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.toOne(() => cascadeChild),
  })
  .map("relation_key_cascade_parents");

const cascadeChild = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().unique().nullable(),
    parent: s
      .toOne(() => cascadeParent)
      .fields("parentId")
      .references("id")
      .onUpdate("cascade"),
  })
  .map("relation_key_cascade_children");

const sharedAccount = s
  .model({
    id: s.int().id(),
    name: s.string(),
    profile: s.toOne(() => sharedProfile),
  })
  .map("relation_key_shared_accounts");

const sharedProfile = s
  .model({
    id: s.int().id(),
    label: s.string(),
    account: s
      .toOne(() => sharedAccount)
      .fields("id")
      .references("id")
      .onUpdate("cascade"),
  })
  .map("relation_key_shared_profiles");

const schema = {
  author,
  post,
  organization,
  member,
  registry,
  entry,
  setNullParent,
  setNullChild,
  setNullList,
  setNullItem,
  restrictParent,
  restrictChild,
  cascadeParent,
  cascadeChild,
  sharedAccount,
  sharedProfile,
};

export type LegalityClient = ReturnType<typeof createLegalityClient>;

export interface Scenario {
  seed: (client: LegalityClient) => Promise<unknown>;
  act: (client: LegalityClient) => PromiseLike<unknown>;
  snapshot: (client: LegalityClient) => Promise<unknown>;
  expectedState: unknown;
}

interface Outcome {
  error: { name: string; message: string } | undefined;
  state: unknown;
}

export function createLegalityClient(driver: PGliteDriver) {
  return createClient({ schema, driver });
}

/**
 * ONE PGlite per worker, one private schema per execution substrate.
 *
 * The two arms need independent STATE, which two schemas give them; they never
 * needed two Wasm Postgres instances, and this harness used to build one per
 * scenario per arm. Each family truncates its own schema before every test, so a
 * scenario still seeds into empty tables on both arms.
 */
const getLiveFamily = usePGliteSchemaFamily(schema);
const getBatchFamily = usePGliteSchemaFamily(schema, "atomicBatch");

/**
 * The forced-batch arm's database and private schema, for the one scenario that
 * has to build its own batch driver (the missing-slot race in
 * `relation-key-update-legality-transition-arm.test.ts`). A driver built over the
 * shared database MUST carry the namespace: without it it addresses `public`,
 * where this suite has no tables.
 */
export function batchArmDriverOptions(): {
  client: PGlite;
  namespace: string;
} {
  const family = getBatchFamily();
  return { client: family.database, namespace: family.namespace };
}

async function runScenario(
  mode: "batch" | "live",
  scenario: Scenario
): Promise<Outcome> {
  const family = mode === "live" ? getLiveFamily() : getBatchFamily();
  const options = { client: family.database, namespace: family.namespace };
  const driver =
    mode === "live"
      ? new PGliteDriver(options)
      : new BatchOnlyPGliteDriver(options);
  const client = createLegalityClient(driver);
  try {
    await scenario.seed(client);
    let error: Outcome["error"];
    try {
      await scenario.act(client);
    } catch (failure) {
      error =
        failure instanceof Error
          ? { name: failure.name, message: failure.message }
          : { name: typeof failure, message: String(failure) };
    }
    return { error, state: await scenario.snapshot(client) };
  } finally {
    // Releases this arm's client only. The database was SUPPLIED, so the driver
    // never closes it, and the schema family owns both it and the schema.
    await client.$disconnect();
  }
}

export async function expectParity(
  scenario: Scenario,
  expectedError: RegExp | undefined,
  // Which typed refusal answers. `NestedWriteError` is this file's rule (CLASS IV, the
  // relation-key legality walk); a scenario whose payload is refused by a STRICTLY MORE
  // GENERAL rule first names that rule's class instead — see the M12 note below.
  expectedName = "NestedWriteError"
): Promise<void> {
  const live = await runScenario("live", scenario);
  const batch = await runScenario("batch", scenario);

  expect(batch.error).toEqual(live.error);
  if (expectedError) {
    expect(live.error?.name).toBe(expectedName);
    expect(live.error?.message).toMatch(expectedError);
  } else {
    expect(live.error).toBeUndefined();
  }
  expect(live.state).toEqual(scenario.expectedState);
  expect(batch.state).toEqual(scenario.expectedState);
}
