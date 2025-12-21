import { describe, test, expect } from "vitest";
import { s } from "@schema";
import {
  createModelRegistry,
  QueryEngine,
} from "../../src/query-engine/query-engine";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";

describe("Nested Relation Filtering - SQL Output", () => {
  // Define test schema with bidirectional relations
  const User = s.model({
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
    posts: s.manyToMany(() => Post, {
      fields: ["id"],
      references: ["authorId"],
    }),
  });

  const Post = s.model({
    id: s.string().id(),
    title: s.string(),
    content: s.string(),
    published: s.boolean(),
    authorId: s.string(),
    author: s.manyToOne(() => User, {
      fields: ["authorId"],
      references: ["id"],
    }),
  });

  console.log(User["~"].scalarSchemas);
  const registry = createModelRegistry({ User, Post });

  // console.log(User["~"].scalarSchemas);
  test("findMany users with nested post filter (some)", () => {
    // const engine = new QueryEngine(new PostgresAdapter(), registry);
    // Find users who have at least one published post
    // const result = engine.build(User, "findMany", {
    //   where: {
    //     id: "test",
    //   },
    //   // select: {
    //   //   id: true,
    //   //   name: true,
    //   //   email: true,
    //   // },
    // });
    // console.log("\n=== SQL for: Users with published posts (some) ===");
    // console.log({ result });
    console.log("\nParameters:", "result.values");
    // expect(result.strings.join("?")).toContain("SELECT");
    // expect(result.strings.join("?")).toContain("EXISTS");
    // expect(result.strings.join("?")).toContain("posts");
  });

  //   test("findMany users with nested post filter (every)", () => {
  //     const engine = new QueryEngine(new PostgresAdapter(), registry);

  //     // Find users where ALL their posts are published
  //     const result = engine.build(User, "findMany", {
  //       where: {
  //         posts: {
  //           every: {
  //             published: true,
  //           },
  //         },
  //       },
  //       select: {
  //         id: true,
  //         name: true,
  //       },
  //     });

  //     console.log(
  //       "\n=== SQL for: Users where ALL posts are published (every) ==="
  //     );
  //     console.log(result.strings.join("?"));
  //     console.log("\nParameters:", result.values);

  //     expect(result.strings.join("?")).toContain("SELECT");
  //     expect(result.strings.join("?")).toContain("NOT EXISTS");
  //   });

  //   test("findMany users with nested post filter (none)", () => {
  //     const engine = new QueryEngine(new PostgresAdapter(), registry);

  //     // Find users who have NO published posts
  //     const result = engine.build(User, "findMany", {
  //       where: {
  //         posts: {
  //           none: {
  //             published: true,
  //           },
  //         },
  //       },
  //       select: {
  //         id: true,
  //         name: true,
  //       },
  //     });

  //     console.log("\n=== SQL for: Users with NO published posts (none) ===");
  //     console.log(result.strings.join("?"));
  //     console.log("\nParameters:", result.values);

  //     expect(result.strings.join("?")).toContain("SELECT");
  //     expect(result.strings.join("?")).toContain("NOT EXISTS");
  //   });

  //   test("findMany posts with nested author filter (is)", () => {
  //     const engine = new QueryEngine(new PostgresAdapter(), registry);

  //     // Find posts where author name is "Alice"
  //     const result = engine.build(Post, "findMany", {
  //       where: {
  //         author: {
  //           is: {
  //             name: "Alice",
  //           },
  //         },
  //       },
  //       select: {
  //         id: true,
  //         title: true,
  //       },
  //     });

  //     console.log("\n=== SQL for: Posts where author name is Alice (is) ===");
  //     console.log(result.strings.join("?"));
  //     console.log("\nParameters:", result.values);

  //     expect(result.strings.join("?")).toContain("SELECT");
  //     expect(result.strings.join("?")).toContain("EXISTS");
  //     expect(result.strings.join("?")).toContain("users");
  //   });

  //   test("findMany users with complex nested filter", () => {
  //     const engine = new QueryEngine(new PostgresAdapter(), registry);

  //     // Find users who have published posts with "TypeScript" in title
  //     const result = engine.build(User, "findMany", {
  //       where: {
  //         AND: [
  //           {
  //             email: {
  //               contains: "@example.com",
  //             },
  //           },
  //           {
  //             posts: {
  //               some: {
  //                 AND: [
  //                   { published: true },
  //                   {
  //                     title: {
  //                       contains: "TypeScript",
  //                     },
  //                   },
  //                 ],
  //               },
  //             },
  //           },
  //         ],
  //       },
  //       select: {
  //         id: true,
  //         name: true,
  //         email: true,
  //       },
  //     });

  //     console.log(
  //       "\n=== SQL for: Complex nested filter (AND + some + contains) ==="
  //     );
  //     console.log(result.strings.join("?"));
  //     console.log("\nParameters:", result.values);

  //     expect(result.strings.join("?")).toContain("SELECT");
  //     expect(result.strings.join("?")).toContain("EXISTS");
  //     expect(result.strings.join("?")).toContain("AND");
  //     expect(result.strings.join("?")).toContain("LIKE");
  //   });

  //   test("findMany with include AND nested filter", () => {
  //     const engine = new QueryEngine(new PostgresAdapter(), registry);

  //     // Find users with published posts, AND include those posts
  //     const result = engine.build(User, "findMany", {
  //       where: {
  //         posts: {
  //           some: {
  //             published: true,
  //           },
  //         },
  //       },
  //       include: {
  //         posts: true,
  //       },
  //     });

  //     console.log(
  //       "\n=== SQL for: Users with published posts + include posts ==="
  //     );
  //     console.log(result.strings.join("?"));
  //     console.log("\nParameters:", result.values);

  //     expect(result.strings.join("?")).toContain("SELECT");
  //     expect(result.strings.join("?")).toContain("EXISTS");
  //     expect(result.strings.join("?")).toContain("JSON");
  //   });
});
