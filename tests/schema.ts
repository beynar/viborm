import z from "zod/v4";
import {
  AnyRelation,
  GetRelationFields,
  InferStringInput,
  RelationGetter,
  s,
} from "../src/schema/index.js";
import { createClient } from "../src/index.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { FindFirstArgs } from "../src/schema/types.js";
import { InferInput } from "valibot";

export const string = s.string();
export const nullableString = s.string().nullable();
export const stringWithDefault = s.string().default("default");
export const stringWithValidation = s.string().schema(z.email());

export const number = s.int();
export const nullableNumber = s.int().nullable();
export const numberWithDefault = s.int().default(1);
export const numberWithValidation = s.int().schema(z.number().min(1));

export const boolean = s.boolean();
export const nullableBoolean = s.boolean().nullable();
export const booleanWithDefault = s.boolean().default(true);
export const booleanWithValidation = s.boolean();

export const bigint = s.bigInt();
export const nullableBigint = s.bigInt().nullable();
export const bigintWithDefault = s.bigInt().default(BigInt(1));
export const bigintWithValidation = s
  .bigInt()
  .schema(z.bigint().min(BigInt(1)));

export const dateTime = s.dateTime();
export const nullableDateTime = s.dateTime().nullable();
export const dateTimeWithDefault = s.dateTime().default(new Date());
export const dateTimeWithValidation = s.dateTime().schema(z.date());

export const simpleJson = z.object({
  name: z.string(),
  age: z.number(),
});
export const json = s.json().schema(simpleJson);
export const nullableJson = s.json().schema(simpleJson).nullable();
export const jsonWithDefault = s
  .json()
  .schema(simpleJson)
  .default({ name: "John", age: 30 });

export const blob = s.blob();
export const nullableBlob = s.blob().nullable();
export const blobWithDefault = s.blob().default(new Uint8Array([1, 2, 3]));
export const blobWithValidation = s.blob();

export const enumField = s.enum(["a", "b"]);
export const nullableEnumField = s.enum(["a", "b"]).nullable();
export const enumFieldWithDefault = s.enum(["a", "b"]).default("a");
export const enumFieldWithValidation = s
  .enum(["a", "b"])
  .schema(z.enum(["a", "b"]));

export const model = s.model({
  id: s.string().id().ulid(),
  string,
  stringWithDefault,
  stringWithValidation,
  nullableString,
  number,
  numberWithDefault,
  numberWithValidation,
  nullableNumber,
  boolean,
  booleanWithDefault,
  booleanWithValidation,
  nullableBoolean,
  bigint,
  bigintWithDefault,
  bigintWithValidation,
  nullableBigint,
  dateTime,
  dateTimeWithDefault,
  dateTimeWithValidation,
  nullableDateTime,
  json,
  jsonWithDefault,
  nullableJson,
  blob,
  blobWithDefault,
  blobWithValidation,
  nullableBlob,
  enumField,
  enumFieldWithDefault,
  enumFieldWithValidation,
  nullableEnumField,
  oneToOne: s.oneToOne(() => oneToOne),
  oneToMany: s.oneToMany(() => oneToMany),
  manyToMany: s.manyToMany(() => manyToMany),
  manyToOne: s.manyToOne(() => manyToOne),
});

export const oneToOne = s.model({
  id: s.string().id().ulid(),
  test: s.oneToOne(() => oneToOne),
});

export const oneToMany = s.model({
  id: s.string().id().ulid(),
  test: s.manyToOne(() => oneToOne),
});

export const manyToMany = s.model({
  id: s.string().id().ulid(),
  test: s.manyToMany(() => oneToOne),
});

export const manyToOne = s.model({
  id: s.string().id().ulid(),
  test: s.oneToMany(() => oneToOne),
});

// ===== TEST MODELS FOR CLIENT TESTS =====

const example = s.model({
  id: s.string().id().ulid(),
  relation: s.oneToMany(() => relation),
});

const relation = s.model({
  id: s.string().id().ulid(),
  example: s.oneToOne(() => example),
});
/**
 * Test user model for client type tests
 */
export const testUser = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  bio: s.string().nullable(),
  tags: s.string().array(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
  posts: s.oneToMany(() => testPost),
  profile: s.oneToOne(() => testProfile),
});

/**
 * Test post model for client type tests
 */
export const testPost = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
  authorId: s.string(),
  author: s.oneToOne(() => testUser),
  // metadata: s
  //   .json(
  //     z.object({
  //       tags: z.array(z.string()),
  //     })
  //   )
  //   .nullable(),
});

/**
 * Test profile model for client type tests
 */
export const testProfile = s
  .model({
    id: s.string().id().ulid(),
    bio: s.string().nullable(),
    avatar: s.string().nullable(),
    userId: s.string().unique(),
    user: s.oneToOne(() => testUser),
  })
  .map("Profile")
  .index(["avatar", "bio"], { name: "idx_profile_eaeaz", type: "gin" })
  .id(["avatar", "bio"])
  .unique(["avatar", "bio"], { name: "ezl" });

export const schema = {
  user: testUser,
  post: testPost,
  profile: testProfile,
  model,
};

const client = createClient({
  schema,
  adapter: {} as any,
  driver: {} as any,
});
const res = await client.user.findFirst({
  select: {
    id: true,
    posts: {
      where: {
        id: "elkzezl",
      },
    },
  },
  where: {
    profile: {
      user: {
        posts: {
          some: {
            author: {
              age: 12,
            },
          },
        },
      },
    },
  },
});

// Test WhereUnique with different identifier types
// NOTE: These are for type-checking only, commented out to prevent execution at import time

// 1. Single-field ID
// client.profile.findUnique({
//   where: {
//     id: "test-id",
//   },
// });

// 2. Single-field unique
// client.profile.findUnique({
//   where: {
//     userId: "user-123",
//   },
// });

// 3. Compound ID (auto-generated name from fields: avatar_bio)
// NOTE: Commented out to prevent execution at import time
// client.profile.findFirst({
//   where: {
//     user: {},
//   },
// });

type FindFirst = FindFirstArgs<typeof schema.profile>["where"];
type R = (typeof schema.profile)["~"]["fields"]["user"];
type T = R extends AnyRelation ? true : false;
type T2 = RelationGetter<R>;
type TEst = GetRelationFields<R>;

// 4. Compound unique with custom name
// NOTE: These await calls are commented out to prevent execution at import time
// const res2 = await client.profile.findUnique({
//   where: {
//     ezl: { avatar: "avatar.jpg", bio: "My bio" },
//     id: "ezk",
//   },
//   select: {},
// });

// const res = await client.model.findFirst({
//   where: {
//     id: "lkz",
//   },
//   select: {
//     string: true,
//     manyToOne: {
//       include: {
//         test: {
//           select: {
//             string: true,
//             id: true,
//           },
//         },
//       },
//     },
//   },
// });

const prisma = new PrismaClient();

prisma.example.findFirst({
  where: {
    string: {
      equals: "kejzelkz",
    },
  },
  select: {
    string: true,
    oneToOne: {
      select: {
        id: true,
      },
    },
  },
});

// NOTE: ArkType example for circular types - commented out to prevent execution at import time
// const userType = type({
//   id: type("string"),
//   posts: () => postType,
// });

// const postType = type({
//   id: type("string"),
//   author: () => userType,
// });
