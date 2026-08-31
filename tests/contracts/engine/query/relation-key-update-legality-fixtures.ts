// biome-ignore-all lint/suspicious/noMisplacedAssertion: expectParity is invoked only from test cases.
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect } from "vitest";

// The one schema and the one dual-substrate oracle every `relation-key-update-legality-*`
// slice runs on. `expectParity` opens TWO fresh databases per scenario — the live arm and
// the forced-batch arm — which is exactly why the scenarios are sliced across files by
// model family instead of living in one describe.

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

async function runScenario(
  mode: "batch" | "live",
  scenario: Scenario
): Promise<Outcome> {
  const database = openTestPGlite();
  const driver =
    mode === "live"
      ? new PGliteDriver({ client: database })
      : new BatchOnlyPGliteDriver({ client: database });
  const client = createLegalityClient(driver);
  try {
    await syncLiveSchema(client);
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
    await client.$disconnect();
    // Disconnecting a client does NOT release a borrowed Wasm database (see
    // pglite-lifecycle.ts), and this harness opens one per scenario per mode.
    await closeTestPGlite(database);
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
