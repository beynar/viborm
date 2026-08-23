import { s } from "@schema";
import type { ModelOperationInput, Prettify } from "@validation";
import z from "zod/v4";
import { createClient } from "@src/index.js";

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
export const dateTimeWithValidation = s.dateTime();

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

export const enumScalar = s.enum(["a", "b"]);
export const nullableEnumScalar = s.enum(["a", "b"]).nullable();
export const enumScalarWithDefault = s.enum(["a", "b"]).default("a");
export const enumScalarWithValidation = s.enum(["a", "b"]);

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
  enumScalar,
  enumScalarWithDefault,
  enumScalarWithValidation,
  nullableEnumScalar,
  // One field per pair shape, named for the PAIR: this slot's cardinality and
  // the partner slot's. Each target model carries the mirror slot.
  singularToSingular: s.toOne(() => singularToSingular),
  singularToPlural: s.toMany(() => singularToPlural),
  pluralToPlural: s.toMany(() => pluralToPlural),
  pluralToSingular: s.toOne(() => pluralToSingular),
});

export const singularToSingular = s.model({
  id: s.string().id().ulid(),
  test: s.toOne(() => singularToSingular),
});

export const singularToPlural = s.model({
  id: s.string().id().ulid(),
  test: s.toOne(() => singularToSingular),
});

export const pluralToPlural = s.model({
  id: s.string().id().ulid(),
  test: s.toMany(() => singularToSingular),
});

export const pluralToSingular = s.model({
  id: s.string().id().ulid(),
  test: s.toMany(() => singularToSingular),
});

// ===== TEST MODELS FOR CLIENT TESTS =====

const example = s.model({
  id: s.string().id().ulid(),
  relation: s.toMany(() => relation),
});

const relation = s.model({
  id: s.string().id().ulid(),
  example: s.toOne(() => example),
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
  posts: s.toMany(() => testPost),
  profile: s.toOne(() => testProfile),
});

/**
 * Test post model for client type tests
 */
export const testPost = s
  .model({
    id: s.string().id().ulid(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().now(),
    authorId: s.string(),
    author: s
      .toOne(() => testUser)
      .name("author"),
    // metadata: s
    //   .json(
    //     z.object({
    //       tags: z.array(z.string()),
    //     })
    //   )
    //   .nullable(),
  })
  .omit({
    title: true,
    content: true,
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
    user: s
      .toOne(() => testUser)
      .name("user"),
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
  driver: {} as any,
});

const res1 = client.user.groupBy({
  by: ["age"],
  where: {},
});

type Input = Prettify<ModelOperationInput<typeof testUser, "findFirst">>;

const res = await (
  client as unknown as {
    $withCache(options: { ttl: number }): typeof client;
  }
)
  .$withCache({ ttl: 1000 })
  .user.findFirst({
    where: {
      AND: [
        {
          age: 12,
          posts: {
            none: {
              authorId: {
                startsWith: "123",
              },
            },
          },
          createdAt: new Date("2025-01-01"),
          email: {
            equals: "ezk",
          },
        },
        {
          bio: "ezlk",
        },
      ],
    },
    include: {
      posts: true,
      profile: {
        include: {
          user: {
            include: {
              posts: true,
            },
          },
        },
      },
    },
    // select: {
    //   age: true,
    //   posts: {
    //     select: {
    //       authorId: true,
    //     },
    //     where: {
    //       AND: [
    //         {
    //           author: {
    //             is: {
    //               age: {
    //                 gt: 120,
    //               },
    //             },
    //           },
    //         },
    //       ],
    //     },
    //   },
    // },
  });
