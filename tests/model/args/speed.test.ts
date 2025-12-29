/**
 * Schema Creation & Validation Speed Tests
 *
 * Measures performance for serverless environments where each request:
 * 1. Creates model schemas (getModelSchemas)
 * 2. Validates input data (parse)
 *
 * Tests various query complexities:
 * - Simple queries (findUnique with ID)
 * - Filtered queries (findMany with where)
 * - Nested includes (1-3 levels deep)
 * - Complex creates (with nested relations)
 * - Complex updates (with multiple operations)
 */

import { describe, test, expect, beforeAll } from "vitest";
import { parse } from "../../../src/validation";
import { s } from "../../../src/schema";
import { getModelSchemas } from "../../../src/schema/model/schemas";

// =============================================================================
// TEST MODELS - Various complexity levels
// =============================================================================

// Simple model - minimal fields
const SimpleModel = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
});

// Medium model - more fields, nullable, defaults
const MediumModel = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  bio: s.string().nullable(),
  active: s.boolean().default(true),
  score: s.float().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
});

// Complex model with relations
const Author = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  bio: s.string().nullable(),
  posts: s.oneToMany(() => Post),
  profile: s.oneToOne(() => Profile, { optional: true }),
});

const Post = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
  views: s.int().default(0),
  authorId: s.string(),
  author: s.manyToOne(() => Author),
  comments: s.oneToMany(() => Comment),
  tags: s.string().array(),
});

const Comment = s.model({
  id: s.string().id(),
  text: s.string(),
  postId: s.string(),
  post: s.manyToOne(() => Post),
  authorId: s.string().nullable(),
});

const Profile = s.model({
  id: s.string().id(),
  avatar: s.string().nullable(),
  website: s.string().nullable(),
  userId: s.string().unique(),
  user: s.oneToOne(() => Author),
});

// =============================================================================
// HELPERS
// =============================================================================

const ITERATIONS = 100;

interface BenchmarkResult {
  operation: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}

function benchmark(
  operation: string,
  iterations: number,
  fn: () => void
): BenchmarkResult {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const total = times.reduce((sum, t) => sum + t, 0);
  const p95Index = Math.floor(iterations * 0.95);

  return {
    operation,
    iterations,
    totalMs: total,
    avgMs: total / iterations,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p95Ms: times[p95Index],
  };
}

function logResult(result: BenchmarkResult) {
  console.log(
    `  ${result.operation}: avg=${result.avgMs.toFixed(3)}ms, ` +
      `p95=${result.p95Ms.toFixed(3)}ms, ` +
      `min=${result.minMs.toFixed(3)}ms, ` +
      `max=${result.maxMs.toFixed(3)}ms`
  );
}

// =============================================================================
// SCHEMA CREATION BENCHMARKS
// =============================================================================

describe("Schema Creation Speed", () => {
  test("simple model schema creation", () => {
    const result = benchmark("Simple Model", ITERATIONS, () => {
      getModelSchemas(SimpleModel["~"].state);
    });

    logResult(result);
    expect(result.avgMs).toBeLessThan(50); // Should be fast
  });

  test("medium model schema creation", () => {
    const result = benchmark("Medium Model", ITERATIONS, () => {
      getModelSchemas(MediumModel["~"].state);
    });

    logResult(result);
    expect(result.avgMs).toBeLessThan(100);
  });

  test("complex model with relations schema creation", () => {
    const result = benchmark("Complex Model (Author)", ITERATIONS, () => {
      getModelSchemas(Author["~"].state);
    });

    logResult(result);
    expect(result.avgMs).toBeLessThan(200);
  });

  test("model with deep relations schema creation", () => {
    const result = benchmark("Deep Relations (Post)", ITERATIONS, () => {
      getModelSchemas(Post["~"].state);
    });

    logResult(result);
    expect(result.avgMs).toBeLessThan(200);
  });
});

// =============================================================================
// VALIDATION SPEED BENCHMARKS (Schema created once)
// =============================================================================

