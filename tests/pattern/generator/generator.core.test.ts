/**
 * Unit B's own test (pattern-engine-ideal-state.md §13.3): every generated
 * valid payload passes the parse boundary, the corpus is reproducible from its
 * seeds, shrinking terminates and preserves the failure, and every invalid
 * strategy is refused as a `ValidationError` by the same entry.
 */
import { ValidationError } from "@errors";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import {
  type GeneratedPayload,
  generateCorpus,
  generatePayload,
  ROOT_OPERATIONS,
  type SchemaMap,
  validatePayload,
} from "./generate";
import { INVALID_STRATEGIES, type InvalidStrategy, mutate } from "./invalid";
import { nodeCount, shrinkPayload } from "./shrink";

// =============================================================================
// THREE SMALL SCHEMAS
// =============================================================================

/** Ordinary edges: required and optional to-one, inverse to-one, to-many, self, implicit junction. */
const blogSchema = (): SchemaMap => {
  const user = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      role: s.enum(["admin", "member"]).default("member"),
      age: s.int().nullable(),
      posts: s.toMany(() => post),
      profile: s.toOne(() => profile),
    })
    .map("gen_users");
  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string().nullable(),
      userId: s.string().unique().nullable(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("gen_profiles");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      published: s.boolean().default(false),
      score: s.number().nullable(),
      meta: s.json().nullable(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => post)
        .fields("parentId")
        .references("id")
        .name("tree"),
      children: s.toMany(() => post).name("tree"),
      tags: s.toMany(() => tag),
    })
    .map("gen_posts");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("gen_tags");
  return { user, profile, post, tag };
};

/** Compound identities and a wider scalar vocabulary. */
const compoundSchema = (): SchemaMap => {
  const author = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      name: s.string(),
      rating: s.decimal({ precision: 10, scale: 2 }).nullable(),
      joinedAt: s.dateTime().now(),
      views: s.bigInt().default(BigInt(0)),
      labels: s.string().array(),
      posts: s.toMany(() => post),
    })
    .id(["tenantId", "id"])
    .map("gen_c_authors");
  const post = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      publishedOn: s.date().nullable(),
      tenantId: s.string().nullable(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("tenantId", "authorId")
        .references("tenantId", "id"),
    })
    .map("gen_c_posts");
  const account = s
    .model({
      id: s.string().id(),
      provider: s.string(),
      providerId: s.string(),
      memberships: s.toMany(() => membership),
    })
    .unique(["provider", "providerId"])
    .map("gen_c_accounts");
  const membership = s
    .model({
      id: s.string().id(),
      role: s.enum(["owner", "guest"]),
      accProvider: s.string().nullable(),
      accProviderId: s.string().nullable(),
      account: s
        .toOne(() => account)
        .fields("accProvider", "accProviderId")
        .references("provider", "providerId"),
    })
    .map("gen_c_memberships");
  return { author, post, account, membership };
};

/** Variant targets: a required and an optional row carrier, and a member collection. */
const variantSchema = (): SchemaMap => {
  const post = s
    .model({ id: s.string().id(), title: s.string() })
    .map("gen_v_posts");
  const video = s
    .model({ id: s.string().id(), url: s.string() })
    .map("gen_v_videos");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      subject: s.toOne({ post: () => post, video: () => video }),
    })
    .map("gen_v_comments");
  const note = s
    .model({
      id: s.string().id(),
      subject: s.toOne({ post: () => post, video: () => video }).optional(),
    })
    .map("gen_v_notes");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.toMany({ post: () => post, video: () => video }),
    })
    .map("gen_v_shelves");
  return { post, video, comment, note, shelf };
};

const CORPUS_SIZE = 500;
const SEED = 20_260_902;

const fixtures: readonly (readonly [string, SchemaMap])[] = [
  ["blog", blogSchema()],
  ["compound", compoundSchema()],
  ["variants", variantSchema()],
];

