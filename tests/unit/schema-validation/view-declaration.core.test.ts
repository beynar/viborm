/**
 * `view` at the schema: the model a view derives from its source and its
 * query (scalars, keys, JSON columns), and what definition validation refuses
 * on one (W001-W004), with the census that keeps that list closed. The read
 * that defines it is compiled by the migration layer and read back by the
 * client; neither is this layer's.
 */

import { isDeepStrictEqual } from "node:util";
import { s } from "@src/schema";
import { type AnyModel, Model } from "@src/schema/model";
import { getModelKeyCatalog } from "@src/schema/model/keys";
import { resolveSchemaOrThrow, validateSchema } from "@src/schema/validation";
import { viewFacts } from "@src/schema/view/facts";
import { describe, expect, it } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    secret: s.string(),
    posts: s.toMany(() => post),
  })
  .omit({ secret: true });
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  published: s.boolean(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const membership = s
  .model({ userId: s.string(), teamId: s.string(), role: s.string() })
  .id(["userId", "teamId"])
  .unique(["teamId", "role"], { name: "seat" });

const codes = (result: ReturnType<typeof validateSchema>) =>
  result.errors.map(({ code }) => code);
const scalarsOf = (model: typeof post | ReturnType<typeof s.view>) =>
  Object.keys(model["~"].state.scalars);

describe("a view's derived model", () => {
  it("holds the scalars its selection names, by the source's own objects, in the source's order", () => {
    const subject = s.view(() => post, {
      select: { title: true, id: true, published: false },
    });
    expect(scalarsOf(subject)).toEqual(["id", "title"]);
    expect(subject["~"].state.scalars.title).toBe(
      post["~"].state.scalars.title
    );
    expect(subject["~"].state.shape).toBe(subject["~"].state.scalars);
    expect(subject["~"].state.relations).toEqual({});
  });

  it("holds every scalar a read projects when it selects nothing: not the omitted ones", () => {
    expect(scalarsOf(s.view(() => user, {}))).toEqual(["id", "name", "email"]);
    expect(scalarsOf(s.view(() => user, { omit: { email: true } }))).toEqual([
      "id",
      "name",
    ]);
  });

  it("names each non-scalar selection as a JSON column", () => {
    const selected = s.view(() => post, {
      select: {
        id: true,
        author: { select: { name: true } },
        _count: { select: { author: true } },
      },
    });
    expect(viewFacts(selected)?.documents).toEqual(["author", "_count"]);
    const included = s.view(() => user, { include: { posts: true } });
    expect(viewFacts(included)?.documents).toEqual(["posts"]);
    expect(viewFacts(post)).toBeUndefined();
  });

  it("has no column for a _count that counts no relation, as a read has no key", () => {
    const documentsOf = (declared: ReturnType<typeof s.view>) =>
      viewFacts(declared)?.documents;
    expect(
      documentsOf(s.view(() => post, { include: { _count: true } }))
    ).toEqual([]);
    expect(
      documentsOf(s.view(() => post, { select: { id: true, _count: true } }))
    ).toEqual([]);
    expect(
      documentsOf(s.view(() => user, { include: { _count: true } }))
    ).toEqual(["_count"]);
    const counted = s.view(() => user, {
      select: { id: true, _count: { select: { posts: true } } },
    });
    expect(documentsOf(counted)).toEqual(["_count"]);
    // A source view's `_count` is one of its columns, kept as any other.
    expect(
      documentsOf(s.view(() => counted, { select: { _count: true } }))
    ).toEqual(["_count"]);
  });

  it("keeps the declared query and the source it reads", () => {
    const query = { where: { published: true } };
    const subject = s.view(() => post, query);
    expect(viewFacts(subject)).toMatchObject({ source: post, query });
  });

  it("has the keys of its source whose members it projects", () => {
    const keyed = s.view(() => user, { select: { id: true, email: true } });
    expect(getModelKeyCatalog(keyed).addressableKeys).toEqual([
      { kind: "primary", fields: ["id"] },
      { kind: "unique", fields: ["email"] },
    ]);
    const keyless = s.view(() => user, { select: { name: true } });
    expect(getModelKeyCatalog(keyless).rowKey).toBeUndefined();
  });

  it("has a compound key only with every member", () => {
    const whole = s.view(() => membership, {});
    expect(getModelKeyCatalog(whole).addressableKeys).toEqual([
      { kind: "primary", name: "userId_teamId", fields: ["userId", "teamId"] },
      { kind: "compoundUnique", name: "seat", fields: ["teamId", "role"] },
    ]);
    const partial = s.view(() => membership, {
      select: { teamId: true, role: true },
    });
    expect(getModelKeyCatalog(partial).addressableKeys).toEqual([
      { kind: "compoundUnique", name: "seat", fields: ["teamId", "role"] },
    ]);
    expect(partial["~"].state.compoundId).toBeUndefined();
  });

  it("reads another view: its scalars, and its JSON columns unless omitted", () => {
    const first = s.view(() => post, {
      select: { id: true, title: true, author: true },
    });
    const second = s.view(() => first, { where: { title: "x" } });
    expect(scalarsOf(second)).toEqual(["id", "title"]);
    expect(viewFacts(second)?.documents).toEqual(["author"]);
    const third = s.view(() => first, { omit: { author: true } });
    expect(viewFacts(third)?.documents).toEqual([]);
  });

  it("reads its source on first use, so a view may be declared before it", () => {
    const early = s.view(() => late, { select: { id: true } });
    const late = s.model({ id: s.string().id(), name: s.string() });
    expect(scalarsOf(early)).toEqual(["id"]);
  });

  it("refuses views that read each other in a cycle", () => {
    const first: ReturnType<typeof s.view> = s.view(() => second, {});
    const second: ReturnType<typeof s.view> = s.view(() => first, {});
    expect(() => first["~"].state.scalars).toThrow("A view cannot read itself");
  });

  it("is named by .map() like a table", () => {
    const subject = s.view(() => post, {}).map("published_posts");
    expect(subject["~"].state.tableName).toBe("published_posts");
    expect(viewFacts(subject)?.source).toBe(post);
  });

  it("refuses a source that is not a model", () => {
    const subject = s.view(() => ({}) as typeof post, {});
    expect(() => subject["~"].state.scalars).toThrow(
      "A view reads a model or a view"
    );
  });
});

/**
 * Everything a model can be told, with its answer for a view: admitted, or
 * refused by the rule named. W002 (`rules/view.ts`) owns the refusals and
 * reads each refused fact by name, so this list is what keeps it closed: a
 * method or a fact added to `Model` fails below until it is classified here,
 * and a refusal claimed here is proven by declaring it on a view.
 */
type Verdict = "admitted" | "W002";
const DECLARED_ON_A_VIEW: Record<
  string,
  { declare: (model: AnyModel) => AnyModel; verdict: Verdict }
> = {
  map: { declare: (model) => model.map("titles"), verdict: "admitted" },
  extends: {
    declare: (model) => model.extends({ extra: s.string() }),
    verdict: "W002",
  },
  id: { declare: (model) => model.id(["title", "published"]), verdict: "W002" },
  unique: {
    declare: (model) => model.unique(["title", "published"]),
    verdict: "W002",
  },
  index: { declare: (model) => model.index(["title"]), verdict: "W002" },
  rawIndex: {
    declare: (model) =>
      model.rawIndex("by_title", {
        pg: "CREATE INDEX {name} ON {table} ({title})",
      }),
    verdict: "W002",
  },
  withoutRowid: { declare: (model) => model.withoutRowid(), verdict: "W002" },
  omit: { declare: (model) => model.omit({ title: true }), verdict: "W002" },
};

/**
 * What `model["~"]` answers. `state` is a view's derived state, whose keys
 * `view.ts` closes by type; the names and the two caches follow hydration and
 * the state, and declare nothing.
 */
const FACTS_OF_A_MODEL: Record<string, Verdict> = {
  state: "admitted",
  names: "admitted",
  nameRegistry: "admitted",
  getFieldName: "admitted",
  scalarFieldNames: "admitted",
  relationNames: "admitted",
  rawIndexes: "W002",
  withoutRowid: "W002",
};

/** A view without a key, so that a key declared on it is the one thing refused. */
const censused = s.view(() => post, {
  select: { title: true, published: true },
});

describe("what a model can be told, classified for a view", () => {
  const subject = censused;
  const refusedFacts = Object.keys(FACTS_OF_A_MODEL).filter(
    (fact) => FACTS_OF_A_MODEL[fact] !== "admitted"
  );

  it("classifies every method of Model", () => {
    expect(
      Object.getOwnPropertyNames(Model.prototype)
        .filter((name) => name !== "constructor" && name !== "~")
        .sort()
    ).toEqual(Object.keys(DECLARED_ON_A_VIEW).sort());
  });

  it("classifies every fact a model answers", () => {
    expect(Object.keys(subject["~"]).sort()).toEqual(
      Object.keys(FACTS_OF_A_MODEL).sort()
    );
  });

  it("a table's state holds nothing a view neither derives nor is refused", () => {
    // Every method on one table: what its state can carry.
    const told = Object.values(DECLARED_ON_A_VIEW).reduce<AnyModel>(
      (model, { declare }) => declare(model),
      post
    );
    const derived = new Set(Object.keys(subject["~"].state));
    expect(
      Object.keys(told["~"].state)
        .filter((key) => !derived.has(key))
        .sort()
    ).toEqual(refusedFacts.sort());
  });

  it.each(
    refusedFacts
  )("a refused fact, %s, is one a refused method states", (fact) => {
    const stated = Object.values(DECLARED_ON_A_VIEW).filter(
      ({ declare }) =>
        !isDeepStrictEqual(
          Reflect.get(declare(subject)["~"], fact),
          Reflect.get(subject["~"], fact)
        )
    );
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.map(({ verdict }) => verdict)).not.toContain("admitted");
  });
});

