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
  .polymorphicToOne(
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
    // Package D: the collection write family addresses a member exactly where
    // the ordinary to-many operation does, so the DECLARED reach grew one key
    // and this hand-built double must satisfy it.
    whereUniqueExtended: v.object({ id: v.string() }),
    orderBy: v.object({ id: v.enum(["asc", "desc"]) }),
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
    // Package D: the collection write family addresses a member exactly where
    // the ordinary to-many operation does, so the DECLARED reach grew one key
    // and this hand-built double must satisfy it.
    whereUniqueExtended: v.object({ id: v.string() }),
    orderBy: v.object({ id: v.enum(["asc", "desc"]) }),
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
const requiredFilterSchema = polymorphicFilterFactory(
  s.polymorphicToOne({ post: () => post, video: () => video })["~"].state,
  getters
);

type CreateInput = InferInput<typeof createSchema>;
type UpdateInput = InferInput<typeof updateSchema>;
type FilterInput = InferInput<typeof filterSchema>;
type RequiredFilterInput = InferInput<typeof requiredFilterSchema>;

const _nullShorthandFilter: FilterInput = null;
const _isNullFilter: FilterInput = { is: null };
const _isNotNullFilter: FilterInput = { isNot: null };
const nonFreshPresenceFilter = { isNot: null } as const;
const _nonFreshPresenceFilter: FilterInput = nonFreshPresenceFilter;
// @ts-expect-error - required polymorphic relations cannot filter for absence
const _requiredNullFilter: RequiredFilterInput = { is: null };

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
const mixedPresenceFilter = { is: null, isNot: null } as const;
// @ts-expect-error - a presence filter has exactly one intent
const _mixedPresenceFilter: FilterInput = mixedPresenceFilter;

const auditLog = s.model({ id: s.string().id() });
const folder = s.model({
  id: s.string().id(),
  entries: s.oneToMany(() => folderEntry).name("folderEntry"),
});
const folderEntry = s.model({
  id: s.string().id(),
  folder: s
    .polymorphicToOne(
      { folder: () => folder },
      { values: { folder: "folder.entry.v1" } }
    )
    .name("folderEntry"),
  audit: s.polymorphicToOne(
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
  commentable: s
    .polymorphicToOne({ article: () => article })
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
    .polymorphicToOne({ article: () => optionalArticle })
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

// `satisfies` is load-bearing here, not decoration: without it this call measures
// nothing — withholding `disconnect` from every optional polymorphic membership
// leaves it green, because a bare call argument is checked against a weak type
// and `set` alone satisfies the shared-property rule. Other public-surface calls
// do catch that mutation (polymorphic-write-family.test.ts:427 and :2128,
// polymorphic-compound-target.test.ts:200), so this is not the only pin on the
// positive direction; its own coverage is `disconnect` and `set` in ONE payload,
// which is what no other site spells.
const optionalDisconnectAndSet = () =>
  inverseClient.optionalArticle.update({
    where: { id: "article-1" },
    data: {
      comments: {
        disconnect: { id: "comment-1" },
        set: [{ id: "comment-2" }],
      },
    },
  } satisfies OperationPayload<"update", typeof optionalArticle>);

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

const directPresenceFilterSurface = () => {
  inverseClient.optionalRemark.findMany({
    where: { commentable: null },
  });
  inverseClient.optionalRemark.findMany({
    where: { commentable: { is: null } },
  });
  inverseClient.optionalRemark.findMany({
    where: { commentable: { isNot: null } },
  });
  const nonFresh = { commentable: { isNot: null } } as const;
  inverseClient.optionalRemark.findMany({ where: nonFresh });

  inverseClient.optionalRemark.findMany({
    where: {
      commentable: {
        is: null,
        // @ts-expect-error - unknown presence key beside the real key
        iss: null,
      },
    },
  } satisfies OperationPayload<"findMany", typeof optionalRemark>);
  inverseClient.remark.findMany({
    where: {
      // @ts-expect-error - required polymorphic membership cannot be absent
      commentable: null,
    },
  });
  inverseClient.remark.findMany({
    where: {
      // @ts-expect-error - required polymorphic membership cannot filter for absence
      commentable: { is: null },
    },
  });
  inverseClient.remark.findMany({
    where: {
      // @ts-expect-error - required polymorphic membership cannot filter for presence
      commentable: { isNot: null },
    },
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

const requiredSetIsAccepted = () =>
  inverseClient.folder.update({
    where: { id: "folder-1" },
    data: {
      entries: {
        connect: { id: "entry-1" },
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

const selectedUpsertCanReenterOwner = () =>
  inverseClient.optionalArticle.update({
    where: { id: "article-1" },
    data: {
      comments: {
        upsert: {
          where: { id: "comment-1" },
          create: { id: "comment-1", body: "must not create" },
          update: {
            body: "changed",
            commentable: {
              update: {
                type: "article",
                data: { id: "article-2" },
              },
            },
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

const ordinaryRequiredParent = s.model({
  id: s.string().id(),
  child: s.oneToOne(() => ordinaryRequiredChild).optional(),
});
const ordinaryRequiredChild = s.model({
  id: s.string().id(),
  parentId: s.string().unique(),
  parent: s
    .oneToOne(() => ordinaryRequiredParent)
    .fields("parentId")
    .references("id"),
});
const ordinaryOptionalParent = s.model({
  id: s.string().id(),
  child: s.oneToOne(() => ordinaryOptionalChild).optional(),
});
const ordinaryOptionalChild = s.model({
  id: s.string().id(),
  parentId: s.string().nullable().unique(),
  parent: s
    .oneToOne(() => ordinaryOptionalParent)
    .fields("parentId")
    .references("id")
    .optional(),
});
const ordinaryInverseClient = createClient({
  schema: {
    ordinaryRequiredParent,
    ordinaryRequiredChild,
    ordinaryOptionalParent,
    ordinaryOptionalChild,
  },
  driver: new PGliteDriver(),
});

const ordinaryRequiredManyParent = s.model({
  id: s.string().id(),
  children: s.oneToMany(() => ordinaryRequiredManyChild),
});
const ordinaryRequiredManyChild = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string(),
  parent: s
    .manyToOne(() => ordinaryRequiredManyParent)
    .fields("parentId")
    .references("id"),
});
const ordinaryOptionalManyParent = s.model({
  id: s.string().id(),
  children: s.oneToMany(() => ordinaryOptionalManyChild),
});
const ordinaryOptionalManyChild = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .manyToOne(() => ordinaryOptionalManyParent)
    .fields("parentId")
    .references("id")
    .optional(),
});
const ordinaryManyClient = createClient({
  schema: {
    ordinaryRequiredManyParent,
    ordinaryRequiredManyChild,
    ordinaryOptionalManyParent,
    ordinaryOptionalManyChild,
  },
  driver: new PGliteDriver(),
});

const ordinaryInverseAbsenceSurface = () => {
  ordinaryInverseClient.ordinaryRequiredParent.update({
    where: { id: "parent-1" },
    data: { child: { delete: true } },
  });
  ordinaryInverseClient.ordinaryRequiredParent.update({
    where: { id: "parent-1" },
    data: {
      child: {
        // @ts-expect-error - disconnect cannot preserve a child with a required FK
        disconnect: true,
      },
    },
  });
  const optionalMembershipUpdate = {
    where: { id: "parent-2" },
    data: { child: { disconnect: true } },
  } satisfies OperationPayload<"update", typeof ordinaryOptionalParent>;
  ordinaryInverseClient.ordinaryOptionalParent.update(optionalMembershipUpdate);
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-2" },
    data: { child: { delete: true } },
  });
};

const ordinaryToOneOperationCompatibility = () => {
  const disconnectCondition = true as boolean;
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-1" },
    data: { child: { disconnect: disconnectCondition } },
  });
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-1" },
    data: {
      child: { disconnect: false, connect: { id: "child-1" } },
    },
  });
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-1" },
    data: {
      child: { disconnect: true, connect: { id: "child-1" } },
    },
  });
  const replacement = {
    delete: true,
    create: { id: "child-2" },
  } as const;
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-1" },
    data: { child: replacement },
  });

  // LATTICE CHANGE (Package H): supply-then-modify. A child-held `connect` beside an
  // `update` names one target and then modifies it, so this is now an accepted
  // composition rather than two contradictory operations. Two SUPPLIERS still are.
  const supplyThenModify = {
    connect: { id: "child-1" },
    update: { id: "child-2" },
  } as const;
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-1" },
    data: { child: supplyThenModify },
  });

  const contradictory = {
    connect: { id: "child-1" },
    create: { id: "child-2" },
  } as const;
  ordinaryInverseClient.ordinaryOptionalParent.update({
    where: { id: "parent-1" },
    data: {
      // @ts-expect-error - a to-one payload cannot name two suppliers for one slot
      child: contradictory,
    },
  });
};

const ordinaryToManyCapabilitySurface = () => {
  ordinaryManyClient.ordinaryRequiredManyParent.update({
    where: { id: "parent-1" },
    data: {
      children: {
        set: [{ id: "child-1" }],
        // @ts-expect-error - required child membership cannot disconnect
        disconnect: { id: "child-2" },
      },
    },
  } satisfies OperationPayload<"update", typeof ordinaryRequiredManyParent>);
  ordinaryManyClient.ordinaryOptionalManyParent.update({
    where: { id: "parent-1" },
    data: { children: { disconnect: { id: "child-1" } } },
  });
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
    .polymorphicToOne({ post: () => featuredPost, video: () => featuredVideo })
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
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        disconnect: true,
        connect: { id: "comment-1" },
      },
    },
  });
  const replacement = {
    delete: true,
    create: { id: "comment-3", body: "replacement" },
  } as const;
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: { featuredComment: replacement },
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

