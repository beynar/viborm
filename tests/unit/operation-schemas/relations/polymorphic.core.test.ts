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
const optionalArticle = s.model({
  id: s.string().id(),
  comments: s.oneToMany(() => optionalRemark).name("optionalCommentable"),
});
const optionalRemark = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .polymorphic(
      { article: () => optionalArticle },
      { values: { article: "content.optional-article.v1" } }
    )
    .name("optionalCommentable")
    .optional(),
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
const featuredPost = s.model({
  id: s.string().id(),
  featuredComment: s
    .oneToOne(() => featuredComment)
    .name("featuredCommentable")
    .optional(),
});
const featuredVideo = s.model({
  id: s.string().id(),
  featuredComment: s
    .oneToOne(() => featuredComment)
    .name("featuredCommentable")
    .optional(),
});
const featuredComment = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .polymorphic({
      post: () => featuredPost,
      video: () => featuredVideo,
    })
    .name("featuredCommentable")
    .optional(),
});
const requiredFeaturedPost = s.model({
  id: s.string().id(),
  featuredComment: s
    .oneToOne(() => requiredFeaturedComment)
    .name("requiredFeaturedCommentable")
    .optional(),
});
const requiredFeaturedVideo = s.model({
  id: s.string().id(),
  featuredComment: s
    .oneToOne(() => requiredFeaturedComment)
    .name("requiredFeaturedCommentable")
    .optional(),
});
const requiredFeaturedComment = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .polymorphic({
      post: () => requiredFeaturedPost,
      video: () => requiredFeaturedVideo,
    })
    .name("requiredFeaturedCommentable"),
});

