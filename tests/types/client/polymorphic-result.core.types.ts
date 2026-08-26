import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
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
  // The inverse is not decoration: without it the pairing is unproven and the
  // OWNER's own slot infers nullable, because an unproven graph never claims
  // non-nullability (§8.1 step 7).
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});

const video = s.model({
  id: s.string().id(),
  duration: s.int(),
  token: s.string(),
});

const subject = s.toOne(
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
    .toOne(
      { post: () => post, video: () => video },
      { values: { post: "optional.post.v1", video: "optional.video.v1" } }
    )
    .optional(),
});

const client = createClient({
  schema: { author, post, video, comment, optionalComment },
  driver: new PGliteDriver(),
});

type _commentRelationKeyIsConcrete = Expect<
  Equal<keyof (typeof comment)["~"]["state"]["relations"], "subject">
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

export { _publicPolymorphicCalls };

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
  featuredComment: s.toOne(() => featuredComment).name("featuredCommentable"),
});
const featuredVideo = s.model({
  id: s.string().id(),
  featuredComment: s.toOne(() => featuredComment).name("featuredCommentable"),
});
const featuredComment = s.model({
  id: s.string().id(),
  body: s.string(),
  commentable: s
    .toOne({ post: () => featuredPost, video: () => featuredVideo })
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

const targetOmitSchema = { author, post, video, comment };
const targetOmitClient = createClient({
  schema: targetOmitSchema,
  driver: new PGliteDriver(),
}).$extends(
  defaultOmit<typeof targetOmitSchema>()({
    post: { secret: true },
    video: { token: true },
  })
);
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
  parent: s.toOne(
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
  right: s.toOne(
    { right: () => rightNode },
    { values: { right: "pair.right.v1" } }
  ),
});
const rightNode = s.model({
  id: s.string().id(),
  left: s.toOne({ left: () => leftNode }, { values: { left: "pair.left.v1" } }),
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

// =============================================================================
// PACKAGE C — THE COLLECTION RESULT SHAPE
// =============================================================================
//
// This block replaces the B3 pin that recorded the TYPE-ADVERTISES /
// RUNTIME-REFUSES skew for a collection slot. Both halves moved together: the
// grammar now builds real collection families
// (`tests/unit/operation-schemas/relations/polymorphic-collection-*.core.test.ts`)
// and the types below read the declared cardinality through
// `PolymorphicCardinalityOf` rather than assuming the singular envelope.
//
// Writes are still refused — by NAME now, not by omission — and that half is
// pinned at the parse boundary and through the public client, not here: a
// refused family types as `never`, so a write payload no longer compiles and a
// type-level "still refused" assertion would measure nothing.

const attachment = s.model({
  id: s.string().id(),
  url: s.string(),
  size: s.int(),
});
const clip = s.model({ id: s.string().id(), seconds: s.int() });
const gallery = s.model({
  id: s.string().id(),
  attachments: s.toMany(
    { attachment: () => attachment, clip: () => clip },
    { values: { attachment: "gal.attachment.v1", clip: "gal.clip.v1" } }
  ),
});

type GalleryAttachments<Args> = Extract<
  OperationResult<"findMany", typeof gallery, Args>[number],
  { attachments: unknown }
>["attachments"];

type AttachmentArm = {
  readonly type: "attachment";
  readonly data: { id: string; url: string; size: number };
};
type ClipArm = {
  readonly type: "clip";
  readonly data: { id: string; seconds: number };
};

// A COLLECTION IS AN ARRAY, and it is never `| null`: emptiness is `[]`, which
// is why `optional` is unspellable on a collection state at all.
type _collectionIsAnExhaustiveArray = Expect<
  Equal<
    GalleryAttachments<{ include: { attachments: true } }>,
    readonly (AttachmentArm | ClipArm)[]
  >
>;

// A LITERAL allow-list narrows the element union.
type _literalOnlyNarrows = Expect<
  Equal<
    GalleryAttachments<{ include: { attachments: { only: ["attachment"] } } }>,
    readonly AttachmentArm[]
  >
>;

// A DYNAMIC allow-list narrows nothing — only the runtime knows which members
// it holds, so promising one variant would be a lie in the unsafe direction.
type _dynamicOnlyStaysExhaustive = Expect<
  Equal<
    GalleryAttachments<{
      include: { attachments: { only: ("attachment" | "clip")[] } };
    }>,
    readonly (AttachmentArm | ClipArm)[]
  >
>;

// A MAYBE-UNDEFINED allow-list also narrows nothing. This is the ordering rule:
// `readonly ["attachment"] | undefined` matches `readonly (infer T)[]` on its
// defined member, so testing the element extraction FIRST would narrow a call
// that may pass no allow-list at all.
type _maybeUndefinedOnlyStaysExhaustive = Expect<
  Equal<
    GalleryAttachments<{
      include: { attachments: { only: readonly ["attachment"] | undefined } };
    }>,
    readonly (AttachmentArm | ClipArm)[]
  >
>;

// `only: []` — a fresh empty array at runtime, `readonly never[]` in the types.
// The array wrapper sits OUTSIDE the never-collapse: collapsing the element
// union to `never` would type this call as returning nothing at all.
type _emptyOnlyIsAnEmptyArrayType = Expect<
  Equal<
    GalleryAttachments<{ include: { attachments: { only: [] } } }>,
    readonly never[]
  >
>;

// An arm's projection is read THROUGH `variants`, and an unnamed variant keeps
// its default projection.
type _armProjectionNarrowsThroughVariants = Expect<
  Equal<
    GalleryAttachments<{
      include: {
        attachments: { variants: { attachment: { select: { url: true } } } };
      };
    }>,
    readonly (
      | { readonly type: "attachment"; readonly data: { url: string } }
      | ClipArm
    )[]
  >
>;

// A MAYBE-UNDEFINED `variants` CONTAINER: both worlds are possible, so the arm
// is the honest union of "configured" and "default".
type _maybeUndefinedVariantsContainer = Expect<
  Equal<
    GalleryAttachments<{
      include: {
        attachments: {
          variants: { attachment: { select: { url: true } } } | undefined;
        };
      };
    }>,
    readonly (
      | {
          readonly type: "attachment";
          readonly data:
            | { url: string }
            | { id: string; url: string; size: number };
        }
      | ClipArm
    )[]
  >
>;

// A MAYBE-UNDEFINED ARM, same rule one level down.
type _maybeUndefinedArm = Expect<
  Equal<
    GalleryAttachments<{
      include: {
        attachments: {
          variants: { attachment: { select: { url: true } } | undefined };
        };
      };
    }>,
    readonly (
      | {
          readonly type: "attachment";
          readonly data:
            | { url: string }
            | { id: string; url: string; size: number };
        }
      | ClipArm
    )[]
  >
>;

// `_count` reaches the collection: the shorthand LISTS it, and the explicit
// form types it as `number`.
type _countShorthandListsTheCollection = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof gallery,
      { select: { _count: true } }
    >[number],
    { _count: { attachments: number } }
  >
>;
type _explicitCountTypesTheCollection = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof gallery,
      { select: { _count: { select: { attachments: true } } } }
    >[number],
    { _count: { attachments: number } }
  >
>;

// =============================================================================
// HOSTILE VARIANT NAMES — `only` and `variants` as public discriminators
// =============================================================================
//
// Arms live UNDER `variants`, so the envelope's two reserved keys sit one level
// above the discriminator map and cannot collide with a variant of either name.

const onlyTarget = s.model({ id: s.string().id() });
const variantsTarget = s.model({ id: s.string().id(), label: s.string() });
const hostileGallery = s.model({
  id: s.string().id(),
  items: s.toMany(
    { only: () => onlyTarget, variants: () => variantsTarget },
    { values: { only: "hos.only.v1", variants: "hos.variants.v1" } }
  ),
});

type _hostileVariantNamesResolve = Expect<
  Equal<
    OperationResult<
      "findMany",
      typeof hostileGallery,
      {
        include: {
          items: {
            only: ["only", "variants"];
            variants: { variants: { select: { label: true } } };
          };
        };
      }
    >[number]["items"],
    readonly (
      | { readonly type: "only"; readonly data: { id: string } }
      | { readonly type: "variants"; readonly data: { label: string } }
    )[]
  >
>;

// =============================================================================
// RECURSION — a collection slot must not collapse a mutually recursive schema
// =============================================================================

const branch = s.model({
  id: s.string().id(),
  children: s.toMany(
    { branch: () => branch },
    { values: { branch: "rec.b.v1" } }
  ),
});
const recursiveCollectionClient = createClient({
  schema: { branch },
  driver: new PGliteDriver(),
});
const branchRows = recursiveCollectionClient.branch.findMany({
  include: { children: { variants: { branch: { select: { id: true } } } } },
});
type BranchChildren = Awaited<typeof branchRows>[number]["children"];
type _selfRecursiveCollectionIsNotAny = Expect<
  IsAny<BranchChildren> extends false ? true : false
>;
type _selfRecursiveCollectionResolves = Expect<
  Equal<
    BranchChildren,
    readonly { readonly type: "branch"; readonly data: { id: string } }[]
  >
>;
