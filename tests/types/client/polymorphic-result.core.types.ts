import { createClient } from "@client/client";
import type { OperationResult } from "@client/types";
import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import { s } from "@schema";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;

const author = s.model({
  id: s.string().id(),
  name: s.string(),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  authorId: s.string(),
  author: s
    .manyToOne(() => author)
    .fields("authorId")
    .references("id"),
});

const video = s.model({
  id: s.string().id(),
  duration: s.int(),
  token: s.string(),
});

const subject = s.polymorphic(
  { post: () => post, video: () => video },
  { values: { post: "content.post.v1", video: "content.video.v1" } }
);

const comment = s.model({
  id: s.string().id(),
  body: s.string(),
  subject,
});

const optionalComment = s.model({
  id: s.string().id(),
  subject: s
    .polymorphic(
      { post: () => post, video: () => video },
      { values: { post: "optional.post.v1", video: "optional.video.v1" } }
    )
    .optional(),
});

const client = createClient({
  schema: { author, post, video, comment, optionalComment },
  driver: new PGliteDriver(),
});

type _commentPolymorphicKeyIsConcrete = Expect<
  Equal<keyof (typeof comment)["~"]["state"]["polymorphicRelations"], "subject">
>;

const _publicPolymorphicCalls = () => {
  client.comment.create({
    data: {
      id: "comment-1",
      body: "hello",
      subject: { connect: { type: "post", where: { id: "post-1" } } },
    },
    include: {
      subject: {
        post: { include: { author: { select: { name: true } } } },
        video: { select: { duration: true } },
      },
    },
  });

  client.comment.findMany({
    where: { subject: { type: "post", is: { title: "hello" } } },
    include: { subject: true },
  });

  client.optionalComment.create({ data: { id: "optional-1" } });
  client.optionalComment.update({
    where: { id: "optional-1" },
    data: { subject: { disconnect: true } },
  });

  client.comment.create({
    // @ts-expect-error - required direct polymorphic relation cannot be omitted
    data: { id: "comment-2", body: "missing relation" },
  });

  client.comment.findMany({
    select: {
      subject: {
        post: true,
        // @ts-expect-error - direct polymorphic variant names are exact
        pst: true,
      },
    },
  });

  client.comment.findMany({
    include: {
      subject: {
        video: true,
        // @ts-expect-error - direct polymorphic variant names are exact
        viideo: true,
      },
    },
  });

  const nonFreshSelect = {
    subject: { post: true, pst: true },
  };
  client.comment.findMany({
    // @ts-expect-error - non-fresh discriminator maps stay exact
    select: nonFreshSelect,
  });

  const nonFreshInclude = {
    subject: { video: true, viideo: true },
  };
  client.comment.findMany({
    // @ts-expect-error - non-fresh discriminator maps stay exact
    include: nonFreshInclude,
  });

  const dynamicVariants: Record<string, true> = { post: true };
  client.comment.findMany({ include: { subject: dynamicVariants } });

  // Depth-three target fields retain the existing public operation ceiling:
  // runtime validation rejects these misspellings, but generic inference does
  // not resolve a recursive target model merely to seal this nested node.
  client.comment.findMany({
    include: {
      subject: {
        post: { select: { title: true, ttitle: true } },
      },
    },
  });
};

void _publicPolymorphicCalls;

type DefaultRows = OperationResult<
  "findMany",
  typeof comment,
  { include: { subject: true } }
>;
type DefaultSubject = DefaultRows[number]["subject"];
type _defaultIsNotAny = Expect<
  IsAny<DefaultSubject> extends false ? true : false
>;
type _defaultIsExhaustive = Expect<
  Equal<
    DefaultSubject,
    | {
        readonly type: "post";
        readonly data: {
          id: string;
          title: string;
          secret: string;
          authorId: string;
        };
      }
    | {
        readonly type: "video";
        readonly data: { id: string; duration: number; token: string };
      }
  >
>;

type SelectiveRows = OperationResult<
  "findMany",
  typeof comment,
  {
    include: {
      subject: {
        post: { select: { title: true } };
      };
    };
  }
>;
type _omittedVariantKeepsDefaultProjection = Expect<
  Equal<
    SelectiveRows[number]["subject"],
    | { readonly type: "post"; readonly data: { title: string } }
    | {
        readonly type: "video";
        readonly data: { id: string; duration: number; token: string };
      }
  >
