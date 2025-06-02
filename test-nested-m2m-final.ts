import { s } from "./src/schema/index.js";
import { QueryParser } from "./src/query-parser/index.js";
import { PostgresAdapter } from "./src/adapters/databases/postgres/postgres-adapter.js";

// Define models with Many-to-Many relations
const user = s.model("user", {
  id: s.string().id(),
  name: s.string(),
  email: s.string(),
  posts: s
    .relation({ onField: "id", refField: "authorId" })
    .oneToMany(() => post), // User has many posts
  tags: s.relation.manyToMany(() => tag), // Many-to-Many
});

const post = s.model("post", {
  id: s.string().id(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  author: s
    .relation({ onField: "authorId", refField: "id" })
    .manyToOne(() => user), // Post belongs to user
  categories: s.relation.manyToMany(() => category), // Many-to-Many
});

const tag = s.model("tag", {
  id: s.string().id(),
  name: s.string(),
  users: s.relation.manyToMany(() => user), // Many-to-Many back reference
});

const category = s.model("category", {
  id: s.string().id(),
  name: s.string(),
  posts: s.relation.manyToMany(() => post), // Many-to-Many back reference
});

// Test nested Many-to-Many includes
const adapter = new PostgresAdapter();

console.log("🎯 Testing Nested Many-to-Many Relations\n");

// Test 1: User with posts and their categories (nested M2M)
console.log("=== Test 1: User → Posts → Categories (Nested M2M) ===");
try {
  const query1 = QueryParser.parse(
    "findMany",
    user,
    {
      where: { name: "Alice" },
      include: {
        posts: {
          include: {
            categories: true, // This should work now!
          },
        },
      },
    },
    adapter
  );
  console.log("✅ Nested M2M query generated successfully");
  console.log("SQL:", query1.toStatement());
  console.log("Values:", query1.values);
} catch (error) {
  console.error("❌ Test 1 failed:", error.message);
}

console.log("\n=== Test 2: User → Tags (Direct M2M) ===");
try {
  const query2 = QueryParser.parse(
    "findMany",
    user,
    {
      where: { name: "Bob" },
      include: {
        tags: true,
      },
    },
    adapter
  );
  console.log("✅ Direct M2M query generated successfully");
  console.log("SQL:", query2.toStatement());
  console.log("Values:", query2.values);
} catch (error) {
  console.error("❌ Test 2 failed:", error.message);
}

console.log("\n=== Test 3: Complex Nested with Filtering ===");
try {
  const query3 = QueryParser.parse(
    "findMany",
    user,
    {
      where: { email: { contains: "@example.com" } },
      include: {
        posts: {
          where: { title: { contains: "TypeScript" } },
          include: {
            categories: {
              where: { name: { in: ["Tech", "Programming"] } },
            },
          },
        },
        tags: {
          where: { name: { startsWith: "dev-" } },
        },
      },
    },
    adapter
  );
  console.log("✅ Complex nested M2M with filtering generated successfully");
  console.log("SQL:", query3.toStatement());
  console.log("Values:", query3.values);
} catch (error) {
  console.error("❌ Test 3 failed:", error.message);
}

console.log("\n🏁 Nested Many-to-Many Test Complete!");
