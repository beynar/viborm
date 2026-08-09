import { createClient } from "@src/client/client";
import type { OperationPayload } from "@src/client/types";
import { PGliteDriver } from "@src/drivers/pglite";
import { s } from "@src/schema";
import v, { createSchemaRegistry } from "@src/validation";
import {
  polymorphicCreateFactory,
  polymorphicFilterFactory,
  polymorphicUpdateFactory,
} from "@src/validation/relations/polymorphic";
import type { InferInput, InferOutput } from "@src/validation/types";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const post = s.model({ id: s.string().id(), title: s.string() });
const video = s.model({ id: s.string().id(), duration: s.int() });
const relation = s
  .polymorphic(
    { post: () => post, video: () => video },
    { values: { post: "post.v1", video: "video.v1" } }
  )
  .optional();
const postSchemas = {
  core: {
    create: v.object({ id: v.string(), title: v.string() }),
    update: v.object({ title: v.string({ optional: true }) }),
    where: v.object({ title: v.string() }),
    whereUnique: v.object({ id: v.string() }),
    select: v.object({ id: v.boolean(), title: v.boolean() }),
    include: v.object({}),
    omit: v.object({ id: v.boolean(), title: v.boolean() }),
  },
};
const videoSchemas = {
  core: {
    create: v.object({ id: v.string(), duration: v.number() }),
    update: v.object({ duration: v.number({ optional: true }) }),
    where: v.object({ duration: v.number() }),
    whereUnique: v.object({ id: v.string() }),
    select: v.object({ id: v.boolean(), duration: v.boolean() }),
    include: v.object({}),
    omit: v.object({ id: v.boolean(), duration: v.boolean() }),
  },
};
const getters = {
  post: () => postSchemas,
  video: () => videoSchemas,
};

const createSchema = polymorphicCreateFactory(relation["~"].state, getters);
const updateSchema = polymorphicUpdateFactory(relation["~"].state, getters);
const filterSchema = polymorphicFilterFactory(relation["~"].state, getters);

type CreateInput = InferInput<typeof createSchema>;
type UpdateInput = InferInput<typeof updateSchema>;
type FilterInput = InferInput<typeof filterSchema>;

const mixedCreate = {
  connect: { type: "post", where: { id: "post-1" } },
  create: { type: "post", data: { id: "post-2", title: "new" } },
} as const;
// @ts-expect-error - a non-fresh payload cannot carry two create intents
const _mixedCreate: CreateInput = mixedCreate;

const mixedUpdate = {
  connect: { type: "post", where: { id: "post-1" } },
  disconnect: true,
} as const;
// @ts-expect-error - a non-fresh payload cannot connect and disconnect
const _mixedUpdate: UpdateInput = mixedUpdate;

const mixedFilter = {
  type: "post",
  is: { title: "one" },
  isNot: { title: "two" },
} as const;
// @ts-expect-error - a non-fresh correlated filter has one predicate intent
const _mixedFilter: FilterInput = mixedFilter;

const auditLog = s.model({ id: s.string().id() });
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
const article = s.model({
  id: s.string().id(),
  comments: s.oneToMany(() => remark).name("commentable"),
});
const remark = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s.polymorphic({ article: () => article }).name("commentable"),
});
const optionalArticle = s.model({
  id: s.string().id(),
  comments: s.oneToMany(() => optionalRemark).name("optionalCommentable"),
});
const optionalRemark = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .polymorphic({ article: () => optionalArticle })
    .name("optionalCommentable")
    .optional(),
});
const inverseRegistry = createSchemaRegistry({
  auditLog,
  folder,
  folderEntry,
  article,
  remark,
  optionalArticle,
  optionalRemark,
});
type FolderCreate = InferInput<typeof inverseRegistry.proxy.folder.core.create>;
type FolderCreateOutput = InferOutput<
  typeof inverseRegistry.proxy.folder.core.create
