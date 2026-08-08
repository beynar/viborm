import { s } from "@schema";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import {
  polymorphicCreateFactory,
  polymorphicFilterFactory,
  polymorphicIncludeFactory,
  polymorphicUpdateFactory,
} from "@validation/relations/polymorphic";
import { describe, expect, test } from "vitest";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
});
const video = s.model({
  id: s.string().id(),
  duration: s.int(),
});
const requiredOwner = s.model({
  id: s.string().id(),
  subject: s.polymorphic(
    { post: () => post, video: () => video },
    { values: { post: "content.post.v1", video: "content.video.v1" } }
  ),
});
const optionalOwner = s.model({
  id: s.string().id(),
  subject: s
    .polymorphic(
      { post: () => post, video: () => video },
      { values: { post: "content.post.v1", video: "content.video.v1" } }
    )
    .optional(),
});
const article = s.model({
  id: s.string().id(),
  comments: s.oneToMany(() => remark).name("commentable"),
});
const remark = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .polymorphic(
      { article: () => article },
      { values: { article: "content.article.v1" } }
    )
    .name("commentable"),
});
const auditLog = s.model({
  id: s.string().id(),
});
const folder = s.model({
  id: s.string().id(),
  entries: s.oneToMany(() => folderEntry).name("folderEntry"),
});
const folderEntry = s.model({
  id: s.string().id(),
  folder: s
    .polymorphic(
      { folder: () => folder },
      { values: { folder: "folder.entry.v1" } }
    )
    .name("folderEntry"),
  audit: s.polymorphic(
    { auditLog: () => auditLog },
    { values: { auditLog: "audit.log.v1" } }
  ),
});

const registry = createSchemaRegistry({
  post,
  video,
  requiredOwner,
  optionalOwner,
  article,
  remark,
  auditLog,
  folder,
  folderEntry,
});
const targetSchemas = {
  post: () => registry.proxy.post,
  video: () => registry.proxy.video,
};
const requiredState =
  requiredOwner["~"].state.polymorphicRelations.subject["~"].state;
const optionalState =
  optionalOwner["~"].state.polymorphicRelations.subject["~"].state;

const createInputSchema = polymorphicCreateFactory(
  requiredState,
  targetSchemas
);
const optionalUpdateInputSchema = polymorphicUpdateFactory(
  optionalState,
  targetSchemas
);
const filterInputSchema = polymorphicFilterFactory(
  requiredState,
  targetSchemas
);

const mixedCreateIntent = {
  connect: { type: "post", where: { id: "p1" } },
  create: { type: "post", data: { id: "p2", title: "second" } },
} as const;
const mixedUpdateIntent = {
  connect: { type: "post", where: { id: "p1" } },
  disconnect: true,
} as const;
const mixedFilterIntent = {
  type: "post",
  is: { title: "first" },
  isNot: { title: "second" },
} as const;

const _nonFreshTypeExactness = () => {
  // @ts-expect-error - connect and create are structurally exclusive
  const _create: InferInput<typeof createInputSchema> = mixedCreateIntent;
  // @ts-expect-error - connect and disconnect are structurally exclusive
  const _update: InferInput<typeof optionalUpdateInputSchema> =
    mixedUpdateIntent;
  // @ts-expect-error - is and isNot are structurally exclusive
  const _filter: InferInput<typeof filterInputSchema> = mixedFilterIntent;

  const gettersWithUnknownVariant = {
    ...targetSchemas,
    photo: () => registry.proxy.post,
  };
  // @ts-expect-error - schema getters must have exactly the configured target keys
  polymorphicCreateFactory(requiredState, gettersWithUnknownVariant);

  return [_create, _update, _filter];
};

const accepts = (schema: Parameters<typeof parse>[0], value: unknown) =>
  parse(schema, value).issues === undefined;