>;

const configuredRows = () =>
  client.comment.findMany({
    select: {
      subject: {
        post: {
          include: { author: true },
          omit: { secret: true },
        },
        video: {
          select: { id: true, duration: true },
          omit: { duration: true },
        },
      },
    },
  });
type ConfiguredRows = Awaited<ReturnType<typeof configuredRows>>;
type _configuredNodesReuseOrdinaryProjectionInference = Expect<
  Equal<
    ConfiguredRows[number]["subject"],
    | {
        readonly type: "post";
        readonly data: {
          id: string;
          title: string;
          authorId: string;
          author: { id: string; name: string };
        };
      }
    | {
        readonly type: "video";
        readonly data: { id: string };
      }
  >
>;

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
type FeaturedPostRows = OperationResult<
  "findMany",
  typeof featuredPost,
  { include: { featuredComment: true } }
>;
type _singularInverseResultIsNullableObject = Expect<
  Equal<
    FeaturedPostRows[number]["featuredComment"],
    { id: string; body: string } | null
  >
>;

type OptionalRows = OperationResult<
  "findMany",
  typeof optionalComment,
  { include: { subject: true } }
>;
type _optionalRelationAddsNull = Expect<
  Equal<
    OptionalRows[number]["subject"],
    | {
        readonly type: "post";
        readonly data: {
          id: string;
          title: string;
          secret: string;
          authorId: string;
        };
      }
    | {
        readonly type: "video";
        readonly data: { id: string; duration: number; token: string };
      }
    | null
  >
>;

type FalseRows = OperationResult<
  "findMany",
  typeof comment,
  { include: { subject: false } }
>;
type _relationLevelFalseOmitsTheField = Expect<
  Equal<FalseRows[number], { id: string; body: string }>
>;

const targetOmitClient = createClient({
  schema: { author, post, video, comment },
  driver: new PGliteDriver(),
  omit: {
    post: { secret: true },
    video: { token: true },
  },
});
const targetOmitRows = targetOmitClient.comment.findMany({
  include: { subject: true },
});
type _nestedClientOmitNarrowsEveryTarget = Expect<
  Equal<
    Awaited<typeof targetOmitRows>[number]["subject"],
    | {
        readonly type: "post";
        readonly data: { id: string; title: string; authorId: string };
      }
    | {
        readonly type: "video";
        readonly data: { id: string; duration: number };
      }
  >
>;

const treeNode = s.model({
  id: s.string().id(),
  parent: s.polymorphic(
    { node: () => treeNode },
    { values: { node: "tree.node.v1" } }
  ),
});
const treeClient = createClient({
  schema: { treeNode },
  driver: new PGliteDriver(),
});
const treeRows = treeClient.treeNode.findMany({
  include: { parent: { node: { select: { id: true } } } },
});
type TreeParent = Awaited<typeof treeRows>[number]["parent"];
type _selfRecursivePublicResultIsNotAny = Expect<
  IsAny<TreeParent> extends false ? true : false
>;
type _selfRecursivePublicResult = Expect<
  Equal<TreeParent, { readonly type: "node"; readonly data: { id: string } }>
>;

const leftNode = s.model({
  id: s.string().id(),
  right: s.polymorphic(
    { right: () => rightNode },
    { values: { right: "pair.right.v1" } }
  ),
});
const rightNode = s.model({
  id: s.string().id(),
  left: s.polymorphic(
    { left: () => leftNode },
    { values: { left: "pair.left.v1" } }
  ),
});
const recursiveDriverClient = createPGliteClient({
  schema: { leftNode, rightNode },
});
const mutualRows = recursiveDriverClient.leftNode.findMany({
  include: {
    right: {
      right: { include: { left: true } },
    },
  },
});
type MutualRight = Awaited<typeof mutualRows>[number]["right"];
type _mutualRecursiveDriverResultIsNotAny = Expect<
  IsAny<MutualRight> extends false ? true : false
>;
type _mutualRecursiveDriverResult = Expect<
  Equal<
    MutualRight,
    {
      readonly type: "right";
      readonly data: {
        id: string;
        left: { readonly type: "left"; readonly data: { id: string } };
      };
    }
  >
>;
