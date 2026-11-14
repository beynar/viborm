import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@drivers/sqlite3";
import { ForbiddenError } from "@errors";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { expect, test } from "vitest";

const owned = () =>
  s.model({ id: s.string().id(), ownerId: s.string() }).map("post");
const audit = () => s.model({ id: s.string().id() }).map("audit");
const ownerPolicy = () =>
  permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      post: {
        read: { ownerId: { actor: "userId" } },
        update: { ownerId: { actor: "userId" } },
      },
    },
  });

test("one policy over two schemas keeps each schema's unlisted models closed", async () => {
  const policy = ownerPolicy();
  const small = createClient({
    schema: { post: owned() },
    dataDir: ":memory:",
  });
  const large = createClient({
    schema: { post: owned(), audit: audit() },
    dataDir: ":memory:",
  });
  try {
    await syncLiveSchema(small);
    await syncLiveSchema(large);
    await small.post.create({ data: { id: "s1", ownerId: "alice" } });
    await large.post.create({ data: { id: "l1", ownerId: "alice" } });
    await large.audit.create({ data: { id: "a1" } });
    const first = small.$extends(policy).$as({ userId: "alice" });
    expect(await first.post.findMany()).toEqual([
      { id: "s1", ownerId: "alice" },
    ]);
    const second = large.$extends(policy).$as({ userId: "alice" });
    expect(await second.post.findMany()).toEqual([
      { id: "l1", ownerId: "alice" },
    ]);
    await expect(second.audit.findMany()).rejects.toBeInstanceOf(
      ForbiddenError
    );
  } finally {
    await small.$disconnect();
    await large.$disconnect();
  }
});

test("a schema object that gained a model after the policy was applied keeps that model closed", async () => {
  const policy = ownerPolicy();
  const schema = { post: owned() };
  const before = createClient({ schema, dataDir: ":memory:" });
  try {
    await syncLiveSchema(before);
    before.$extends(policy);
  } finally {
    await before.$disconnect();
  }
  // The client prepares a schema object again when it gained a model since
  // (client.ts `reusablePreparation`): a supported path, not a hostile edit.
  const grown = Object.assign(schema, { audit: audit() });
  const after = createClient({ schema: grown, dataDir: ":memory:" });
  try {
    await syncLiveSchema(after);
    await after.audit.create({ data: { id: "a1" } });
    const scoped = after.$extends(policy).$as({ userId: "alice" });
    // R9: a model the policy does not list is read by nobody.
    await expect(scoped.audit.findMany()).rejects.toBeInstanceOf(
      ForbiddenError
    );
  } finally {
    await after.$disconnect();
  }
});

test("clients created per request share the policy and never another request's actor", async () => {
  const policy = ownerPolicy();
  const schema = { post: owned() };
  const file = join(
    mkdtempSync(join(tmpdir(), "viborm-permissions-")),
    "requests.db"
  );
  const seed = createClient({ schema, dataDir: file });
  try {
    await syncLiveSchema(seed);
    await seed.post.createMany({
      data: [
        { id: "a", ownerId: "alice" },
        { id: "b", ownerId: "bob" },
      ],
    });
  } finally {
    await seed.$disconnect();
  }
  // A Worker builds its client per request over one shared database.
  const request = async (userId: string) => {
    const client = createClient({ schema, dataDir: file });
    try {
      return await client
        .$extends(policy)
        .$as({ userId })
        .post.findMany({ select: { id: true } });
    } finally {
      await client.$disconnect();
    }
  };
  const answers = await Promise.all(
    ["alice", "bob", "carol", "alice"].map(request)
  );
  expect(answers).toEqual([[{ id: "a" }], [{ id: "b" }], [], [{ id: "a" }]]);
});

test("an extension after $as and a transaction keep the bound actor", async () => {
  const policy = ownerPolicy();
  const base = createClient({ schema: { post: owned() }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "a", ownerId: "alice" },
        { id: "b", ownerId: "bob" },
      ],
    });
    const witness = { name: "witness", client: () => ({ $witness: () => 1 }) };
    const alice = base.$extends(policy).$as({ userId: "alice" });
    const extended = alice.$extends(witness);
    const bob = base.$extends(policy).$as({ userId: "bob" });
    const [inTx, outTx, other] = await Promise.all([
      extended.$transaction((tx) => tx.post.findMany({ select: { id: true } })),
      extended.post.findMany({ select: { id: true } }),
      bob.$transaction((tx) => tx.post.findMany({ select: { id: true } })),
    ]);
    expect(inTx).toEqual([{ id: "a" }]);
    expect(outTx).toEqual([{ id: "a" }]);
    expect(other).toEqual([{ id: "b" }]);
    expect(
      await alice.post.updateMany({ where: {}, data: { ownerId: "alice" } })
    ).toEqual({ count: 1 });
  } finally {
    await base.$disconnect();
  }
});