>;
type InverseCreateOutput = NonNullable<
  NonNullable<FolderCreateOutput["entries"]>["create"]
>;
type InverseChildOutput = InverseCreateOutput extends readonly (infer Child)[]
  ? Child
  : InverseCreateOutput;
type _injectedOwnerIsAbsentFromParsedChild = Expect<
  Equal<Extract<"folder", keyof InverseChildOutput>, never>
>;
type _remainingRelationStaysInParsedChild = Expect<
  Equal<Extract<"audit", keyof InverseChildOutput>, "audit">
>;

const validInverseCreate: FolderCreate = {
  id: "folder-1",
  entries: {
    create: {
      id: "entry-1",
      audit: { connect: { type: "auditLog", where: { id: "audit-1" } } },
    },
  },
};

const invalidInverseCreate: FolderCreate = {
  id: "folder-1",
  entries: {
    // @ts-expect-error - inverse injection removes only the folder requirement
    create: { id: "entry-1" },
  },
};

const _inverseCreateProbes = [validInverseCreate, invalidInverseCreate];

const inverseClient = createClient({
  schema: {
    auditLog,
    folder,
    folderEntry,
    article,
    remark,
    optionalArticle,
    optionalRemark,
  },
  driver: new PGliteDriver(),
});

const inverseCreateSurface = () =>
  inverseClient.folder.create({
    data: {
      id: "folder-1",
      entries: {
        create: {
          id: "entry-1",
          audit: {
            connect: { type: "auditLog", where: { id: "audit-1" } },
          },
        },
        connect: { id: "entry-2" },
        connectOrCreate: {
          where: { id: "entry-3" },
          create: {
            id: "entry-3",
            audit: {
              connect: { type: "auditLog", where: { id: "audit-1" } },
            },
          },
        },
        upsert: {
          where: { id: "entry-4" },
          create: {
            id: "entry-4",
            audit: {
              connect: { type: "auditLog", where: { id: "audit-1" } },
            },
          },
          update: {},
        },
      },
    },
  });

const inverseUpdateSurface = () =>
  inverseClient.folder.update({
    where: { id: "folder-1" },
    data: {
      entries: {
        create: {
          id: "entry-1",
          audit: {
            connect: { type: "auditLog", where: { id: "audit-1" } },
          },
        },
        connect: { id: "entry-2" },
        connectOrCreate: {
          where: { id: "entry-3" },
          create: {
            id: "entry-3",
            audit: {
              connect: { type: "auditLog", where: { id: "audit-1" } },
            },
          },
        },
        update: { where: { id: "entry-4" }, data: {} },
        updateMany: { where: { id: "entry-5" }, data: {} },
        delete: { id: "entry-6" },
        deleteMany: { id: "entry-7" },
        upsert: {
          where: { id: "entry-8" },
          create: {
            id: "entry-8",
            audit: {
              connect: { type: "auditLog", where: { id: "audit-1" } },
            },
          },
          update: {},
        },
      },
    },
  });

const optionalDisconnectAndSet = () =>
  inverseClient.optionalArticle.update({
    where: { id: "article-1" },
    data: {
      comments: {
        disconnect: { id: "comment-1" },
        set: [{ id: "comment-2" }],
      },
    },
  });

const inverseCreateManySatisfiesItsRequiredOwner = () =>
  inverseClient.article.create({
    data: {
      id: "article-1",
      comments: {
        createMany: {
          data: [
            { id: "comment-1", body: "first" },
            { id: "comment-2", body: "second" },
          ],
          skipDuplicates: true,
        },
      },
    },
  });

const inverseUpdateCanCreateMany = () =>
  inverseClient.article.update({
    where: { id: "article-1" },
    data: {
      comments: {
        createMany: { data: [{ id: "comment-3", body: "third" }] },
      },
    },
  });