const requiredMembershipPost = s.model({
  id: s.string().id(),
  featuredComment: s
    .oneToOne(() => requiredMembershipComment)
    .name("requiredMembership")
    .optional(),
});
const requiredMembershipVideo = s.model({
  id: s.string().id(),
  featuredComment: s
    .oneToOne(() => requiredMembershipComment)
    .name("requiredMembership")
    .optional(),
});
const requiredMembershipComment = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .polymorphicToOne({
      post: () => requiredMembershipPost,
      video: () => requiredMembershipVideo,
    })
    .name("requiredMembership"),
});
const requiredMembershipClient = createClient({
  schema: {
    requiredMembershipPost,
    requiredMembershipVideo,
    requiredMembershipComment,
  },
  driver: new PGliteDriver(),
});

const requiredMembershipSurface = () => {
  requiredMembershipClient.requiredMembershipPost.update({
    where: { id: "post-1" },
    data: { featuredComment: { delete: true } },
  });
  requiredMembershipClient.requiredMembershipPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        // @ts-expect-error - disconnect would preserve a child whose membership is required
        disconnect: true,
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

/**
 * PHASE 8.1 — the polymorphic-inverse to-one surface IS the ordinary to-one surface,
 * so the composition lattice it publishes is the same one, decided from the same
 * direction flag. These rows are the lattice's own decisions read through the public
 * client: every refused row spells TWO real keys, because a single unknown key on a
 * weak to-one type is refused by weak-type detection instead of by the lattice.
 */
const polymorphicInverseToOneLatticeSurface = () => {
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        connect: { id: "comment-1" },
        update: { body: "changed" },
      },
    },
  } satisfies OperationPayload<"update", typeof featuredPost>);
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        disconnect: true,
        connectOrCreate: {
          where: { id: "comment-2" },
          create: { id: "comment-2", body: "second" },
        },
      },
    },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        delete: true,
        create: { id: "comment-3", body: "third" },
        update: { body: "changed" },
      },
    },
  });
};