test("mutating compile()'s inspection result changes no client's permissions", async () => {
  const config = {
    actor: v.object({ userId: v.string() }),
    models: {
      post: { read: { ownerId: { in: ["alice"] } } },
    },
  } as const;
  const policy = permissions(config);
  const schema = { post: owned() };
  const base = createClient({ schema, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "a", ownerId: "alice" },
        { id: "b", ownerId: "bob" },
      ],
    });
    const applied = base.$extends(policy).$as({ userId: "x" });
    const inspection = policy.compile(schema);
    let widened = 0;
    const widen = (value: unknown) => {
      if (Array.isArray(value) && value.includes("alice")) {
        value.push("bob");
        widened++;
      } else if (value !== null && typeof value === "object")
        for (const item of Object.values(value)) widen(item);
    };
    widen(inspection.models.post!.predicates);
    expect(widened).toBeGreaterThan(0);
    expect(await applied.post.findMany({ select: { id: true } })).toEqual([
      { id: "a" },
    ]);
  } finally {
    await base.$disconnect();
  }
});

test("a duplicate name of a model first used later is refused when the policy is applied", () => {
  const base = createClient({ schema: { post: owned() }, dataDir: ":memory:" });
  const policy = permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      post: {
        read: true,
        domains: { read: { ownerId: { actor: "userId" } } },
      },
    },
  } as never);
  expect(() => base.$extends(policy as never)).toThrow(
    'already has the name "read"'
  );
});

test("a schema object whose model was swapped after the policy was applied keeps a new related model closed", async () => {
  const policy = ownerPolicy();
  const schema = { post: owned() };
  const before = createClient({ schema, dataDir: ":memory:" });
  try {
    before.$extends(policy);
  } finally {
    await before.$disconnect();
  }
  const note = s
    .model({
      id: s.string().id(),
      postId: s.string(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("note");
  const post = s
    .model({
      id: s.string().id(),
      ownerId: s.string(),
      notes: s.toMany(() => note),
    })
    .map("post");
  // The same schema object, its `post` swapped: typed as what it now holds.
  const swapped = schema as unknown as { post: typeof post; note: typeof note };
  swapped.post = post;
  swapped.note = note;
  const after = createClient({ schema: swapped, dataDir: ":memory:" });
  try {
    await syncLiveSchema(after);
    await after.post.create({ data: { id: "p", ownerId: "alice" } });
    await after.note.create({ data: { id: "secret", postId: "p" } });
    const scoped = after.$extends(policy).$as({ userId: "alice" });
    // R9: the notes are unlisted, so no relation reaches one of them.
    expect(
      await scoped.post.findMany({
        select: { id: true, notes: { select: { id: true } } },
      })
    ).toEqual([{ id: "p", notes: [] }]);
  } finally {
    await after.$disconnect();
  }
});

test("the rows a policy hands the host are deeply frozen copies, so core reuses their admission and cache digest", () => {
  // Core memoises an admission (admission.ts `isImmutableRows`) and a cache
  // key's digest (cache-flow.ts `rowsIdentity`) for deeply frozen rows only.
  // Unfrozen, a cached hit re-serialises the whole policy: 0.04 → 1.0 ms
  // per hit for 20 models, measured.
  const config = {
    actor: v.object({ userId: v.string() }),
    models: {
      post: { read: { ownerId: { in: ["alice"] } } },
    },
  } as const;
  const base = createClient({ schema: { post: owned() }, dataDir: ":memory:" });
  let definition: { rows: { verbs: Record<string, unknown> } } | undefined;
  permissions(config).rows(
    new Proxy(base, {
      get(target, key, receiver) {
        if (key === "$extends")
          return (value: typeof definition) => {
            definition = value;
            return base;
          };
        return Reflect.get(target, key, receiver);
      },
    }) as never
  );
  const deeplyFrozen = (value: unknown): boolean =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
  expect(deeplyFrozen(definition!.rows)).toBe(true);
  const entry = (definition!.rows.verbs.post as () => unknown)();
  expect(deeplyFrozen(entry)).toBe(true);
  expect(Object.isFrozen(config.models.post.read.ownerId.in)).toBe(false);
});
