import { MemoryCache } from "@cache/drivers/memory";
import { createClient } from "@drivers/pglite";
import { s } from "@schema";
import type { Prettify } from "@validation/types";
import z from "zod/v4";

const statusENUM = s
  .enum(["active", "inactive", "deleted"])
  .name("STATUS")
  .nullable();

const user = s.model({
  id: s.string().id(),
  name: s.string().nullable(),
  email: s.string(),
  status: statusENUM,
  pets: s.json().schema(
    z.array(
      z.object({
        name: z.string(),
        age: z.number(),
        type: z.enum(["dog", "cat", "bird"]),
      })
    )
  ),
  posts: s.toMany(() => post),
  friends: s.toMany(() => user),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  media: s.toOne({
    image: () => image,
    video: () => video,
  }),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

const media = s.model({
  id: s.string().id(),
  url: s.string(),
});

const image = media.extends({
  width: s.int(),
  height: s.int(),
});

const video = media.extends({
  width: s.int(),
  height: s.int(),
  duration: s.int(),
});

const schema = { user, post };
const id = s.string().id();
type StataId = Prettify<(typeof id)["~"]["state"]["autoGenerate"]>;
// Create client with PGlite
const client = createClient({
  schema,
  instrumentation: {
    logging: true,
  },
  cache: new MemoryCache(),
});

const posts = await client.post.findMany({
  where: {
    content: "eazeazlk",
  },
  include: {
    media: true,
  },
});

const res2 = await client.user.create({
  data: {
    email: "eze@example.com",
    friends: {
      createMany: {
        data: [
          {
            email: "friend1@example.com",
            name: "friend1",
            status: "active",
            pets: [],
          },
        ],
      },
    },
    pets: [
      {
        name: "dog1",
        age: 10,
        type: "cat",
      },
    ],
    status: "deleted",
    name: "eza",
    posts: {},
  },
  omit: {
    status: true,
  },
  select: {
    friends: true,
    email: true,
    pets: true,
    posts: {
      select: {
        media: true,
      },
    },
  },
});

// client.$transaction(async (tx) => {
//   await tx.user.exist({
//     where: {
//       id: "2",
//     },
//   });
// });

// const res = client.$transaction([
//   client.user.exist({
//     where: {
//       id: (ctx)=>ctx.fields.name,
//     },
//   }),
// ]);

// // Push schema (will be no-op if already in sync)
// const pushResult = await push(client, {
//   force: true,
//   resolve: async (change) => {
//     if (change.type === "enumValueRemoval") {
//       return change.useNull();
//     }
//     return change.reject();
//   },
// });
// console.log("Push result:", {
//   applied: pushResult.applied,
//   operationsCount: pushResult.operations.length,
// });

// // Clean up any existing test data
// await client.post.deleteMany();
// await client.user.deleteMany();

// // Test CRUD operations
// console.log("\n--- Testing CRUD operations ---\n");

// // Create a user
// const newUser = await client.user.create({
//   data: {
//     email: "lemz",
//     name: "eze",
//     status: "active",
//     pets: [
//       {
//         age: 10,
//         name: "dog1",
//         type: "cat",
//       },
//     ],
//   },
//   include: {
//     posts: {
//       where: {
//         AND: [
//           {
//             title: {
//               contains: "Hello",
//             },
//             id: {
//               endsWith: "123",
//             },
//           },
//         ],
//       },
//     },
//   },
// });
// console.log("Created user:", newUser);

// const newUserfetched = await client.user.findUnique({
//   where: {
//     id:"2"

//   },
//   include: {
//     posts:{
//       select:{
//         content:true,
//         author:true,
//       }
//     }
//   },
// });
// console.log("Created user:", newUser);

// // // Create a post for this user
// // const newPost = await client.post.create({
// //   data: {
// //     id: crypto.randomUUID(),
// //     title: "Hello World",
// //     content: "This is my first post!",
// //     authorId: newUser.id,
// //   },
// // });

// // // Find all users
// // const allUsers = await client.user.findMany();

// // // Find user by id
// // const foundUser = await client.user.findFirst({
// //   where: { id: newUser.id },
// // });

// // // Find user with posts (include)

// // const userWithPosts = await client.user.findFirst({
// //   where: { id: newUser.id },
// //   include: {
// //     posts: {
// //       include: {
// //         author: {
// //           include: {
// //             posts: {
// //               skip: 2,
// //             },
// //           },
// //         },
// //       },
// //     },
// //   },
// // });

// // // Update the user
// // const updatedUser = await client.user.update({
// //   where: { id: newUser.id },
// //   data: {
// //     name: "Jane Doe",
// //     email: {
// //       set: "eak",
// //     },
// //     pets: [
// //       {
// //         age: 10,
// //         name: "dog",
// //         type: "dog",
// //       },
// //     ],
// //   },
// // });

// // // Count users
// // const userCount = await client.user.count({});

// // // Clean up - delete the post first (foreign key constraint)
// // await client.post.delete({ where: { id: newPost.id } });

// // // Delete the user
// // await client.user.delete({ where: { id: newUser.id } });

// // await client.$transaction(async (tx) => {
// //   const newUser = await tx.user.create({
// //     data: {
// //       email: "eze2",
// //       name: "eze2",
// //       pets: [
// //         {
// //           age: 10,
// //           name: "dog",
// //           type: "dog",
// //         },
// //       ],
// //     },
// //   });
// //   const newPost = await tx.post.create({
// //     data: {
// //       title: "Hello World2",
// //       content: "This is my second post!",
// //       authorId: newUser.id,
// //     },
// //   });
// // });

// // Disconnect

// await client.$disconnect();
// console.log("\nDone!");
