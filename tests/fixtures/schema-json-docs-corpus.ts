/**
 * The acceptance corpus: every schema-declaring code fence in the schema docs,
 * transliterated to a document.
 *
 * `docs/content/docs/schema/**` holds 173 fences (157 `ts`, 8 `sql`, 4 `json`,
 * 3 `text`, 1 `mermaid`). 39 of them spell `s.model(`; the other 134 are
 * queries, results, error output or scalar snippets with no schema to state.
 * The 3 `json` fences are documents rather than declarations: the suite runs
 * them directly instead of transliterating them. Of those 39:
 *
 *  - 36 are here, each as the fence's own declarations plus the JSON twin;
 *  - `index.mdx` fence #1 is prose — `s.model({ ... })` with a literal ellipsis
 *    — and declares nothing to transliterate;
 *  - `model.mdx` fences #0 and #8 carry `.default(() => new Date())`, the
 *    function default v1 refuses. Their witnesses live in the suite.
 *
 * Three fences in `scalars/json.mdx` (#1, #3, #4) carry `.schema(validator)` at
 * the SCALAR level; they declare no model, so they are not among the 38, and
 * their refusal witness lives in the suite too.
 *
 * Several fences are excerpts that name a model the fence does not define. Each
 * entry completes the excerpt with the smallest schema that pairs — the
 * completion is marked in `completed` so the corpus never pretends a fence said
 * more than it did.
 */

import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import type { SchemaDocument } from "@schema/json";

export interface DocsFenceCase {
  /** `<file>#<fence index>` — the fence's address in the docs tree. */
  readonly id: string;
  /** Models the fence does not declare, added so the excerpt resolves. */
  readonly completed?: readonly string[];
  readonly coded: () => Schema;
  readonly document: SchemaDocument;
}

const ULID = { type: "string", id: true, generate: { kind: "ulid" } } as const;
const ID = { type: "string", id: true, generate: { kind: "ulid" } } as const;
const STRING = { type: "string" } as const;