// The marker sits where the ORDINARY lattice probe file measured TypeScript to report
// each shape (`to-one-composition-lattice.core.types.ts`): on the payload itself when
// no arm is a best match, on the offending key when one arm is.
const polymorphicInverseToOneLatticeRefusals = () => {
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        connect: { id: "comment-1" },
        // @ts-expect-error - two suppliers name two identities for one slot
        create: { id: "comment-2", body: "second" },
      },
    },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      // @ts-expect-error - one slot cannot be vacated twice
      featuredComment: { disconnect: true, delete: true },
    },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        upsert: {
          create: { id: "comment-1", body: "first" },
          update: { body: "changed" },
        },
        // @ts-expect-error - `upsert` already decides the target with its own two arms
        connect: { id: "comment-2" },
      },
    },
  });
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      featuredComment: {
        delete: true,
        // @ts-expect-error - `delete` + `connectOrCreate` is not an accepted replacement
        connectOrCreate: {
          where: { id: "comment-2" },
          create: { id: "comment-2", body: "second" },
        },
      },
    },
  });
};

/**
 * The NON-FRESH half of the pair above: a payload built as a variable gets no
 * excess-property check, so its exclusivity is carried by the `?: never` siblings of
 * each accepted arm rather than by freshness.
 */
const nonFreshPolymorphicInverseToOne = {
  disconnect: true,
  connect: { id: "comment-1" },
} as const;

