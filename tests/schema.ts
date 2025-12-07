import z from "zod/v4";
import { s } from "../src/schema/index.js";
import { createClient } from "../src/index.js";
import { PrismaClient } from "../generated/prisma/client.js";

export const string = s.string();
export const nullableString = s.string().nullable();
export const stringWithDefault = s.string().default("default");
export const stringWithValidation = s.string().validator(z.email());

export const number = s.int();
export const nullableNumber = s.int().nullable();
export const numberWithDefault = s.int().default(1);
export const numberWithValidation = s.int().validator(z.number().min(1));

export const boolean = s.boolean();
export const nullableBoolean = s.boolean().nullable();
export const booleanWithDefault = s.boolean().default(true);
export const booleanWithValidation = s.boolean().validator(z.boolean());

export const bigint = s.bigInt();
export const nullableBigint = s.bigInt().nullable();
export const bigintWithDefault = s.bigInt().default(BigInt(1));
export const bigintWithValidation = s
  .bigInt()
  .validator(z.bigint().min(BigInt(1)));

export const dateTime = s.dateTime();
export const nullableDateTime = s.dateTime().nullable();
export const dateTimeWithDefault = s.dateTime().default(new Date());
export const dateTimeWithValidation = s.dateTime().validator(z.date());

export const simpleJson = z.object({
  name: z.string(),
  age: z.number(),
});
export const json = s.json(simpleJson);
export const nullableJson = s.json(simpleJson).nullable();
export const jsonWithDefault = s
  .json(simpleJson)
  .default({ name: "John", age: 30 });

export const blob = s.blob();
export const nullableBlob = s.blob().nullable();
export const blobWithDefault = s.blob().default(new Uint8Array([1, 2, 3]));
export const blobWithValidation = s.blob().validator(z.instanceof(Uint8Array));

export const enumField = s.enum(["a", "b"]);
export const nullableEnumField = s.enum(["a", "b"]).nullable();
export const enumFieldWithDefault = s.enum(["a", "b"]).default("a");
export const enumFieldWithValidation = s
  .enum(["a", "b"])
  .validator(z.enum(["a", "b"]));

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
  profile: s.oneToOne(() => testProfile).optional(),
  friends: s
    .manyToMany(() => testUser)
    .through("firends")
    .A("user")
    .B("friend"),
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
  author: s
    .manyToOne(() => testUser)
    .fields("authorId")
    .references("id"),
  metadata: s
    .json(
      z.object({
        tags: z.array(z.string()),
      })
    )
    .nullable(),
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
});

// Test WhereUnique with different identifier types

// 1. Single-field ID
client.profile.findUnique({
  where: {
    id: "test-id",
  },
});

// 2. Single-field unique
client.profile.findUnique({
  where: {
    userId: "user-123",
  },
});

// 3. Compound ID (auto-generated name from fields: avatar_bio)
client.profile.findUnique({
  where: {
    avatar_bio: { avatar: "avatar.jpg", bio: "My bio" },
  },
});

// 4. Compound unique with custom name
const res2 = await client.profile.findUnique({
  where: {
    ezl: { avatar: "avatar.jpg", bio: "My bio" },
    id: "ezk",
  },
  select: {
    bio: true,
  },
});

const res = await client.model.findFirst({
  where: {
    id: "lkz",
  },
  select: {
    string: true,
    manyToOne: {
      include: {
        test: {
          select: {
            string: true,
            id: true,
          },
        },
      },
    },
  },
});

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