const registry = createSchemaRegistry({
  post,
  video,
  requiredOwner,
  optionalOwner,
  article,
  remark,
  optionalArticle,
  optionalRemark,
  auditLog,
  folder,
  folderEntry,
  featuredPost,
  featuredVideo,
  featuredComment,
  requiredFeaturedPost,
  requiredFeaturedVideo,
  requiredFeaturedComment,
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

  test("inverse one-to-many exposes the safe mutation family", () => {
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
    for (const supported of [
      { connect: { id: "remark-1" } },
      { createMany: { data: [{ id: "remark-1", body: "first" }] } },
      { delete: { id: "remark-1" } },
      {
        update: {
          where: { id: "remark-1" },
          data: { body: "changed" },
        },
      },
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
          comments: supported,
        })
      ).toBe(true);
    }

    expect(
      accepts(registry.proxy.article.core.create, {
        id: "article-2",
        comments: {
          connect: { id: "remark-1" },
          connectOrCreate: {
            where: { id: "remark-2" },
            create: { id: "remark-2", body: "second" },
          },
          upsert: {
            where: { id: "remark-3" },
            create: { id: "remark-3", body: "third" },
            update: { body: "changed" },
          },
        },
      })
    ).toBe(true);

    for (const updateOnly of [
      {
        update: {
          where: { id: "remark-1" },
          data: { body: "changed" },
        },
      },
      { delete: { id: "remark-1" } },
      { disconnect: { id: "remark-1" } },
      { set: [] },
    ]) {
      expect(
        accepts(registry.proxy.article.core.create, {
          id: "article-3",
          comments: updateOnly,
        })
      ).toBe(false);
    }

    for (const requiredOnly of [
      { disconnect: { id: "remark-1" } },
      { set: [] },
    ]) {
      expect(
        accepts(registry.proxy.article.core.update, {
          comments: requiredOnly,
        })
      ).toBe(false);
      expect(
        accepts(registry.proxy.optionalArticle.core.update, {
          comments: requiredOnly,
        })
      ).toBe(true);
    }

    expect(
      accepts(registry.proxy.article.core.update, {
        comments: {
          updateMany: { where: { body: "first" }, data: { body: "changed" } },
          deleteMany: { body: "obsolete" },
        },
      })
    ).toBe(true);
    expect(
      accepts(registry.proxy.remark.core.create, {
        id: "remark-3",
        body: "standalone",
      })
    ).toBe(false);
  });

  test("inverse one-to-one exposes only the singular mutation family", () => {
    for (const supported of [
      { create: { id: "comment-1", body: "first" } },
      { connect: { id: "comment-1" } },
      {
        connectOrCreate: {
          where: { id: "comment-1" },
          create: { id: "comment-1", body: "first" },
        },
      },
    ]) {
      expect(
        accepts(registry.proxy.featuredPost.core.create, {
          id: "post-1",
          featuredComment: supported,
        })
      ).toBe(true);
    }

    for (const supported of [
      { update: { body: "changed" } },
      { update: { where: { body: "first" }, data: { body: "changed" } } },
      {
        upsert: {
          create: { id: "comment-1", body: "first" },
          update: { body: "changed" },
        },
      },
      { disconnect: true },
      { delete: true },
    ]) {
      expect(
        accepts(registry.proxy.featuredPost.core.update, {
          featuredComment: supported,
        })
      ).toBe(true);
    }

    for (const plural of [
      { createMany: { data: [{ id: "comment-1", body: "first" }] } },
      { updateMany: { data: { body: "changed" } } },
      { deleteMany: {} },
      { set: [] },
    ]) {
      expect(
        accepts(registry.proxy.featuredPost.core.update, {
          featuredComment: plural,
        })
      ).toBe(false);
    }

    expect(
      accepts(registry.proxy.featuredPost.core.create, {
        id: "post-1",
        featuredComment: {
          create: {
            id: "comment-1",
            body: "first",
            commentable: {
              connect: { type: "post", where: { id: "post-1" } },
            },
          },
        },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.requiredFeaturedPost.core.update, {
        featuredComment: { disconnect: true },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.requiredFeaturedPost.core.update, {
        featuredComment: { delete: true },
      })
    ).toBe(true);
  });

  test("inverse mutation data cannot restate its owning direct edge", () => {
    const directOwner = {
      connect: { type: "article", where: { id: "article-2" } },
    };

    expect(
      accepts(registry.proxy.article.core.create, {
        id: "article-1",
        comments: {
          create: {
            id: "remark-1",
            body: "first",
            commentable: directOwner,
          },
        },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.article.core.update, {
        comments: {
          updateMany: {
            where: { body: "first" },
            data: { body: "changed", commentable: directOwner },
          },
        },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.article.core.update, {
        comments: {
          update: {
            where: { id: "remark-1" },
            data: { body: "changed", commentable: directOwner },
          },
        },
      })
    ).toBe(false);
    expect(
      accepts(registry.proxy.article.core.update, {
        comments: {
          upsert: {
            where: { id: "remark-1" },
            create: {
              id: "remark-1",
              body: "first",
              commentable: directOwner,
            },
            update: { body: "changed", commentable: directOwner },
          },
        },
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

    expect(
      accepts(registry.proxy.article.core.create, {
        id: "article-1",
        comments: {
          createMany: { data: [{ id: "entry-1", body: "first" }] },
        },
      })
    ).toBe(true);
    expect(
      accepts(registry.proxy.folder.core.create, {
        id: "folder-1",
        entries: { createMany: { data: [{ id: "entry-1" }] } },
      })
    ).toBe(false);
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
        connectOrCreate: {
          type: "post",
          where: { id: "p1" },
          create: { id: "p2", title: "new" },
        },
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

  test("update exposes the parent-held to-one mutation family", () => {
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
    for (const mutation of [
      { create: { type: "post", data: { id: "p2", title: "new" } } },
      {
        connectOrCreate: {
          type: "post",
          where: { id: "p1" },
          create: { id: "p2", title: "new" },
        },
      },
      { update: { type: "post", data: { title: "changed" } } },
      {
        upsert: {
          type: "post",
          create: { id: "p2", title: "new" },
          update: { title: "changed" },
        },
      },
      { delete: { type: "post" } },
    ]) {
      expect(accepts(optional, mutation)).toBe(true);
    }
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
    expect(accepts(required, "post")).toBe(false);
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
    expect(accepts(required, { is: null })).toBe(false);
    expect(accepts(required, { isNot: null })).toBe(false);
    expect(accepts(optional, { is: null })).toBe(true);
    expect(accepts(optional, { isNot: null })).toBe(true);
    expect(parse(optional, null)).toMatchObject({ value: { is: null } });
    expect(accepts(optional, { is: null, isNot: null })).toBe(false);
    expect(accepts(optional, { is: null, typo: null })).toBe(false);
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

describe("coverage low value", () => {
  test("keeps an empty polymorphic projection empty", () => {
    const emptyTarget = s.model({});
    const emptyOwner = s.model({
      id: s.string().id(),
      subject: s.polymorphic({ empty: () => emptyTarget }),
    });
    const emptyRegistry = createSchemaRegistry({ emptyTarget, emptyOwner });
    const schema = polymorphicIncludeFactory(
      emptyOwner["~"].state.polymorphicRelations.subject,
      { empty: () => emptyRegistry.proxy.emptyTarget }
    );

    expect(parse(schema, { empty: {} })).toEqual({
      value: { empty: {} },
      issues: undefined,
    });
  });

  test("constructs the ordinary many-to-many fallback schema", () => {
    const article = s.model({
      id: s.string().id(),
      labels: s.manyToMany(() => label),
    });
    const label = s.model({
      id: s.string().id(),
      articles: s.manyToMany(() => article),
    });
    const ordinaryRegistry = createSchemaRegistry({ article, label });

    expect(
      accepts(ordinaryRegistry.proxy.article.core.create, {
        id: "article-1",
        labels: { connect: { id: "label-1" } },
      })
    ).toBe(true);
  });
});