const nonFreshPolymorphicInverseToMany = {
  connect: { id: "comment-1" },
  set: [{ id: "comment-2" }],
};

const polymorphicInverseNonFreshSurface = () => {
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: { featuredComment: nonFreshPolymorphicInverseToOne },
  });
  inverseClient.optionalArticle.update({
    where: { id: "article-1" },
    data: { comments: nonFreshPolymorphicInverseToMany },
  });
};

const nonFreshPolymorphicInverseToOneRefusal = {
  connect: { id: "comment-1" },
  create: { id: "comment-2", body: "second" },
} as const;

const polymorphicInverseNonFreshRefusal = () =>
  singularInverseClient.featuredPost.update({
    where: { id: "post-1" },
    data: {
      // @ts-expect-error - a non-fresh payload cannot name two suppliers either
      featuredComment: nonFreshPolymorphicInverseToOneRefusal,
    },
  });

// The nesting level where the projection has to be decided PER RELATION: one payload
// carrying an ordinary inverse (the child holds a foreign-key scalar) and a
// polymorphic one (the child holds a direct relation key) side by side.
const dualParent = s.model({
  id: s.string().id(),
  ordinaryChildren: s.oneToMany(() => dualOrdinaryChild),
  taggedChildren: s.oneToMany(() => dualTaggedChild).name("dualTagged"),
});
const dualOrdinaryChild = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string(),
  parent: s
    .manyToOne(() => dualParent)
    .fields("parentId")
    .references("id"),
});
const dualTaggedChild = s.model({
  id: s.string().id(),
  label: s.string(),
  owner: s
    .polymorphicToOne(
      { parent: () => dualParent },
      { values: { parent: "dual.parent.v1" } }
    )
    .name("dualTagged"),
});
const dualClient = createClient({
  schema: { dualParent, dualOrdinaryChild, dualTaggedChild },
  driver: new PGliteDriver(),
});

const dualInverseNestingSurface = () => {
  dualClient.dualParent.create({
    data: {
      id: "parent-1",
      ordinaryChildren: { create: { id: "ordinary-1", label: "a" } },
      taggedChildren: { create: { id: "tagged-1", label: "b" } },
    },
  } satisfies OperationPayload<"create", typeof dualParent>);
  dualClient.dualParent.update({
    where: { id: "parent-1" },
    data: {
      ordinaryChildren: {
        update: { where: { id: "ordinary-1" }, data: { label: "a2" } },
      },
      taggedChildren: {
        update: { where: { id: "tagged-1" }, data: { label: "b2" } },
      },
    },
  } satisfies OperationPayload<"update", typeof dualParent>);
};

const dualInverseNestingRefusals = () => {
  dualClient.dualParent.create({
    data: {
      id: "parent-1",
      ordinaryChildren: {
        create: {
          id: "ordinary-1",
          label: "a",
          // @ts-expect-error - the enclosing ordinary edge derives this foreign key
          parentId: "parent-1",
        },
      },
    },
  } satisfies OperationPayload<"create", typeof dualParent>);
  dualClient.dualParent.create({
    data: {
      id: "parent-1",
      taggedChildren: {
        create: {
          id: "tagged-1",
          label: "b",
          // @ts-expect-error - the enclosing polymorphic edge supplies this membership
          owner: { connect: { type: "parent", where: { id: "parent-2" } } },
        },
      },
    },
  } satisfies OperationPayload<"create", typeof dualParent>);
};

/**
 * PACKAGE D — THE COLLECTION WRITE TYPE HALF.
 *
 * The runtime and the types must flip together: under Package C a collection's
 * `create`/`update` families were `v.refused`, which types as `never`, and every
 * public-client pin carried a `@ts-expect-error` that would become an
 * unused-directive build error the moment the runtime became real. These probes
 * are the positive half — the shapes that must now COMPILE — beside the ones that
 * must still not.
 */