describe("polymorphic operation schema factories", () => {
  test("registry composes direct polymorphic inputs without exposing storage columns", () => {
    expect(
      accepts(registry.proxy.requiredOwner.core.create, {
        id: "owner-1",
        subject: { connect: { type: "post", where: { id: "p1" } } },
      })
    ).toBe(true);
    expect(
      accepts(registry.proxy.requiredOwner.core.create, { id: "owner-1" })
    ).toBe(false);
    expect(
      accepts(registry.proxy.optionalOwner.core.create, { id: "owner-1" })
    ).toBe(true);
    expect(
      accepts(registry.proxy.requiredOwner.core.create, {
        id: "owner-1",
        subjectType: "content.post.v1",
        subjectId: "p1",
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.optionalOwner.core.update, {
        subject: { disconnect: true },
      })
    ).toBe(true);
  });

  test("registry composes polymorphic filters and projections", () => {
    expect(
      accepts(registry.proxy.requiredOwner.core.where, {
        subject: { type: "video", is: { duration: 12 } },
      })
    ).toBe(true);
    expect(
      accepts(registry.proxy.requiredOwner.core.where, {
        subject: { type: "post", is: { duration: 12 } },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.requiredOwner.core.select, {
        id: true,
        subject: { post: { select: { title: true } } },
      })
    ).toBe(true);
    expect(
      accepts(registry.proxy.requiredOwner.core.include, {
        subject: { video: { select: { duration: true } } },
      })
    ).toBe(true);
  });

  test("inverse one-to-many exposes only create and supplies the child edge", () => {
    expect(
      accepts(registry.proxy.article.core.create, {
        id: "article-1",
        comments: { create: { id: "remark-1", body: "first" } },
      })
    ).toBe(true);
    expect(
      accepts(registry.proxy.article.core.update, {
        comments: { create: [{ id: "remark-2", body: "second" }] },
      })
    ).toBe(true);
    for (const unsupported of [
      { connect: { id: "remark-1" } },
      { createMany: { data: [{ id: "remark-1", body: "first" }] } },
      { disconnect: { id: "remark-1" } },
      { delete: { id: "remark-1" } },
      {
        update: {
          where: { id: "remark-1" },
          data: { body: "changed" },
        },
      },
      { set: [] },
      {
        upsert: {
          where: { id: "remark-1" },
          create: { id: "remark-1", body: "first" },
          update: { body: "changed" },
        },
      },
      {
        connectOrCreate: {
          where: { id: "remark-1" },
          create: { id: "remark-1", body: "first" },
        },
      },
    ]) {
      expect(
        accepts(registry.proxy.article.core.update, {
          comments: unsupported,
        })
      ).toBe(false);
    }
    expect(
      accepts(registry.proxy.remark.core.create, {
        id: "remark-3",
        body: "standalone",
      })
    ).toBe(false);
  });

  test("inverse create preserves unrelated required relation groups", () => {
    expect(
      accepts(registry.proxy.folder.core.create, {
        id: "folder-1",
        entries: { create: { id: "entry-1" } },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.folder.core.create, {
        id: "folder-1",
        entries: {
          create: {
            id: "entry-1",
            audit: {
              connect: { type: "auditLog", where: { id: "audit-1" } },
            },
          },
        },
      })
    ).toBe(true);
  });

  test("inverse topology stays lazy until create validation", () => {
    let targetResolutions = 0;
    const lazyParent = s.model({
      id: s.string().id(),
      entries: s.oneToMany(() => {
        targetResolutions += 1;
        return lazyEntry;
      }),
    });
    const lazyEntry = s.model({
      id: s.string().id(),
      owner: s.polymorphic(
        { parent: () => lazyParent },
        { values: { parent: "lazy.parent.v1" } }
      ),
    });
    const lazyRegistry = createSchemaRegistry({ lazyParent, lazyEntry });

    const createSchema = lazyRegistry.proxy.lazyParent.core.create;
    expect(targetResolutions).toBe(0);
    expect(
      accepts(createSchema, {
        id: "parent-1",
        entries: { create: { id: "entry-1" } },
      })
    ).toBe(true);
    expect(targetResolutions).toBeGreaterThan(0);
  });

  test("create correlates each discriminator with its selector or data", () => {
    const schema = polymorphicCreateFactory(requiredState, targetSchemas);

    expect(
      accepts(schema, { connect: { type: "post", where: { id: "p1" } } })
    ).toBe(true);
    expect(
      accepts(schema, {
        create: { type: "video", data: { id: "v1", duration: 12 } },
      })
    ).toBe(true);
    expect(
      accepts(schema, {
        connect: { type: "post", where: { id: "p1" } },
        create: { type: "post", data: { id: "p2", title: "second" } },
      })
    ).toBe(false);
    expect(
      accepts(schema, {
        connect: { type: "post", where: { duration: 12 } },
      })
    ).toBe(false);
    expect(accepts(schema, { type: "post", id: "p1" })).toBe(false);
  });

  test("update exposes connect and optional-only disconnect", () => {
    const required = polymorphicUpdateFactory(requiredState, targetSchemas);
    const optional = polymorphicUpdateFactory(optionalState, targetSchemas);

    expect(
      accepts(required, {
        connect: { type: "video", where: { id: "v1" } },
      })
    ).toBe(true);
    expect(accepts(required, { disconnect: true })).toBe(false);
    expect(accepts(optional, { disconnect: true })).toBe(true);
    expect(accepts(optional, { disconnect: false })).toBe(false);
    expect(
      accepts(optional, {
        update: { type: "post", data: { title: "changed" } },
      })
    ).toBe(false);
  });

  test("filter selects one target before parsing its predicate", () => {
    const required = polymorphicFilterFactory(requiredState, targetSchemas);
    const optional = polymorphicFilterFactory(optionalState, targetSchemas);

    expect(accepts(required, { type: "post" })).toBe(true);
    expect(accepts(required, { type: "post", is: { title: "hello" } })).toBe(
      true
    );
    expect(accepts(required, { type: "video", isNot: { duration: 0 } })).toBe(
      true
    );
    expect(accepts(required, { is: { title: "hello" } })).toBe(false);
    expect(accepts(required, { type: "post", is: { duration: 0 } })).toBe(
      false
    );
    expect(
      accepts(required, {
        type: "post",
        is: { title: "hello" },
        isNot: { title: "other" },
      })
    ).toBe(false);
    expect(accepts(required, null)).toBe(false);
    expect(accepts(optional, null)).toBe(true);
  });

  test("select/include accepts strict per-target projection overrides", () => {
    const schema = polymorphicIncludeFactory(
      requiredOwner["~"].state.polymorphicRelations.subject,
      targetSchemas
    );

    expect(accepts(schema, false)).toBe(true);
    expect(accepts(schema, true)).toBe(true);
    const parsed = parse(schema, {
      post: { select: { id: true, title: true } },
      video: { omit: { duration: true } },
    });
    expect(parsed.issues).toBeUndefined();
    if (!parsed.issues) {
      expect(parsed.value).toEqual({
        post: { select: { id: true, title: true } },
        video: { select: { id: true } },
      });
    }
    const defaultNode = parse(schema, { post: {} });
    expect(defaultNode.issues).toBeUndefined();
    if (!defaultNode.issues) {
      expect(defaultNode.value).toEqual({
        post: { select: { id: true, title: true } },
      });
    }
    const unknownNonFresh = {
      post: true,
      photo: true,
    };
    expect(accepts(schema, unknownNonFresh)).toBe(false);
    expect(
      accepts(schema, {
        post: { select: { id: true }, include: {} },
      })
    ).toBe(false);
    expect(
      accepts(schema, {
        video: { select: { id: true }, omit: { duration: true } },
      })
    ).toBe(false);
  });
});