const directCreateAndUpdateSurface = () => {
  inverseClient.optionalRemark.create({
    data: {
      id: "comment-1",
      body: "first",
      commentable: {
        connectOrCreate: {
          type: "article",
          where: { id: "article-1" },
          create: { id: "article-1" },
        },
      },
    },
  });
  inverseClient.optionalRemark.update({
    where: { id: "comment-1" },
    data: {
      commentable: {
        update: { type: "article", data: { id: "article-2" } },
      },
    },
  });
  inverseClient.optionalRemark.update({
    where: { id: "comment-1" },
    data: {
      commentable: {
        upsert: {
          type: "article",
          create: { id: "article-2" },
          update: { id: "article-3" },
        },
      },
    },
  });
  inverseClient.optionalRemark.update({
    where: { id: "comment-1" },
    data: { commentable: { delete: { type: "article" } } },
  });
};

const requiredDirectRemovalIsRejected = () => {
  inverseClient.remark.update({
    where: { id: "comment-1" },
    data: {
      // @ts-expect-error - required direct membership cannot disconnect
      commentable: { disconnect: true },
    },
  });
  inverseClient.remark.update({
    where: { id: "comment-1" },
    data: {
      // @ts-expect-error - required direct membership cannot delete its target
      commentable: { delete: { type: "article" } },
    },
  });
};

const inverseCreateManyStillRefusesAnotherRequiredOwner = () =>
  inverseClient.folder.create({
    data: {
      id: "folder-1",
      // @ts-expect-error - the enclosing edge supplies folder, but not required audit
      entries: { createMany: { data: [{ id: "entry-1" }] } },
    },
  });

const rootCreateManyAcceptsConnectOnlyMembership = () =>
  inverseClient.remark.createMany({
    data: [
      {
        id: "comment-1",
        body: "first",
        commentable: {
          connect: { type: "article", where: { id: "article-1" } },
        },
      },
    ],
  });

const requiredDisconnectIsRejected = () =>
  inverseClient.folder.update({
    where: { id: "folder-1" },
    data: {
      entries: {
        connect: { id: "entry-1" },
        // @ts-expect-error - required inverse membership cannot disconnect
        disconnect: { id: "entry-2" },
      },
    },
  } satisfies OperationPayload<"update", typeof folder>);

const requiredSetIsRejected = () =>
  inverseClient.folder.update({
    where: { id: "folder-1" },
    data: {
      entries: {
        connect: { id: "entry-1" },
        // @ts-expect-error - required inverse membership cannot be replaced
        set: [],
      },
    },
  } satisfies OperationPayload<"update", typeof folder>);

const updateOwnerCannotBeRestated = () =>
  inverseClient.optionalArticle.update({
    where: { id: "article-1" },
    data: {
      comments: {
        update: {
          where: { id: "comment-1" },
          data: {
            body: "changed",
            // @ts-expect-error - the enclosing inverse mutation owns this edge
            commentable: { disconnect: true },
          },
        },
      },
    },
  } satisfies OperationPayload<"update", typeof optionalArticle>);

const createOwnerCannotBeRestated = () =>
  inverseClient.optionalArticle.create({
    data: {
      id: "article-1",
      comments: {
        create: {
          id: "comment-1",
          body: "first",
          // @ts-expect-error - the enclosing inverse mutation owns this edge
          commentable: {
            connect: { type: "article", where: { id: "article-2" } },
          },
        },
      },
    },
  } satisfies OperationPayload<"create", typeof optionalArticle>);

