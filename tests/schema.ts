import z from "zod/v4";
import { s } from "../src/schema/index.js";

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

export const model = s.model("test", {
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
  oneToOne: s.relation().oneToOne(() => oneToOne),
  oneToMany: s.relation().oneToMany(() => oneToMany),
  manyToMany: s.relation().manyToMany(() => manyToMany),
  manyToOne: s.relation().manyToOne(() => manyToOne),
});

export const oneToOne = s.model("oneToOne", {
  id: s.string().id().ulid(),
  test: s.relation().oneToOne(() => oneToOne),
});

export const oneToMany = s.model("oneToMany", {
  id: s.string().id().ulid(),
  test: s.relation().manyToOne(() => oneToOne),
});

export const manyToMany = s.model("manyToMany", {
  id: s.string().id().ulid(),
  test: s.relation().manyToMany(() => oneToOne),
});

export const manyToOne = s.model("manyToOne", {
  id: s.string().id().ulid(),
  test: s.relation({}).oneToMany(() => oneToOne),
});

// ===== TEST MODELS FOR CLIENT TESTS =====

/**
 * Test user model for client type tests
 */
export const testUser = s.model("User", {
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  bio: s.string().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
  posts: s.relation().oneToMany(() => testPost),
  profile: s.relation().oneToOne(() => testProfile),
});

/**
 * Test post model for client type tests
 */
export const testPost = s.model("Post", {
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
  authorId: s.string(),
  author: s.relation().manyToOne(() => testUser),
  metadata: s.json(
    z.object({
      tags: z.array(z.string()),
    })
  ),
});

/**
 * Test profile model for client type tests
 */
export const testProfile = s.model("Profile", {
  id: s.string().id().ulid(),
  bio: s.string().nullable(),
  avatar: s.string().nullable(),
  userId: s.string().unique(),
  user: s.relation().oneToOne(() => testUser),
});

export const schema = {
  user: testUser,
  post: testPost,
  profile: testProfile,
};