const collectionWriteSurface = () => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const clip = s.model({ id: s.string().id(), seconds: s.int() });
  const board = s.model({
    id: s.string().id(),
    items: s.polymorphicToMany(
      { post: () => post, clip: () => clip },
      { values: { post: "t.post.v1", clip: "t.clip.v1" } }
    ),
  });

  const _create = {
    data: {
      id: "b1",
      items: {
        connect: [{ type: "post", where: { id: "p1" } }],
        create: { type: "clip", data: { id: "c1", seconds: 12 } },
        createMany: [{ type: "post", data: [{ id: "p2", title: "t" }] }],
      },
    },
  } satisfies OperationPayload<"create", typeof board>;

  const _update = {
    where: { id: "b1" },
    data: {
      items: {
        set: [],
        disconnect: { type: "post", where: { id: "p1" } },
        update: [{ type: "clip", where: { id: "c1" }, data: { seconds: 13 } }],
        upsert: [
          {
            type: "post",
            where: { id: "p3" },
            create: { id: "p3", title: "t" },
            update: { title: "t2" },
          },
        ],
      },
    },
  } satisfies OperationPayload<"update", typeof board>;
};

const collectionWriteRefusals = () => {
  const post = s.model({ id: s.string().id(), title: s.string() });
  const clip = s.model({ id: s.string().id(), seconds: s.int() });
  const board = s.model({
    id: s.string().id(),
    items: s.polymorphicToMany(
      { post: () => post, clip: () => clip },
      { values: { post: "r.post.v1", clip: "r.clip.v1" } }
    ),
  });

  const _noUpsertOnCreate = {
    data: {
      id: "b1",
      items: {
        // @ts-expect-error - the create bag carries no `upsert` (the pinned asymmetry)
        upsert: [
          {
            type: "post",
            where: { id: "p1" },
            create: { id: "p1", title: "t" },
            update: { title: "t" },
          },
        ],
      },
    },
  } satisfies OperationPayload<"create", typeof board>;

  const _untaggedIsNotThisGrammar = {
    where: { id: "b1" },
    data: {
      items: {
        // @ts-expect-error - the discriminator lives INSIDE each verb
        connect: [{ post: { id: "p1" } }],
      },
    },
  } satisfies OperationPayload<"update", typeof board>;

  // PACKAGE E — the ROOT `createMany` ROW now mounts the SAME collection `create`
  // family, because the row is relation-BEARING and routes to the record series.
  // The directive that used to sit on `items` here is deliberately gone: an unused
  // `@ts-expect-error` is a build error, so this line proves the flip in the type
  // half as loudly as the runtime half.
  const _bulkRowCarriesTheCreateFamily = {
    data: [
      {
        id: "b1",
        items: { connect: [{ type: "post", where: { id: "p1" } }] },
      },
    ],
  } satisfies OperationPayload<"createMany", typeof board>;

  // ...and the row's family really is the COLLECTION one, not the to-one
  // connect-only union: a tagged `create` verb is only in the former.
  const _bulkRowTakesTaggedCreate = {
    data: [
      {
        id: "b2",
        items: { create: [{ type: "post", data: { id: "p2", title: "t" } }] },
      },
    ],
  } satisfies OperationPayload<"createMany", typeof board>;
};

/**
 * THE INVERSE COLLECTION LATTICE, type half — BOTH ARITIES OPEN (plan §9.4/§9.5).
 *
 * The PLURAL inverse is a fixed-variant ordinary junction view and takes the
 * ordinary to-many families. The SINGULAR inverse takes the ordinary TO-ONE
 * families, whole: a member-junction row under a UNIQUE over the complete variant
 * side is a to-one slot, and `RelationJunctionToOnePart` lowers its four
 * correlated spellings. Neither half is spelled with a `type` discriminator —
 * the variant is fixed by the declaration.
 *
 * The `@ts-expect-error` that used to sit on the singular row is deliberately
 * gone. It was load-bearing in BOTH directions — an unused directive is itself a
 * build error — so this file could not compile until the pin was revisited, which
 * is exactly what happened to the plural row before it.
 */
