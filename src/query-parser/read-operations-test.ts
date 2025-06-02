import { createClient } from "../client";
import { s } from "../schema";
import { PostgresAdapter } from "../adapters/databases/postgres/postgres-adapter";
import { QueryParser } from "./index";

const user = s.model("User", {
  id: s.string(),
  name: s.string(),
  email: s.string(),
  age: s.int(),
  posts: s
    .relation({ onField: "id", refField: "authorId" })
    .oneToMany(() => post),
});

const post = s.model("Post", {
  id: s.string(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  author: s
    .relation({ onField: "authorId", refField: "id" })
    .manyToOne(() => user),
});

async function testReadOperations() {
  console.log("🧪 Testing Enhanced Read Operations\n");

  const adapter = new PostgresAdapter();

  // Test 1: findMany (should not have LIMIT)
  console.log("1️⃣ Testing findMany:");
  const findManyQuery = QueryParser.parse(
    "findMany",
    user,
    {
      where: { name: "Alice" },
      orderBy: { name: "asc" },
    },
    adapter
  );
  console.log("   SQL:", findManyQuery.strings.join(""));
  console.log("   ✅ Should NOT have LIMIT clause\n");

  // Test 2: findFirst (should have LIMIT 1)
  console.log("2️⃣ Testing findFirst:");
  const findFirstQuery = QueryParser.parse(
    "findFirst",
    user,
    {
      where: { name: "Alice" },
      orderBy: { name: "asc" },
    },
    adapter
  );
  console.log("   SQL:", findFirstQuery.strings.join(""));
  console.log("   ✅ Should have LIMIT 1\n");

  // Test 3: findUnique (should have LIMIT 1 + validation)
  console.log("3️⃣ Testing findUnique:");
  const findUniqueQuery = QueryParser.parse(
    "findUnique",
    user,
    {
      where: { id: "123" },
    },
    adapter
  );
  console.log("   SQL:", findUniqueQuery.strings.join(""));
  console.log("   ✅ Should have LIMIT 1 and validate unique WHERE\n");

  // Test 4: findMany with distinct
  console.log("4️⃣ Testing findMany with distinct:");
  const findManyDistinctQuery = QueryParser.parse(
    "findMany",
    user,
    {
      distinct: ["name", "email"],
      where: { age: { gte: 18 } },
    },
    adapter
  );
  console.log("   SQL:", findManyDistinctQuery.strings.join(""));
  console.log("   ✅ Should handle DISTINCT clause\n");

  // Test 5: findMany with pagination
  console.log("5️⃣ Testing findMany with pagination:");
  const findManyPaginatedQuery = QueryParser.parse(
    "findMany",
    user,
    {
      where: { age: { gte: 18 } },
      take: 10,
      skip: 5,
      orderBy: { name: "asc" },
    },
    adapter
  );
  console.log("   SQL:", findManyPaginatedQuery.strings.join(""));
  console.log("   ✅ Should have LIMIT 10 OFFSET 5\n");

  // Test 6: findUniqueOrThrow with missing WHERE (should throw)
  console.log("6️⃣ Testing findUniqueOrThrow validation:");
  try {
    const invalidQuery = QueryParser.parse(
      "findUniqueOrThrow",
      user,
      {
        // Missing where clause - should throw
      },
      adapter
    );
    console.log("   ❌ Should have thrown an error!");
  } catch (error) {
    console.log("   ✅ Correctly threw error:", (error as Error).message);
  }

  console.log("\n🎉 All read operation tests completed!");
}

testReadOperations().catch(console.error);
