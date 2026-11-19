/**
 * `view` at the schema: the model a view derives from its source and its
 * query (scalars, keys, JSON columns), and what definition validation refuses
 * on one (W001-W004), with the census that keeps that list closed. The read
 * that defines it is compiled by the migration layer and read back by the
 * client; neither is this layer's.
 */

import { isDeepStrictEqual } from "node:util";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { type AnyModel, Model } from "@src/schema/model";
import { getModelKeyCatalog } from "@src/schema/model/keys";
import { resolveSchemaOrThrow, validateSchema } from "@src/schema/validation";
import { uninheritedRelationMessage } from "@src/schema/validation/relation-resolution";
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

const TWO_COLUMNS = /does not keep '.+', '.+', which the relation joins on$/;

const codes = (result: ReturnType<typeof validateSchema>) =>
  result.errors.map(({ code }) => code);
const scalarsOf = (model: AnyModel) => Object.keys(model["~"].state.scalars);

describe("a view's derived model", () => {
  it("holds the scalars its selection names, by the source's own objects, in the source's order", () => {
    const subject = s.view(() => post, {
      select: { title: true, id: true, published: false },
    });
    expect(scalarsOf(subject)).toEqual(["id", "title"]);
    expect(subject["~"].state.scalars.title).toBe(
      post["~"].state.scalars.title
    );
    // Every relation of the source whose name no column takes: which of
    // them the view inherits, the schema's resolution says (below).
    expect(subject["~"].state.relations).toEqual({
      author: post["~"].state.relations.author,
    });
    expect(Object.keys(subject["~"].state.shape)).toEqual([
      "id",
      "title",
      "author",
    ]);
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
    const documentsOf = (declared: AnyModel) => viewFacts(declared)?.documents;
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

  it("omit takes from a written selection as a read does: scalars, keys and JSON columns", () => {
    const trimmed = s.view(() => post, {
      select: { id: true, title: true, author: true },
      omit: { id: true },
    } as never);
    expect(scalarsOf(trimmed)).toEqual(["title"]);
    expect(getModelKeyCatalog(trimmed).addressableKeys).toEqual([]);
    expect(viewFacts(trimmed)?.documents).toEqual(["author"]);
    const over = s.view(() => trimmed, {
      select: { title: true, author: true },
      omit: { author: true },
    } as never);
    expect(scalarsOf(over)).toEqual(["title"]);
    expect(viewFacts(over)?.documents).toEqual([]);
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
    const first: AnyModel = s.view(() => second, {});
    const second: AnyModel = s.view(() => first, {});
    expect(() => first["~"].state.scalars).toThrow("A view cannot read itself");
  });

  it("is named by .map() like a table", () => {
    const subject = s.view(() => post, {}).map("published_posts");
    expect(subject["~"].state.tableName).toBe("published_posts");
    expect(viewFacts(subject)?.source).toBe(post);
  });

  it("is materialized by .materialized(), which every other modifier keeps, before or after it", () => {
    const query = { select: { id: true, title: true } } as const;
    expect(viewFacts(s.view(() => post, query))?.materialized).toBeUndefined();
    const before = s
      .view(() => post, query)
      .map("titles")
      .materialized();
    const after = s
      .view(() => post, query)
      .materialized()
      .map("titles")
      .index(["title"]);
    for (const subject of [before, after]) {
      expect(viewFacts(subject)?.materialized).toBe(true);
      expect(subject["~"].state.tableName).toBe("titles");
    }
    expect(after["~"].state.indexes).toEqual([
      { fields: ["title"], options: {} },
    ]);
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
interface Declaration {
  readonly declare: (model: AnyModel) => AnyModel;
  readonly verdict: Verdict;
  /** Declared on a view alone: a table refuses it at the call. */
  readonly viewOnly?: true;
}

const DECLARED_ON_A_VIEW: Record<string, readonly Declaration[]> = {
  map: [{ declare: (model) => model.map("titles"), verdict: "admitted" }],
  extends: [
    {
      declare: (model) => model.extends({ extra: s.string() }),
      verdict: "W002",
    },
  ],
  id: [
    { declare: (model) => model.id(["title", "published"]), verdict: "W002" },
  ],
  unique: [
    {
      declare: (model) => model.unique(["title", "published"]),
      verdict: "W002",
    },
  ],
  materialized: [
    {
      declare: (model) => model.materialized(),
      verdict: "admitted",
      viewOnly: true,
    },
  ],
  index: [
    // A view that is not materialized stores no rows to index.
    { declare: (model) => model.index(["title"]), verdict: "W002" },
    {
      declare: (model) =>
        model
          .materialized()
          .index(["title", "published"], { name: "by_title" }),
      verdict: "admitted",
      viewOnly: true,
    },
    {
      // A unique index is a key, and a view's keys are its source's.
      declare: (model) =>
        model.materialized().index(["title"], { unique: true }),
      verdict: "W002",
      viewOnly: true,
    },
    {
      // A JSON column: a document has no order an index could keep.
      declare: (model) => model.materialized().index(["author"]),
      verdict: "W002",
      viewOnly: true,
    },
  ],
  rawIndex: [
    {
      declare: (model) =>
        model.rawIndex("by_title", {
          pg: "CREATE INDEX {name} ON {table} ({title})",
        }),
      verdict: "W002",
    },
  ],
  withoutRowid: [{ declare: (model) => model.withoutRowid(), verdict: "W002" }],
  omit: [{ declare: (model) => model.omit({ title: true }), verdict: "W002" }],
};
/** Every case of every method, named by its method. */
const DECLARATIONS = Object.entries(DECLARED_ON_A_VIEW).flatMap(
  ([method, cases]) =>
    cases.map(
      (declaration) =>
        [`${method} (${declaration.verdict})`, declaration] as const
    )
);

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

/**
 * A view without a key, so that a key declared on it is the one thing
 * refused, and with a JSON column, which an index cannot name.
 */
const censused = s.view(() => post, {
  select: { title: true, published: true, author: true },
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
    const told = DECLARATIONS.filter(
      ([, { viewOnly }]) => !viewOnly
    ).reduce<AnyModel>((model, [, { declare }]) => declare(model), post);
    const derived = new Set(Object.keys(subject["~"].state));
    expect(
      Object.keys(told["~"].state)
        .filter((key) => !derived.has(key))
        .sort()
    ).toEqual(refusedFacts.sort());
  });

  it.each(
    DECLARATIONS.filter(([, { viewOnly }]) => viewOnly)
  )("a table refuses %s at the call", (_, { declare }) => {
    expect(() => declare(post)).toThrow("Only a view is materialized");
  });

  it.each(
    refusedFacts
  )("a refused fact, %s, is one a refused method states", (fact) => {
    const stated = DECLARATIONS.filter(
      ([, { declare }]) =>
        !isDeepStrictEqual(
          Reflect.get(declare(subject)["~"], fact),
          Reflect.get(subject["~"], fact)
        )
    );
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.map(([, { verdict }]) => verdict)).not.toContain("admitted");
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

  it.each(DECLARATIONS)("%s on a view is what the census says", (_, {
    declare,
    verdict,
  }) => {
    const declared = declare(censused);
    expect(codes(validateSchema({ user, post, declared }))).toEqual(
      verdict === "admitted" ? [] : [verdict]
    );
  });

  it("refuses a relation a view declares: its relations are its source's (W003)", () => {
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
    // The relation it inherits is its source's own: none declared.
    const inheriting = s.view(() => post, {
      select: { id: true, authorId: true },
    });
    expect(codes(validateSchema({ user, post, inheriting }))).toEqual([]);
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

  it("says why an index is refused on a view, once", () => {
    const authored = s.view(() => post, {
      select: { id: true, title: true, author: true },
    });
    const messages = (declared: AnyModel) =>
      validateSchema({ user, post, declared }).errors.map(
        ({ code, message }) => [code, message]
      );
    expect(messages(authored.index(["title"]))).toEqual([
      [
        "W002",
        "View 'declared' declares an index, and only a materialized view stores rows to index: declare it .materialized()",
      ],
    ]);
    // A JSON column is a field of the view, which the type of `.index()`
    // already refuses: W002 says why, I001 does not.
    expect(
      messages(authored.materialized().index(["author"] as never))
    ).toEqual([
      [
        "W002",
        "View 'declared' indexes its JSON column 'author': a document has no order an index could keep",
      ],
    ]);
    // A name the view does not have is I001's, as on a table.
    expect(
      messages(authored.materialized().index(["published"] as never))
    ).toEqual([["I001", "Index field 'published' not in 'declared'"]]);
    expect(
      messages(
        authored
          .materialized()
          .index(["title"], { name: "by_title", where: "title <> ''" })
      )
    ).toEqual([]);
  });

  it("refuses a view under a table's name (M004)", () => {
    const clash = s.view(() => post, {}).map("post");
    expect(codes(validateSchema({ user, post, clash }))).toContain("M004");
  });
});

/**
 * A view inherits each relation of its source whose key columns it keeps
 * (`buildIndex`, `slotKeyFields`): the slot is the source's own, read at the
 * view's rows. Its targets are not touched, nor given an inverse.
 */
describe("the relations a view inherits", () => {
  const owner = s.model({
    id: s.string().id(),
    name: s.string(),
    items: s.toMany(() => item),
  });
  const item = s.model({
    id: s.string().id(),
    title: s.string(),
    ownerId: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
    reviews: s.toMany(() => review),
    badges: s.toMany(() => badge),
    pins: s.toMany(() => pin).name("pinned"),
  });
  const review = s.model({
    id: s.string().id(),
    itemId: s.string(),
    item: s
      .toOne(() => item)
      .fields("itemId")
      .references("id"),
  });
  const badge = s.model({
    id: s.string().id(),
    items: s.toMany(() => item),
  });
  /** A polymorphic carrier: its `(type, id)` columns are its own. */
  const pin = s.model({
    id: s.string().id(),
    pinned: s.toOne({ item: () => item }).name("pinned"),
  });
  const kept = s.view(() => item, {
    select: { id: true, title: true, ownerId: true },
  });
  const titles = s.view(() => item, { select: { title: true, ownerId: true } });
  const named = s.view(() => item, {
    select: { id: true, ownerId: true, owner: { select: { name: true } } },
  });
  const over = s.view(() => kept, { select: { id: true } });
  const pinView = s.view(() => pin, {});
  const schema = {
    owner,
    item,
    review,
    badge,
    pin,
    kept,
    titles,
    named,
    over,
    pinView,
  };
  hydrateSchemaNames(schema);
  const index = resolveSchemaOrThrow(schema);
  const fields = (model: AnyModel) => [...index.get(model)!.keys()];

  it("keeps the source's slot where the view holds its key columns", () => {
    expect(fields(kept)).toEqual(["owner", "reviews", "badges", "pins"]);
    for (const field of fields(kept))
      expect(index.get(kept)!.get(field)).toBe(index.get(item)!.get(field));
    // A foreign key needs its own columns; a to-many, a junction and a
    // variant inverse the key they reference.
    expect(fields(titles)).toEqual(["owner"]);
    // A JSON column takes the name.
    expect(fields(named)).toEqual(["reviews", "badges", "pins"]);
    // A view of a view, what its source inherits and it keeps.
    expect(fields(over)).toEqual(["reviews", "badges", "pins"]);
    // A carrier's columns are no view's.
    expect(fields(pinView)).toEqual([]);
    // No target gains an inverse.
    expect(fields(owner)).toEqual(["items"]);
  });

  it("names the columns a relation it does not inherit joins on", () => {
    expect(uninheritedRelationMessage(titles, "reviews", index)).toBe(
      "The view 'titles' does not read 'reviews': it does not keep 'id', which the relation joins on"
    );
    expect(uninheritedRelationMessage(over, "owner", index)).toBe(
      "The view 'over' does not read 'owner': it does not keep 'ownerId', which the relation joins on"
    );
    expect(uninheritedRelationMessage(pinView, "pinned", index)).toMatch(
      TWO_COLUMNS
    );
  });

  it("refuses a relation to a view, which no relation reaches (R002)", () => {
    const reader = s.model({
      id: s.string().id(),
      kept: s.toMany(() => kept),
    });
    const result = validateSchema({ ...schema, reader });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "R002",
        message: expect.stringContaining(
          "'reader.kept' targets the view 'kept', which no relation reaches"
        ),
      })
    );
  });
});

describe("the `_count: true` of a view over a view", () => {
  const author = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  });
  const documents = (model: AnyModel) => viewFacts(model)!.documents;

  it("is a column where the source reads a to-many it counts, and none where it inherits none", () => {
    const ids = s.view(() => author, { select: { id: true } });
    const named = s.view(() => author, { select: { _count: true } });
    const keyless = s.view(() => author, { select: { name: true } });
    const views = {
      keyed: s.view(() => ids, { include: { _count: true } }),
      keptOver: s.view(() => named, {}),
      overKeyless: s.view(() => keyless, { include: { _count: true } }),
      selectingOverKeyless: s.view(() => keyless, {
        select: { name: true, _count: true },
      }),
    };
    const schema = { author, post, ids, named, keyless, ...views };
    hydrateSchemaNames(schema);
    resolveSchemaOrThrow(schema);
    expect(documents(views.keyed)).toEqual(["_count"]);
    expect(documents(views.keptOver)).toEqual(["_count"]);
    expect(documents(views.overKeyless)).toEqual([]);
    expect(documents(views.selectingOverKeyless)).toEqual([]);
  });

  it("is settled by a schema that holds its table, whatever another schema resolved first", () => {
    const ids = s.view(() => author, { select: { id: true } });
    const keyed = s.view(() => ids, { include: { _count: true } });
    // Without its table, a schema cannot tell what the source inherits.
    validateSchema({ ids, keyed });
    expect(documents(keyed)).toEqual(["_count"]);
    const schema = { author, post, ids, keyed };
    hydrateSchemaNames(schema);
    resolveSchemaOrThrow(schema);
    expect(documents(keyed)).toEqual(["_count"]);
  });
});

describe("a view's relations through a declared junction", () => {
  const teamParent = s
    .model({
      organizationId: s.string(),
      childId: s.string(),
      parentId: s.string(),
      child: s
        .toOne(() => team)
        .fields("organizationId", "childId")
        .references("organizationId", "id"),
      parent: s
        .toOne(() => team)
        .fields("organizationId", "parentId")
        .references("organizationId", "id"),
    })
    .id(["childId", "parentId"]);
  const team = s
    .model({
      id: s.string().id(),
      organizationId: s.string(),
      parents: s
        .toMany(() => team)
        .name("graph")
        .through(() => teamParent)
        .source("child")
        .target("parent"),
      children: s.toMany(() => team).name("graph"),
      tags: s.toMany(() => teamTag).through("team_tag"),
    })
    .unique(["organizationId", "id"]);
  const teamTag = s.model({
    id: s.string().id(),
    teams: s.toMany(() => team),
  });
  const teamIds = s.view(() => team, { select: { id: true } });
  const teamKeys = s.view(() => team, {
    select: { id: true, organizationId: true },
  });
  const schema = { teamParent, team, teamTag, teamIds, teamKeys };
  hydrateSchemaNames(schema);
  const index = resolveSchemaOrThrow(schema);

  it("joins on what the junction references, as the types read it", () => {
    expect([...index.get(teamIds)!.keys()]).toEqual(["tags"]);
    expect([...index.get(teamKeys)!.keys()].sort()).toEqual([
      "children",
      "parents",
      "tags",
    ]);
    expect(uninheritedRelationMessage(teamIds, "parents", index)).toBe(
      "The view 'teamIds' does not read 'parents': it does not keep 'organizationId', which the relation joins on"
    );
  });
});

describe("a view's variant collection", () => {
  const book = s.model({ id: s.string().id(), title: s.string() });
  const disc = s.model({ id: s.string().id(), label: s.string() });
  const shelf = s.model({
    id: s.string().id(),
    name: s.string(),
    items: s.toMany({ book: () => book, disc: () => disc }),
  });
  const shelfIds = s.view(() => shelf, { select: { id: true } });
  const shelfNames = s.view(() => shelf, { select: { name: true } });
  const schema = { book, disc, shelf, shelfIds, shelfNames };
  hydrateSchemaNames(schema);
  const index = resolveSchemaOrThrow(schema);

  it("is inherited where the view keeps the row key, as the types read it", () => {
    expect([...index.get(shelfIds)!.keys()]).toEqual(["items"]);
    expect([...index.get(shelfNames)!.keys()]).toEqual([]);
  });
});

describe("a view's relations through a self junction whose sides reference different keys", () => {
  const link = s
    .model({
      childId: s.string(),
      parentSlug: s.string(),
      child: s
        .toOne(() => node)
        .fields("childId")
        .references("id"),
      parent: s
        .toOne(() => node)
        .fields("parentSlug")
        .references("slug"),
    })
    .id(["childId", "parentSlug"]);
  const node = s.model({
    id: s.string().id(),
    slug: s.string().unique(),
    parents: s
      .toMany(() => node)
      .name("graph")
      .through(() => link)
      .source("child")
      .target("parent"),
    children: s.toMany(() => node).name("graph"),
  });
  const ids = s.view(() => node, { select: { id: true } });
  const slugs = s.view(() => node, { select: { slug: true } });
  const schema = { link, node, ids, slugs };
  hydrateSchemaNames(schema);
  const index = resolveSchemaOrThrow(schema);

  it("joins each end on its own side's key, as the types read it", () => {
    expect([...index.get(ids)!.keys()]).toEqual(["parents"]);
    expect([...index.get(slugs)!.keys()]).toEqual(["children"]);
  });
});