const typoProbes = () => {
  inverseClient.optionalArticle.create({
    data: {
      id: "article-1",
      comments: {
        create: { id: "comment-1", body: "first" },
        // @ts-expect-error - unknown inverse operation beside a real one
        conenct: { id: "comment-2" },
      },
      // Reachability pin: generic mutation data cannot yet seal model-field
      // names without crossing the measured TS2589/type-cost boundary.
      commments: { create: { id: "comment-3", body: "third" } },
    },
  } satisfies OperationPayload<"create", typeof optionalArticle>);
  inverseClient.optionalArticle.create({
    data: {
      id: "article-2",
      comments: {
        create: {
          id: "comment-4",
          body: "fourth",
          // @ts-expect-error - unknown child field beside real fields
          boddy: "typo",
        },
      },
    },
  } satisfies OperationPayload<"create", typeof optionalArticle>);
};

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
    .polymorphic({ post: () => featuredPost, video: () => featuredVideo })
    .name("featuredCommentable")
    .optional(),
});
const singularInverseClient = createClient({
  schema: { featuredPost, featuredVideo, featuredComment },
  driver: new PGliteDriver(),
});

const singularInverseSurface = () => {
  singularInverseClient.featuredPost.create({
    data: {
      id: "post-1",
      featuredComment: {
        create: { id: "comment-1", body: "first" },
      },
    },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        update: { where: { body: "first" }, data: { body: "changed" } },
      },
    },
  } satisfies OperationPayload<"update", typeof featuredPost>);
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        upsert: {
          create: { id: "comment-2", body: "second" },
          update: { body: "changed" },
        },
      },
    },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: { featuredComment: { disconnect: true } },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: { featuredComment: { delete: true } },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: { featuredComment: { connect: { id: "comment-1" } } },
  });
  singularInverseClient.featuredPost.create({
    data: {
      id: "post-2",
      featuredComment: {
        connectOrCreate: {
          where: { id: "comment-2" },
          create: { id: "comment-2", body: "second" },
        },
      },
    },
  });
};

const nonFreshSingularUpdate = {
  where: { id: "post-1" },
  data: { featuredComment: { update: { body: "non-fresh" } } },
} satisfies OperationPayload<"update", typeof featuredPost>;

const singularInverseNonFreshSurface = () =>
  singularInverseClient.featuredPost.update(nonFreshSingularUpdate);

const singularInverseRefusals = () => {
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        connect: { id: "comment-1" },
        // @ts-expect-error - plural operations are absent from a singular inverse
        set: [],
      },
    },
  } satisfies OperationPayload<"update", typeof featuredPost>);
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        connect: { id: "comment-1" },
        // @ts-expect-error - singular inverse has no createMany
        createMany: { data: [{ id: "comment-2", body: "second" }] },
      },
    },
  } satisfies OperationPayload<"update", typeof featuredPost>);
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        connect: { id: "comment-1" },
        // @ts-expect-error - singular inverse has no updateMany
        updateMany: { data: { body: "changed" } },
      },
    },
  } satisfies OperationPayload<"update", typeof featuredPost>);
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        connect: { id: "comment-1" },
        // @ts-expect-error - singular inverse has no deleteMany
        deleteMany: {},
      },
    },
  } satisfies OperationPayload<"update", typeof featuredPost>);
  singularInverseClient.featuredPost.create({
    data: {
      id: "post-1",
      featuredComment: {
        create: {
          id: "comment-1",
          body: "first",
          // @ts-expect-error - the enclosing inverse owns this direct membership
          commentable: {
            connect: { type: "post", where: { id: "post-1" } },
          },
        },
      },
    },
  } satisfies OperationPayload<"create", typeof featuredPost>);
};

const _publicSurfaceProbes = [
  inverseCreateSurface,
  inverseUpdateSurface,
  optionalDisconnectAndSet,
  inverseCreateManySatisfiesItsRequiredOwner,
  inverseUpdateCanCreateMany,
  inverseCreateManyStillRefusesAnotherRequiredOwner,
  directCreateAndUpdateSurface,
  requiredDirectRemovalIsRejected,
  rootCreateManyAcceptsConnectOnlyMembership,
  requiredDisconnectIsRejected,
  requiredSetIsRejected,
  updateOwnerCannotBeRestated,
  createOwnerCannotBeRestated,
  typoProbes,
  singularInverseSurface,
  singularInverseNonFreshSurface,
  singularInverseRefusals,
];