const inverseCollectionWriteFamilies = () => {
  const shelf = s.model({
    id: s.string().id(),
    label: s.string(),
    items: s.polymorphicToMany(
      { book: () => book, clip: () => clip },
      { values: { book: "i.book.v1", clip: "i.clip.v1" } }
    ),
  });
  const book = s.model({
    id: s.string().id(),
    shelf: s.manyToOne(() => shelf).optional(),
  });
  const clip = s.model({
    id: s.string().id(),
    shelves: s.manyToMany(() => shelf),
  });

  const _singularInverseCreate = {
    data: {
      id: "b1",
      shelf: { connect: { id: "s1" } },
    },
  } satisfies OperationPayload<"create", typeof book>;

  // The UPDATE family carries both removal verbs, because `P021` forces
  // `.optional()` on this shape and `slotMayBeEmpty` is the only fact they hang
  // on — plus the two correlated modifies, which spell no `where` at all.
  const _singularInverseUpdate = {
    where: { id: "b1" },
    data: {
      shelf: {
        disconnect: true,
      },
    },
  } satisfies OperationPayload<"update", typeof book>;

  const _singularInverseComposition = {
    where: { id: "b1" },
    data: {
      shelf: {
        disconnect: true,
        connect: { id: "s2" },
        update: { label: "renamed" },
      },
    },
  } satisfies OperationPayload<"update", typeof book>;

  const _singularInverseUpsert = {
    where: { id: "b1" },
    data: {
      shelf: {
        upsert: {
          create: { id: "s3", label: "made" },
          update: { label: "kept" },
        },
      },
    },
  } satisfies OperationPayload<"update", typeof book>;

  // ...and it is still a TO-ONE family: no array spelling, and no to-many verb.
  const _singularInverseIsNotPlural = {
    where: { id: "b1" },
    data: {
      shelf: {
        // @ts-expect-error - a singular slot has no `set`
        set: [{ id: "s1" }],
      },
    },
  } satisfies OperationPayload<"update", typeof book>;

  // THE PLURAL INVERSE, FLIPPED. It is a polymorphic-bound `manyToMany`, so it
  // takes `ToManySchemas` verbatim — every ordinary junction verb, in reversed
  // orientation, with no `type` field because the variant is fixed by the
  // declaration.
  const _pluralInverseSet = {
    where: { id: "c1" },
    data: { shelves: { set: [] } },
  } satisfies OperationPayload<"update", typeof clip>;

  const _pluralInverseFullLattice = {
    where: { id: "c1" },
    data: {
      shelves: {
        connect: [{ id: "s1" }],
        disconnect: [{ id: "s2" }],
        create: [{ id: "s3", label: "L" }],
        update: [{ where: { id: "s4" }, data: { label: "L4" } }],
        deleteMany: [{ id: { equals: "s5" } }],
      },
    },
  } satisfies OperationPayload<"update", typeof clip>;

  const _pluralInverseCreateRoot = {
    data: {
      id: "c2",
      shelves: {
        connectOrCreate: [
          { where: { id: "s6" }, create: { id: "s6", label: "L6" } },
        ],
      },
    },
  } satisfies OperationPayload<"create", typeof clip>;

  // …and the family carries NO `type` discriminator: the variant is already
  // fixed by which model declares the inverse.
  const _pluralInverseHasNoTypeField = {
    where: { id: "c1" },
    data: {
      shelves: {
        // @ts-expect-error - a fixed-variant inverse takes the ORDINARY junction verbs
        connect: [{ type: "clip", where: { id: "s1" } }],
      },
    },
  } satisfies OperationPayload<"update", typeof clip>;
};

const _publicSurfaceProbes = [
  collectionWriteSurface,
  collectionWriteRefusals,
  inverseCollectionWriteFamilies,
  inverseCreateSurface,
  inverseUpdateSurface,
  optionalDisconnectAndSet,
  inverseCreateManySatisfiesItsRequiredOwner,
  inverseUpdateCanCreateMany,
  inverseCreateManyStillRefusesAnotherRequiredOwner,
  directCreateAndUpdateSurface,
  directPresenceFilterSurface,
  requiredDirectRemovalIsRejected,
  rootCreateManyAcceptsConnectOnlyMembership,
  requiredDisconnectIsRejected,
  requiredSetIsAccepted,
  updateOwnerCannotBeRestated,
  selectedUpsertCanReenterOwner,
  createOwnerCannotBeRestated,
  typoProbes,
  singularInverseSurface,
  singularInverseNonFreshSurface,
  singularInverseRefusals,
  requiredMembershipSurface,
  ordinaryInverseAbsenceSurface,
  ordinaryToOneOperationCompatibility,
  ordinaryToManyCapabilitySurface,
  polymorphicInverseToOneLatticeSurface,
  polymorphicInverseToOneLatticeRefusals,
  polymorphicInverseNonFreshSurface,
  polymorphicInverseNonFreshRefusal,
  dualInverseNestingSurface,
  dualInverseNestingRefusals,
];