describe("Validation Speed (Pre-built Schema)", () => {
  // Pre-build schemas for validation tests
  let authorSchemas: ReturnType<typeof getModelSchemas>;
  let postSchemas: ReturnType<typeof getModelSchemas>;

  beforeAll(() => {
    authorSchemas = getModelSchemas(Author["~"].state);
    postSchemas = getModelSchemas(Post["~"].state);
  });

  describe("Simple Queries", () => {
    test("findUnique - simple ID lookup", () => {
      const result = benchmark("findUnique (simple)", ITERATIONS, () => {
        parse(authorSchemas.args.findUnique, {
          where: { id: "author-1" },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(5);
    });

    test("findFirst - with simple filter", () => {
      const result = benchmark("findFirst (simple filter)", ITERATIONS, () => {
        parse(authorSchemas.args.findFirst, {
          where: { name: "Alice" },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(5);
    });
  });

  describe("Filtered Queries", () => {
    test("findMany - with complex where", () => {
      const result = benchmark("findMany (complex where)", ITERATIONS, () => {
        parse(postSchemas.args.findMany, {
          where: {
            published: true,
            title: { contains: "hello" },
            views: { gte: 100 },
            author: {
              is: { name: { startsWith: "A" } },
            },
          },
          orderBy: { views: "desc" },
          take: 10,
          skip: 0,
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(10);
    });

    test("findMany - with OR/AND filters", () => {
      const result = benchmark("findMany (OR/AND)", ITERATIONS, () => {
        parse(postSchemas.args.findMany, {
          where: {
            OR: [
              { title: { contains: "news" } },
              { title: { contains: "update" } },
            ],
            AND: [{ published: true }, { views: { gt: 0 } }],
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(10);
    });
  });

  describe("Nested Includes", () => {
    test("1-level include", () => {
      const result = benchmark("Include (1-level)", ITERATIONS, () => {
        parse(authorSchemas.args.findUnique, {
          where: { id: "author-1" },
          include: { posts: true },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(5);
    });

    test("2-level include", () => {
      const result = benchmark("Include (2-level)", ITERATIONS, () => {
        parse(authorSchemas.args.findUnique, {
          where: { id: "author-1" },
          include: {
            posts: {
              include: { author: true },
            },
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(10);
    });

    test("3-level include with filters", () => {
      const result = benchmark(
        "Include (3-level + filters)",
        ITERATIONS,
        () => {
          parse(authorSchemas.args.findUnique, {
            where: { id: "author-1" },
            include: {
              posts: {
                where: { published: true },
                take: 5,
                orderBy: { views: "desc" },
                include: {
                  author: {
                    include: { posts: true },
                  },
                  comments: true,
                },
              },
              profile: true,
            },
          });
        }
      );

      logResult(result);
      expect(result.issues).toBeUndefined();
      expect(result.avgMs).toBeLessThan(15);
    });
  });

  describe("Create Operations", () => {
    test("simple create", () => {
      const result = benchmark("Create (simple)", ITERATIONS, () => {
        parse(authorSchemas.args.create, {
          data: {
            id: "author-new",
            name: "New Author",
            email: "new@example.com",
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(5);
    });

    test("create with nested relation", () => {
      const result = benchmark("Create (nested)", ITERATIONS, () => {
        parse(authorSchemas.args.create, {
          data: {
            id: "author-new",
            name: "New Author",
            email: "new@example.com",
            posts: {
              create: [
                { id: "post-1", title: "Post 1", authorId: "author-new" },
                { id: "post-2", title: "Post 2", authorId: "author-new" },
              ],
            },
            profile: {
              create: {
                id: "profile-1",
                avatar: "avatar.png",
                userId: "author-new",
              },
            },
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(15);
    });
  });

  describe("Update Operations", () => {
    test("simple update", () => {
      const result = benchmark("Update (simple)", ITERATIONS, () => {
        parse(authorSchemas.args.update, {
          where: { id: "author-1" },
          data: { name: "Updated Name" },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(5);
    });

    test("update with nested operations", () => {
      const result = benchmark("Update (nested)", ITERATIONS, () => {
        parse(authorSchemas.args.update, {
          where: { id: "author-1" },
          data: {
            name: "Updated Author",
            posts: {
              create: {
                id: "new-post",
                title: "New Post",
                authorId: "author-1",
              },
              update: {
                where: { id: "existing-post" },
                data: { title: "Updated Title" },
              },
              deleteMany: { published: false },
            },
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(15);
    });
  });
});

// =============================================================================
// FULL SERVERLESS REQUEST SIMULATION
// =============================================================================

describe("Serverless Request Simulation (Schema Build + Validate)", () => {
  describe("Author Model", () => {
    test("findUnique - full request", () => {
      const result = benchmark("findUnique (full)", ITERATIONS, () => {
        // Simulate serverless: build schema + validate
        const schemas = getModelSchemas(Author["~"].state);
        parse(schemas.args.findUnique, {
          where: { id: "author-1" },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(100);
    });

    test("findMany with filters - full request", () => {
      const result = benchmark("findMany filtered (full)", ITERATIONS, () => {
        const schemas = getModelSchemas(Author["~"].state);
        parse(schemas.args.findMany, {
          where: { name: { contains: "Alice" } },
          take: 10,
          orderBy: { name: "asc" },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(100);
    });

    test("findMany with nested include - full request", () => {
      const result = benchmark("findMany + include (full)", ITERATIONS, () => {
        const schemas = getModelSchemas(Author["~"].state);
        parse(schemas.args.findMany, {
          where: { name: { startsWith: "A" } },
          include: {
            posts: {
              where: { published: true },
              take: 5,
              include: { comments: true },
            },
            profile: true,
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(150);
    });

    test("create with nested - full request", () => {
      const result = benchmark("create nested (full)", ITERATIONS, () => {
        const schemas = getModelSchemas(Author["~"].state);
        parse(schemas.args.create, {
          data: {
            id: "author-new",
            name: "New Author",
            email: "new@example.com",
            posts: {
              create: [
                { id: "p1", title: "Post 1", authorId: "author-new" },
                { id: "p2", title: "Post 2", authorId: "author-new" },
              ],
            },
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(150);
    });

    test("update with complex operations - full request", () => {
      const result = benchmark("update complex (full)", ITERATIONS, () => {
        const schemas = getModelSchemas(Author["~"].state);
        parse(schemas.args.update, {
          where: { id: "author-1" },
          data: {
            name: "Updated",
            posts: {
              create: { id: "new", title: "New", authorId: "author-1" },
              updateMany: { where: {}, data: { published: true } },
              deleteMany: { title: { contains: "draft" } },
            },
          },
        });
      });

      logResult(result);
      expect(result.avgMs).toBeLessThan(150);
    });
  });

  describe("Post Model (Deep Relations)", () => {
    test("findMany with 3-level include - full request", () => {
      const result = benchmark(
        "Post findMany 3-level (full)",
        ITERATIONS,
        () => {
          const schemas = getModelSchemas(Post["~"].state);
          parse(schemas.args.findMany, {
            where: { published: true },
            include: {
              author: {
                include: {
                  posts: {
                    take: 3,
                    include: { comments: true },
                  },
                },
              },
              comments: {
                take: 10,
              },
            },
            take: 20,
            orderBy: { views: "desc" },
          });
        }
      );

      logResult(result);
      expect(result.avgMs).toBeLessThan(200);
    });
  });
});

// =============================================================================
// SUMMARY REPORT
// =============================================================================

describe("Performance Summary", () => {
  test("generate summary report", () => {
    console.log("\n=== PERFORMANCE SUMMARY ===\n");

    // Schema creation
    const simpleSchemaResult = benchmark("Schema: Simple", 50, () => {
      getModelSchemas(SimpleModel["~"].state);
    });

    const complexSchemaResult = benchmark("Schema: Complex", 50, () => {
      getModelSchemas(Author["~"].state);
    });

    // Pre-built validation
    const authorSchemas = getModelSchemas(Author["~"].state);
    const simpleQueryResult = benchmark("Validate: Simple Query", 50, () => {
      parse(authorSchemas.args.findUnique, { where: { id: "1" } });
    });

    const complexQueryResult = benchmark("Validate: Complex Query", 50, () => {
      parse(authorSchemas.args.findMany, {
        where: { name: { contains: "A" } },
        include: { posts: { include: { comments: true } } },
        take: 10,
      });
    });

    // Full request
    const fullSimpleResult = benchmark("Full Request: Simple", 50, () => {
      const schemas = getModelSchemas(Author["~"].state);
      parse(schemas.args.findUnique, { where: { id: "1" } });
    });

    const fullComplexResult = benchmark("Full Request: Complex", 50, () => {
      const schemas = getModelSchemas(Author["~"].state);
      parse(schemas.args.findMany, {
        where: { name: { contains: "A" } },
        include: { posts: { include: { comments: true } } },
        take: 10,
      });
    });

    console.log("Schema Creation:");
    logResult(simpleSchemaResult);
    logResult(complexSchemaResult);

    console.log("\nValidation (pre-built schema):");
    logResult(simpleQueryResult);
    logResult(complexQueryResult);

    console.log("\nFull Serverless Request (schema + validation):");
    logResult(fullSimpleResult);
    logResult(fullComplexResult);

    console.log("\n=== END SUMMARY ===\n");

    expect(true).toBe(true); // Always pass, this is for reporting
  });
});