export const docsFenceCorpus: DocsFenceCase[] = [
  {
    id: "index.mdx#0",
    completed: ["post"],
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        email: s.string().unique(),
        name: s.string().nullable(),
        posts: s.toMany(() => post),
      });
      const post = s.model({
        id: s.string().id().ulid(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      });
      return { user, post };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            email: { type: "string", unique: true },
            name: { type: "string", nullable: true },
            posts: { type: "toMany", target: "post" },
          },
        },
        post: {
          fields: {
            id: ULID,
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
        },
      },
    },
  },
  {
    id: "index.mdx#3",
    coded: () => ({
      user: s.model({
        id: s.string().id(),
        email: s.string(),
        age: s.int().nullable(),
      }),
    }),
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ID,
            email: STRING,
            age: { type: "int", nullable: true },
          },
        },
      },
    },
  },
  {
    id: "model.mdx#5",
    completed: ["user"],
    coded: () => {
      const post = s
        .model({
          id: s.string().id().ulid(),
          title: s.string(),
          createdAt: s.dateTime().now(),
          authorId: s.string(),
          author: s
            .toOne(() => user)
            .fields("authorId")
            .references("id"),
        })
        .index(["authorId", "createdAt"]);
      const user = s.model({
        id: s.string().id().ulid(),
        posts: s.toMany(() => post),
      });
      return { post, user };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            createdAt: { type: "datetime", generate: { kind: "now" } },
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
          indexes: [{ fields: ["authorId", "createdAt"] }],
        },
        user: {
          fields: { id: ULID, posts: { type: "toMany", target: "post" } },
        },
      },
    },
  },
  {
    id: "model.mdx#6",
    coded: () => ({
      membership: s
        .model({
          orgId: s.string(),
          userId: s.string(),
          role: s.string(),
        })
        .id(["orgId", "userId"], { name: "membership_pk" }),
    }),
    document: {
      version: 1,
      models: {
        membership: {
          fields: { orgId: STRING, userId: STRING, role: STRING },
          ids: [{ fields: ["orgId", "userId"], name: "membership_pk" }],
        },
      },
    },
  },
  {
    id: "model.mdx#7",
    coded: () => ({
      user: s
        .model({
          id: s.string().id(),
          email: s.string(),
          orgId: s.string(),
        })
        .unique(["email", "orgId"], { name: "user_email_org_unique" }),
    }),
    document: {
      version: 1,
      models: {
        user: {
          fields: { id: ID, email: STRING, orgId: STRING },
          uniques: [
            { fields: ["email", "orgId"], name: "user_email_org_unique" },
          ],
        },
      },
    },
  },
  {
    id: "relations/index.mdx#1",
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        email: s.string().unique(),
        profile: s.toOne(() => profile),
        posts: s.toMany(() => post),
      });
      const profile = s.model({
        id: s.string().id().ulid(),
        bio: s.string(),
        userId: s.string().unique(),
        user: s
          .toOne(() => user)
          .fields("userId")
          .references("id"),
      });
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
        tags: s.toMany(() => tag),
      });
      const tag = s.model({
        id: s.string().id().ulid(),
        name: s.string().unique(),
        posts: s.toMany(() => post),
      });
      return { user, profile, post, tag };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            email: { type: "string", unique: true },
            profile: { type: "toOne", target: "profile" },
            posts: { type: "toMany", target: "post" },
          },
        },
        profile: {
          fields: {
            id: ULID,
            bio: STRING,
            userId: { type: "string", unique: true },
            user: {
              type: "toOne",
              target: "user",
              fields: ["userId"],
              references: ["id"],
            },
          },
        },
        post: {
          fields: {
            id: ULID,
            title: STRING,
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
            tags: { type: "toMany", target: "tag" },
          },
        },
        tag: {
          fields: {
            id: ULID,
            name: { type: "string", unique: true },
            posts: { type: "toMany", target: "post" },
          },
        },
      },
    },
  },
  {
    id: "relations/index.mdx#3",
    completed: ["user"],
    coded: () => {
      const post = s.model({
        id: s.string().id(),
        authorId: s.string().nullable(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      });
      const user = s.model({
        id: s.string().id(),
        posts: s.toMany(() => post),
      });
      return { post, user };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ID,
            authorId: { type: "string", nullable: true },
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
        },
        user: {
          fields: { id: ID, posts: { type: "toMany", target: "post" } },
        },
      },
    },
  },
  {
    id: "relations/index.mdx#6",
    completed: ["post"],
    coded: () => {
      const user = s.model({
        id: s.string().id(),
        authored: s.toMany(() => post).name("authored"),
        reviewed: s.toMany(() => post).name("reviewed"),
      });
      const post = s.model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .name("authored")
          .fields("authorId")
          .references("id"),
        reviewerId: s.string().nullable(),
        reviewer: s
          .toOne(() => user)
          .name("reviewed")
          .fields("reviewerId")
          .references("id"),
      });
      return { user, post };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ID,
            authored: { type: "toMany", name: "authored", target: "post" },
            reviewed: { type: "toMany", name: "reviewed", target: "post" },
          },
        },
        post: {
          fields: {
            id: ID,
            authorId: STRING,
            author: {
              type: "toOne",
              name: "authored",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
            reviewerId: { type: "string", nullable: true },
            reviewer: {
              type: "toOne",
              name: "reviewed",
              target: "user",
              fields: ["reviewerId"],
              references: ["id"],
            },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-many.mdx#0",
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        tags: s.toMany(() => tag),
      });
      const tag = s.model({
        id: s.string().id().ulid(),
        name: s.string().unique(),
        posts: s.toMany(() => post),
      });
      return { post, tag };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            tags: { type: "toMany", target: "tag" },
          },
        },
        tag: {
          fields: {
            id: ULID,
            name: { type: "string", unique: true },
            posts: { type: "toMany", target: "post" },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-many.mdx#2",
    completed: ["tag"],
    coded: () => {
      const post = s
        .model({
          tenantId: s.string(),
          localId: s.string(),
          tags: s
            .toMany(() => tag)
            .through("post_tags")
            .source("post")
            .target("tagId"),
        })
        .id(["tenantId", "localId"]);
      const tag = s.model({
        id: s.string().id(),
        posts: s.toMany(() => post),
      });
      return { post, tag };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            tenantId: STRING,
            localId: STRING,
            tags: {
              type: "toMany",
              target: "tag",
              junction: {
                table: "post_tags",
                source: "post",
                target: "tagId",
              },
            },
          },
          ids: [{ fields: ["tenantId", "localId"] }],
        },
        tag: {
          fields: { id: ID, posts: { type: "toMany", target: "post" } },
        },
      },
    },
  },
  {
    id: "relations/many-to-many.mdx#4",
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        tags: s
          .toMany(() => tag)
          .through("post_tags")
          .source("post_id")
          .target("tag_id"),
      });
      const tag = s.model({
        id: s.string().id().ulid(),
        name: s.string().unique(),
        posts: s.toMany(() => post),
      });
      return { post, tag };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            tags: {
              type: "toMany",
              target: "tag",
              junction: {
                table: "post_tags",
                source: "post_id",
                target: "tag_id",
              },
            },
          },
        },
        tag: {
          fields: {
            id: ULID,
            name: { type: "string", unique: true },
            posts: { type: "toMany", target: "post" },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-many.mdx#6",
    coded: () => {
      const enrollment = s
        .model({
          id: s.string().id().ulid(),
          studentId: s.string(),
          courseId: s.string(),
          enrolledAt: s.dateTime().now(),
          grade: s.string().nullable(),
          student: s
            .toOne(() => student)
            .fields("studentId")
            .references("id"),
          course: s
            .toOne(() => course)
            .fields("courseId")
            .references("id"),
        })
        .map("enrollments")
        .unique(["studentId", "courseId"]);
      const student = s.model({
        id: s.string().id().ulid(),
        name: s.string(),
        enrollments: s.toMany(() => enrollment),
      });
      const course = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        enrollments: s.toMany(() => enrollment),
      });
      return { enrollment, student, course };
    },
    document: {
      version: 1,
      models: {
        enrollment: {
          fields: {
            id: ULID,
            studentId: STRING,
            courseId: STRING,
            enrolledAt: { type: "datetime", generate: { kind: "now" } },
            grade: { type: "string", nullable: true },
            student: {
              type: "toOne",
              target: "student",
              fields: ["studentId"],
              references: ["id"],
            },
            course: {
              type: "toOne",
              target: "course",
              fields: ["courseId"],
              references: ["id"],
            },
          },
          table: "enrollments",
          uniques: [{ fields: ["studentId", "courseId"] }],
        },
        student: {
          fields: {
            id: ULID,
            name: STRING,
            enrollments: { type: "toMany", target: "enrollment" },
          },
        },
        course: {
          fields: {
            id: ULID,
            title: STRING,
            enrollments: { type: "toMany", target: "enrollment" },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-many.mdx#7",
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        name: s.string(),
        following: s.toMany(() => user),
        followers: s.toMany(() => user),
      });
      return { user };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            name: STRING,
            following: { type: "toMany", target: "user" },
            followers: { type: "toMany", target: "user" },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-many.mdx#8",
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        name: s.string(),
        following: s
          .toMany(() => user)
          .through("user_follows")
          .source("follower_id")
          .target("following_id"),
        followers: s.toMany(() => user),
      });
      return { user };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            name: STRING,
            following: {
              type: "toMany",
              target: "user",
              junction: {
                table: "user_follows",
                source: "follower_id",
                target: "following_id",
              },
            },
            followers: { type: "toMany", target: "user" },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-one.mdx#0",
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      });
      const user = s.model({
        id: s.string().id().ulid(),
        email: s.string().unique(),
        posts: s.toMany(() => post),
      });
      return { post, user };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
        },
        user: {
          fields: {
            id: ULID,
            email: { type: "string", unique: true },
            posts: { type: "toMany", target: "post" },
          },
        },
      },
    },
  },
  {
    id: "relations/many-to-one.mdx#3",
    completed: ["user"],
    coded: () => {
      const post = s
        .model({
          id: s.string().id().ulid(),
          title: s.string(),
          createdAt: s.dateTime().now(),
          authorId: s.string(),
          author: s
            .toOne(() => user)
            .fields("authorId")
            .references("id"),
        })
        .index(["authorId", "createdAt"]);
      const user = s.model({
        id: s.string().id().ulid(),
        posts: s.toMany(() => post),
      });
      return { post, user };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            createdAt: { type: "datetime", generate: { kind: "now" } },
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
          indexes: [{ fields: ["authorId", "createdAt"] }],
        },
        user: {
          fields: { id: ULID, posts: { type: "toMany", target: "post" } },
        },
      },
    },
  },
  {
    id: "relations/many-to-one.mdx#5",
    completed: ["user", "category"],
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        content: s.string(),
        published: s.boolean().default(false),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id")
          .onDelete("cascade"),
        categoryId: s.string().nullable(),
        category: s
          .toOne(() => category)
          .fields("categoryId")
          .references("id")
          .onDelete("setNull"),
      });
      const user = s.model({
        id: s.string().id().ulid(),
        posts: s.toMany(() => post),
      });
      const category = s.model({
        id: s.string().id().ulid(),
        posts: s.toMany(() => post),
      });
      return { post, user, category };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            content: STRING,
            published: { type: "boolean", default: false },
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
              onDelete: "cascade",
            },
            categoryId: { type: "string", nullable: true },
            category: {
              type: "toOne",
              target: "category",
              fields: ["categoryId"],
              references: ["id"],
              onDelete: "setNull",
            },
          },
        },
        user: {
          fields: { id: ULID, posts: { type: "toMany", target: "post" } },
        },
        category: {
          fields: { id: ULID, posts: { type: "toMany", target: "post" } },
        },
      },
    },
  },
  {
    id: "relations/many-to-one.mdx#7",
    coded: () => {
      const employee = s.model({
        id: s.string().id().ulid(),
        name: s.string(),
        managerId: s.string().nullable(),
        manager: s
          .toOne(() => employee)
          .fields("managerId")
          .references("id"),
        reports: s.toMany(() => employee),
      });
      const comment = s.model({
        id: s.string().id().ulid(),
        content: s.string(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => comment)
          .fields("parentId")
          .references("id"),
        replies: s.toMany(() => comment),
      });
      return { employee, comment };
    },
    document: {
      version: 1,
      models: {
        employee: {
          fields: {
            id: ULID,
            name: STRING,
            managerId: { type: "string", nullable: true },
            manager: {
              type: "toOne",
              target: "employee",
              fields: ["managerId"],
              references: ["id"],
            },
            reports: { type: "toMany", target: "employee" },
          },
        },
        comment: {
          fields: {
            id: ULID,
            content: STRING,
            parentId: { type: "string", nullable: true },
            parent: {
              type: "toOne",
              target: "comment",
              fields: ["parentId"],
              references: ["id"],
            },
            replies: { type: "toMany", target: "comment" },
          },
        },
      },
    },
  },
  {
    id: "relations/one-to-many.mdx#0",
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        email: s.string().unique(),
        posts: s.toMany(() => post),
      });
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      });
      return { user, post };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            email: { type: "string", unique: true },
            posts: { type: "toMany", target: "post" },
          },
        },
        post: {
          fields: {
            id: ULID,
            title: STRING,
            authorId: STRING,
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
        },
      },
    },
  },
  {
    id: "relations/one-to-many.mdx#3",
    coded: () => {
      const category = s.model({
        id: s.string().id().ulid(),
        name: s.string().unique(),
        posts: s.toMany(() => post),
      });
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        categoryId: s.string(),
        category: s
          .toOne(() => category)
          .fields("categoryId")
          .references("id"),
      });
      return { category, post };
    },
    document: {
      version: 1,
      models: {
        category: {
          fields: {
            id: ULID,
            name: { type: "string", unique: true },
            posts: { type: "toMany", target: "post" },
          },
        },
        post: {
          fields: {
            id: ULID,
            title: STRING,
            categoryId: STRING,
            category: {
              type: "toOne",
              target: "category",
              fields: ["categoryId"],
              references: ["id"],
            },
          },
        },
      },
    },
  },
  {
    id: "relations/one-to-one.mdx#0",
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        email: s.string().unique(),
        profile: s.toOne(() => profile),
      });
      const profile = s.model({
        id: s.string().id().ulid(),
        bio: s.string(),
        userId: s.string(),
        user: s
          .toOne(() => user)
          .fields("userId")
          .references("id"),
      });
      return { user, profile };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            email: { type: "string", unique: true },
            profile: { type: "toOne", target: "profile" },
          },
        },
        profile: {
          fields: {
            id: ULID,
            bio: STRING,
            userId: STRING,
            user: {
              type: "toOne",
              target: "user",
              fields: ["userId"],
              references: ["id"],
            },
          },
        },
      },
    },
  },
  {
    id: "relations/one-to-one.mdx#2",
    coded: () => {
      const user = s.model({
        id: s.string().id().ulid(),
        email: s.string().unique(),
        profile: s.toOne(() => profile),
      });
      const profile = s.model({
        id: s.string().id().ulid(),
        bio: s.string().nullable(),
        avatar: s.string().nullable(),
        userId: s.string(),
        user: s
          .toOne(() => user)
          .fields("userId")
          .references("id")
          .onDelete("cascade"),
      });
      return { user, profile };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            email: { type: "string", unique: true },
            profile: { type: "toOne", target: "profile" },
          },
        },
        profile: {
          fields: {
            id: ULID,
            bio: { type: "string", nullable: true },
            avatar: { type: "string", nullable: true },
            userId: STRING,
            user: {
              type: "toOne",
              target: "user",
              fields: ["userId"],
              references: ["id"],
              onDelete: "cascade",
            },
          },
        },
      },
    },
  },
  {
    id: "relations/polymorphic.mdx#0",
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        comments: s.toMany(() => comment).name("commentable"),
      });
      const video = s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        duration: s.int(),
        comments: s.toMany(() => comment).name("commentable"),
      });
      const comment = s.model({
        id: s.string().id().ulid(),
        body: s.string(),
        commentable: s
          .toOne({ post: () => post, video: () => video })
          .name("commentable")
          .optional(),
      });
      return { post, video, comment };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            comments: {
              type: "toMany",
              name: "commentable",
              target: "comment",
            },
          },
        },
        video: {
          fields: {
            id: ULID,
            title: STRING,
            duration: { type: "int" },
            comments: {
              type: "toMany",
              name: "commentable",
              target: "comment",
            },
          },
        },
        comment: {
          fields: {
            id: ULID,
            body: STRING,
            commentable: {
              type: "toOne",
              name: "commentable",
              variants: { post: "post", video: "video" },
              optional: true,
            },
          },
        },
      },
    },
  },
  {
    id: "relations/polymorphic.mdx#1",
    completed: ["book", "video"],
    coded: () => {
      const shelf = s.model({
        id: s.string().id(),
        items: s.toMany({ book: () => book, video: () => video }),
      });
      const book = s.model({ id: s.string().id() });
      const video = s.model({ id: s.string().id() });
      return { shelf, book, video };
    },
    document: {
      version: 1,
      models: {
        shelf: {
          fields: {
            id: ID,
            items: {
              type: "toMany",
              variants: { book: "book", video: "video" },
            },
          },
        },
        book: { fields: { id: ID } },
        video: { fields: { id: ID } },
      },
    },
  },
  {
    id: "relations/polymorphic.mdx#5",
    completed: ["comment", "video"],
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        comments: s.toMany(() => comment).name("commentable"),
      });
      const video = s.model({ id: s.string().id().ulid() });
      const comment = s.model({
        id: s.string().id().ulid(),
        commentable: s
          .toOne({ post: () => post, video: () => video })
          .name("commentable")
          .optional(),
      });
      return { post, video, comment };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            comments: {
              type: "toMany",
              name: "commentable",
              target: "comment",
            },
          },
        },
        video: { fields: { id: ULID } },
        comment: {
          fields: {
            id: ULID,
            commentable: {
              type: "toOne",
              name: "commentable",
              variants: { post: "post", video: "video" },
              optional: true,
            },
          },
        },
      },
    },
  },
  {
    id: "relations/polymorphic.mdx#6",
    completed: ["comment", "video"],
    coded: () => {
      const post = s.model({
        id: s.string().id().ulid(),
        featuredComment: s.toOne(() => comment).name("commentable"),
      });
      const video = s.model({ id: s.string().id().ulid() });
      const comment = s.model({
        id: s.string().id().ulid(),
        commentable: s
          .toOne({ post: () => post, video: () => video })
          .name("commentable")
          .optional(),
      });
      return { post, video, comment };
    },
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            featuredComment: {
              type: "toOne",
              name: "commentable",
              target: "comment",
            },
          },
        },
        video: { fields: { id: ULID } },
        comment: {
          fields: {
            id: ULID,
            commentable: {
              type: "toOne",
              name: "commentable",
              variants: { post: "post", video: "video" },
              optional: true,
            },
          },
        },
      },
    },
  },
  {
    id: "relations/polymorphic.mdx#7",
    completed: ["shelf", "video"],
    coded: () => {
      const book = s.model({
        id: s.string().id(),
        title: s.string(),
        shelf: s.toOne(() => shelf).name("items"),
      });
      const video = s.model({ id: s.string().id() });
      const shelf = s.model({
        id: s.string().id(),
        items: s.toMany({ book: () => book, video: () => video }).name("items"),
      });
      return { book, video, shelf };
    },
    document: {
      version: 1,
      models: {
        book: {
          fields: {
            id: ID,
            title: STRING,
            shelf: { type: "toOne", name: "items", target: "shelf" },
          },
        },
        video: { fields: { id: ID } },
        shelf: {
          fields: {
            id: ID,
            items: {
              type: "toMany",
              name: "items",
              variants: { book: "book", video: "video" },
            },
          },
        },
      },
    },
  },
  {
    id: "relations/polymorphic.mdx#8",
    completed: ["shelf", "book"],
    coded: () => {
      const video = s.model({
        id: s.string().id(),
        title: s.string(),
        shelves: s.toMany(() => shelf).name("items"),
      });
      const book = s.model({ id: s.string().id() });
      const shelf = s.model({
        id: s.string().id(),
        items: s.toMany({ book: () => book, video: () => video }).name("items"),
      });
      return { video, book, shelf };
    },
    document: {
      version: 1,
      models: {
        video: {
          fields: {
            id: ID,
            title: STRING,
            shelves: { type: "toMany", name: "items", target: "shelf" },
          },
        },
        book: { fields: { id: ID } },
        shelf: {
          fields: {
            id: ID,
            items: {
              type: "toMany",
              name: "items",
              variants: { book: "book", video: "video" },
            },
          },
        },
      },
    },
  },
  {
    id: "scalars/boolean.mdx#2",
    coded: () => ({
      user: s.model({
        id: s.string().id().ulid(),
        deleted: s.boolean().default(false),
        deletedAt: s.dateTime().nullable(),
      }),
    }),
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            deleted: { type: "boolean", default: false },
            deletedAt: { type: "datetime", nullable: true },
          },
        },
      },
    },
  },
  {
    id: "scalars/boolean.mdx#3",
    coded: () => ({
      userSettings: s.model({
        userId: s.string().id(),
        emailNotifications: s.boolean().default(true),
        pushNotifications: s.boolean().default(false),
        marketingEmails: s.boolean().default(false),
      }),
    }),
    document: {
      version: 1,
      models: {
        userSettings: {
          fields: {
            userId: ID,
            emailNotifications: { type: "boolean", default: true },
            pushNotifications: { type: "boolean", default: false },
            marketingEmails: { type: "boolean", default: false },
          },
        },
      },
    },
  },
  {
    id: "scalars/boolean.mdx#4",
    coded: () => ({
      post: s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        published: s.boolean().default(false),
        featured: s.boolean().default(false),
        archived: s.boolean().default(false),
      }),
    }),
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            published: { type: "boolean", default: false },
            featured: { type: "boolean", default: false },
            archived: { type: "boolean", default: false },
          },
        },
      },
    },
  },
  {
    id: "scalars/datetime.mdx#5",
    coded: () => {
      const timestamps = {
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
      };
      return {
        user: s.model({
          id: s.string().id().ulid(),
          email: s.string(),
          ...timestamps,
        }),
        post: s.model({
          id: s.string().id().ulid(),
          title: s.string(),
          ...timestamps,
        }),
      };
    },
    document: {
      version: 1,
      models: {
        user: {
          fields: {
            id: ULID,
            email: STRING,
            createdAt: { type: "datetime", generate: { kind: "now" } },
            updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
          },
        },
        post: {
          fields: {
            id: ULID,
            title: STRING,
            createdAt: { type: "datetime", generate: { kind: "now" } },
            updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
          },
        },
      },
    },
  },
  {
    id: "scalars/datetime.mdx#6",
    coded: () => ({
      post: s.model({
        id: s.string().id().ulid(),
        title: s.string(),
        publishAt: s.dateTime().nullable(),
        publishedAt: s.dateTime().nullable(),
      }),
    }),
    document: {
      version: 1,
      models: {
        post: {
          fields: {
            id: ULID,
            title: STRING,
            publishAt: { type: "datetime", nullable: true },
            publishedAt: { type: "datetime", nullable: true },
          },
        },
      },
    },
  },
  {
    id: "scalars/enum.mdx#1",
    coded: () => {
      const Status = s.enum(["PENDING", "ACTIVE", "INACTIVE"]).name("status");
      return {
        user: s.model({
          id: s.string().id(),
          status: Status.default("PENDING"),
        }),
        order: s.model({
          id: s.string().id(),
          status: Status.default("PENDING"),
        }),
      };
    },
    document: {
      version: 1,
      enums: {
        status: { values: ["PENDING", "ACTIVE", "INACTIVE"], name: "status" },
      },
      models: {
        user: {
          fields: {
            id: ID,
            status: { type: "enum", enum: "status", default: "PENDING" },
          },
        },
        order: {
          fields: {
            id: ID,
            status: { type: "enum", enum: "status", default: "PENDING" },
          },
        },
      },
    },
  },
  {
    id: "scalars/point.mdx#0",
    coded: () => ({
      place: s.model({
        id: s.string().id(),
        name: s.string(),
        location: s.point(),
        entrance: s.point().nullable(),
      }),
    }),
    document: {
      version: 1,
      models: {
        place: {
          fields: {
            id: ID,
            name: STRING,
            location: { type: "point" },
            entrance: { type: "point", nullable: true },
          },
        },
      },
    },
  },
  {
    id: "scalars/vector.mdx#2",
    coded: () => ({
      document: s
        .model({
          id: s.string().id().ulid(),
          content: s.string(),
          embedding: s.vector().dimension(1536),
          createdAt: s.dateTime().now(),
        })
        .map("documents"),
    }),
    document: {
      version: 1,
      models: {
        document: {
          fields: {
            id: ULID,
            content: STRING,
            embedding: { type: "vector", dimension: 1536 },
            createdAt: { type: "datetime", generate: { kind: "now" } },
          },
          table: "documents",
        },
      },
    },
  },
];