// =============================================================================
// HELPERS
// =============================================================================

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

type Path = readonly (string | number)[];

/** Every plain record inside `value`, as paths, in discovery order. */
function recordPaths(
  value: unknown,
  path: Path = [],
  out: Path[] = []
): Path[] {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      recordPaths(value[index], [...path, index], out);
    }
    return out;
  }
  if (!isPlainRecord(value)) return out;
  out.push(path);
  for (const key of Object.keys(value)) {
    recordPaths(value[key], [...path, key], out);
  }
  return out;
}

/** The same value with `__unexpected: 1` added to the record at `path`. */
function plantAt(value: unknown, path: Path): unknown {
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    return value.map((item, index) =>
      index === head ? plantAt(item, rest) : item
    );
  }
  if (!isPlainRecord(value)) return value;
  if (head === undefined) return { ...value, __unexpected: 1 };
  return { ...value, [head]: plantAt(value[head], rest) };
}

const plant = (
  payload: GeneratedPayload,
  path: Path
): GeneratedPayload | undefined => {
  const args = plantAt(payload.args, path);
  return isPlainRecord(args) ? { ...payload, args } : undefined;
};

const UNEXPECTED_KEY = /Unknown key: __unexpected/;

/** The failure SIGNATURE a differential would file: refused, for this key. */
const refusedForUnexpectedKey = (
  registry: ReturnType<typeof createSchemaRegistry>,
  schema: SchemaMap,
  payload: GeneratedPayload
): boolean => {
  try {
    validatePayload(registry, schema, payload);
    return false;
  } catch (error) {
    return (
      error instanceof ValidationError && UNEXPECTED_KEY.test(error.message)
    );
  }
};

const appliedByStrategy = new Map<InvalidStrategy, number>();

/** `<context>/<kind>` → the verbs spelled there across a corpus. */
const verbCoverage = (
  corpus: readonly GeneratedPayload[]
): Map<string, Set<string>> => {
  const coverage = new Map<string, Set<string>>();
  for (const payload of corpus) {
    for (const entry of payload.trail) {
      const key = `${entry.context}/${entry.kind}`;
      const verbs = coverage.get(key) ?? new Set<string>();
      for (const verb of entry.verbs) verbs.add(verb);
      coverage.set(key, verbs);
    }
  }
  return coverage;
};

// =============================================================================
// THE CONTRACT, PER SCHEMA
// =============================================================================