describe("definition validation of a view", () => {
  const subject = s.view(() => post, { select: { id: true, title: true } });

  it("admits a view beside its source, with or without a key", () => {
    const keyless = s.view(() => post, { select: { title: true } });
    expect(validateSchema({ user, post, subject, keyless }).errors).toEqual([]);
    expect(() =>
      resolveSchemaOrThrow({ user, post, subject, keyless })
    ).not.toThrow();
  });

  it("refuses a view whose source the schema does not hold (W001)", () => {
    const lone = s.model({ id: s.string().id() });
    const orphan = s.view(() => lone, {});
    expect(codes(validateSchema({ orphan }))).toEqual(["W001"]);
    // Advice, and what a migration of the view always runs: a client is
    // built without it, since no view exists that a migration did not create.
    expect(() => resolveSchemaOrThrow({ orphan })).not.toThrow();
  });

  it.each(
    Object.entries(DECLARED_ON_A_VIEW)
  )("%s on a view is what the census says", (_, { declare, verdict }) => {
    const declared = declare(censused);
    expect(codes(validateSchema({ user, post, declared }))).toEqual(
      verdict === "admitted" ? [] : [verdict]
    );
  });

  it("refuses a relation on a view (W003)", () => {
    const related = s
      .view(() => post, {
        select: { id: true, authorId: true },
      })
      .extends({
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      });
    expect(codes(validateSchema({ user, post, related }))).toContain("W003");
  });

  it("refuses a JSON column under the name of a scalar's column (W004)", () => {
    const mapped = s.model({
      id: s.string().id(),
      authorId: s.string().map("author"),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const twice = s.view(() => mapped, {
      select: { authorId: true, author: true },
    });
    const once = s.view(() => mapped, { select: { id: true, author: true } });
    expect(codes(validateSchema({ user, post, mapped, twice }))).toContain(
      "W004"
    );
    expect(codes(validateSchema({ user, post, mapped, once }))).not.toContain(
      "W004"
    );
  });

  it("refuses a view under a table's name (M004)", () => {
    const clash = s.view(() => post, {}).map("post");
    expect(codes(validateSchema({ user, post, clash }))).toContain("M004");
  });
});
