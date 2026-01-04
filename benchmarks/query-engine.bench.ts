/**
 * Query Engine Benchmark
 *
 * Measures query building performance for M2M operations.
 * Run with: bun benchmarks/query-engine.bench.ts
 */

import { s } from "../src/schema";
import { PostgresAdapter } from "../src/adapters/databases/postgres/postgres-adapter";
import {
  QueryEngine,
  createModelRegistry,
} from "../src/query-engine/query-engine";

// =============================================================================
// TEST MODELS
// =============================================================================

const Author = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.oneToMany(() => Post),
});

const Post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s.manyToOne(() => Author, {
      fields: ["authorId"],
      references: ["id"],
      optional: true,
    }),
    tags: s.manyToMany(() => Tag),
  })
  .map("posts");

const Tag = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.manyToMany(() => Post),
  })
  .map("tags");

// =============================================================================
// BENCHMARK UTILITIES
// =============================================================================

const WARMUP_ITERATIONS = 1000;
const BENCHMARK_RUNS = 5;

function benchmark(name: string, fn: () => void, iterations = 10000): number {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn();

  // Run multiple times and take the median for stability
  const times: number[] = [];
  for (let run = 0; run < BENCHMARK_RUNS; run++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    const end = performance.now();
    times.push(end - start);
  }

  // Return median
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

function formatMs(ms: number): string {
  return ms.toFixed(2) + "ms";
}

function formatOpsPerSec(ms: number, iterations: number): string {
  const ops = (iterations / ms) * 1000;
  if (ops > 1_000_000) return (ops / 1_000_000).toFixed(2) + "M ops/s";
  if (ops > 1_000) return (ops / 1_000).toFixed(2) + "K ops/s";
  return ops.toFixed(2) + " ops/s";
}

interface BenchmarkResult {
  name: string;
  time: number;
  iterations: number;
}

function runBenchmark(
  name: string,
  fn: () => void,
  iterations = 10000
): BenchmarkResult {
  return {
    name,
    time: benchmark(name, fn, iterations),
    iterations,
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log("\n" + "=".repeat(80));
  console.log("QUERY ENGINE BENCHMARK RESULTS");
  console.log("=".repeat(80) + "\n");

  for (const r of results) {
    console.log(`📊 ${r.name} (${r.iterations.toLocaleString()} iterations)`);
    console.log("-".repeat(70));
    console.log(
      `  Time:     ${formatMs(r.time).padEnd(12)} ${formatOpsPerSec(
        r.time,
        r.iterations
      )}`
    );
    console.log();
  }
}

// =============================================================================
// SETUP
// =============================================================================

const adapter = new PostgresAdapter();
const registry = createModelRegistry({ Author, Post, Tag });
const engine = new QueryEngine(adapter, registry);

// =============================================================================
// RUN BENCHMARKS
// =============================================================================

console.log("Starting Query Engine benchmarks...\n");

const results: BenchmarkResult[] = [];

// ==================== M2M INCLUDE ====================
console.log("Testing M2M include query building...");

results.push(
  runBenchmark(
    "M2M Include: Post with tags",
    () => {
      engine.build(Post, "findMany", {
        select: {
          id: true,
          title: true,
          tags: { select: { id: true, name: true } },
        },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "M2M Include: Tag with posts",
    () => {
      engine.build(Tag, "findMany", {
        select: {
          id: true,
          name: true,
          posts: { select: { id: true, title: true } },
        },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "M2M Include: with where filter",
    () => {
      engine.build(Post, "findMany", {
        select: {
          id: true,
          tags: {
            where: { name: { startsWith: "type" } },
            select: { id: true, name: true },
          },
        },
      });
    },
    10000
  )
);

// ==================== M2M FILTER ====================
console.log("Testing M2M filter query building...");

results.push(
  runBenchmark(
    "M2M Filter: some",
    () => {
      engine.build(Post, "findMany", {
        where: {
          tags: {
            some: { name: "typescript" },
          },
        },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "M2M Filter: every",
    () => {
      engine.build(Post, "findMany", {
        where: {
          tags: {
            every: { name: { startsWith: "type" } },
          },
        },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "M2M Filter: none",
    () => {
      engine.build(Post, "findMany", {
        where: {
          tags: {
            none: { name: "deprecated" },
          },
        },
      });
    },
    10000
  )
);

// ==================== M2M COUNT ====================
console.log("Testing M2M count query building...");

results.push(
  runBenchmark(
    "M2M Count: simple",
    () => {
      engine.build(Post, "findMany", {
        select: {
          id: true,
          _count: {
            select: { tags: true },
          },
        },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "M2M Count: with where",
    () => {
      engine.build(Post, "findMany", {
        select: {
          id: true,
          _count: {
            select: {
              tags: { where: { name: { contains: "script" } } },
            },
          },
        },
      });
    },
    10000
  )
);

// ==================== COMPARISON BASELINES ====================
console.log("Testing comparison baselines...");

results.push(
  runBenchmark(
    "Baseline: Simple findMany (no relations)",
    () => {
      engine.build(Post, "findMany", {
        where: { published: true },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "Baseline: OneToMany include",
    () => {
      engine.build(Author, "findMany", {
        select: {
          id: true,
          posts: { select: { id: true, title: true } },
        },
      });
    },
    10000
  )
);

results.push(
  runBenchmark(
    "Baseline: ManyToOne include",
    () => {
      engine.build(Post, "findMany", {
        select: {
          id: true,
          author: { select: { id: true, name: true } },
        },
      });
    },
    10000
  )
);

printResults(results);

// Summary
console.log("=".repeat(80));
console.log("SUMMARY");
console.log("=".repeat(80));

const m2mResults = results.filter((r) => r.name.startsWith("M2M"));
const avgM2mTime =
  m2mResults.reduce((sum, r) => sum + r.time, 0) / m2mResults.length;
const baselineResult = results.find((r) => r.name.includes("Simple findMany"));

console.log(`  Average M2M operation: ${formatMs(avgM2mTime)}`);
if (baselineResult) {
  console.log(`  Baseline (no relations): ${formatMs(baselineResult.time)}`);
  console.log(
    `  M2M overhead: ${(avgM2mTime / baselineResult.time).toFixed(2)}x baseline`
  );
}