describe.each(fixtures)("payload generator over the %s schema", (_, schema) => {
  const registry = createSchemaRegistry(schema as Record<string, AnyModel>);
  const corpus = generateCorpus(schema, registry, SEED, CORPUS_SIZE);

  test(`${CORPUS_SIZE} seeded payloads pass the parse boundary`, () => {
    const failures: string[] = [];
    for (const payload of corpus) {
      try {
        validatePayload(registry, schema, payload);
      } catch (error) {
        failures.push(
          `${payload.model}.${payload.operation} seed=${payload.seed}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test("every root operation and every model is drawn", () => {
    const operations = new Set(corpus.map((payload) => payload.operation));
    const models = new Set(corpus.map((payload) => payload.model));
    expect([...operations].sort()).toEqual([...ROOT_OPERATIONS].sort());
    expect([...models].sort()).toEqual(Object.keys(schema).sort());
  });

  test("the same seed reproduces the same payload", () => {
    for (const payload of corpus.slice(0, 60)) {
      expect(generatePayload(schema, registry, payload.seed)).toEqual(payload);
    }
    const other = generateCorpus(schema, registry, SEED + 1, 20);
    expect(other.map((p) => p.args)).not.toEqual(
      corpus.slice(0, 20).map((p) => p.args)
    );
  });

  test("shrinking a failing payload terminates, stays failing, and is deterministic", () => {
    const fails = (payload: GeneratedPayload) =>
      refusedForUnexpectedKey(registry, schema, payload);
    const candidates = [...corpus]
      .sort((a, b) => nodeCount(b.args) - nodeCount(a.args))
      .slice(0, 5);
    for (const payload of candidates) {
      // Plant the unknown key in the deepest record whose schema refuses it
      // (a JSON document accepts any key, so the deepest record may not do).
      const planted = recordPaths(payload.args)
        .sort((a, b) => b.length - a.length)
        .map((path) => plant(payload, path))
        .find((candidate) => candidate !== undefined && fails(candidate));
      expect(planted).toBeDefined();
      if (!planted) return;
      const shrunk = shrinkPayload(planted, fails);
      expect(fails(shrunk.value)).toBe(true);
      expect(shrunk.steps).toBeGreaterThan(0);
      expect(nodeCount(shrunk.value.args)).toBeLessThan(
        nodeCount(planted.args)
      );
      expect(shrunk.attempts).toBeLessThan(50_000);
      expect(shrinkPayload(planted, fails).value).toEqual(shrunk.value);
    }
  });

  describe.each(INVALID_STRATEGIES)("invalid strategy %s", (strategy) => {
    test("is refused with a ValidationError by the parse boundary", () => {
      let applied = 0;
      for (const payload of corpus) {
        const mutant = mutate(strategy, payload, schema, registry);
        if (!mutant) continue;
        applied++;
        const run = () => validatePayload(registry, schema, mutant.payload);
        expect(run).toThrow(ValidationError);
        if (mutant.expect.message) expect(run).toThrow(mutant.expect.message);
        if (applied >= 25) break;
      }
      appliedByStrategy.set(
        strategy,
        (appliedByStrategy.get(strategy) ?? 0) + applied
      );
    });
  });
});

describe("invalid strategies across the three schemas", () => {
  test("every strategy applied to at least one payload", () => {
    const unapplied = INVALID_STRATEGIES.filter(
      (strategy) => (appliedByStrategy.get(strategy) ?? 0) === 0
    );
    expect(unapplied).toEqual([]);
  });
});

// =============================================================================
// VERB COVERAGE (blog schema, ordinary edges)
// =============================================================================

describe("verb coverage over the blog schema", () => {
  const schema = blogSchema();
  const registry = createSchemaRegistry(schema as Record<string, AnyModel>);
  const coverage = verbCoverage(
    generateCorpus(schema, registry, SEED, CORPUS_SIZE)
  );
  const verbsAt = (key: string): string[] =>
    [...(coverage.get(key) ?? new Set<string>())].sort();

  test("create-context bags spell every admitted verb", () => {
    expect(verbsAt("create/toOne")).toEqual(
      expect.arrayContaining(["create", "connect", "connectOrCreate"])
    );
    expect(verbsAt("create/toMany")).toEqual(
      expect.arrayContaining([
        "create",
        "createMany",
        "connect",
        "connectOrCreate",
        "upsert",
      ])
    );
  });

  test("update-context bags spell every admitted verb, removal verbs included", () => {
    expect(verbsAt("update/toOne")).toEqual(
      expect.arrayContaining([
        "create",
        "connect",
        "connectOrCreate",
        "update",
        "upsert",
        "disconnect",
        "delete",
      ])
    );
    expect(verbsAt("update/toMany")).toEqual(
      expect.arrayContaining([
        "create",
        "createMany",
        "connect",
        "connectOrCreate",
        "set",
        "disconnect",
        "delete",
        "update",
        "updateMany",
        "upsert",
        "deleteMany",
      ])
    );
  });

  test("filters and projections reach both cardinalities", () => {
    expect(verbsAt("filter/toOne")).toEqual(
      expect.arrayContaining(["is", "isNot", "shorthand"])
    );
    expect(verbsAt("filter/toMany")).toEqual(
      expect.arrayContaining(["some", "every", "none"])
    );
    expect(verbsAt("select/toOne").length).toBeGreaterThan(0);
    expect(verbsAt("select/toMany").length).toBeGreaterThan(0);
  });
});
