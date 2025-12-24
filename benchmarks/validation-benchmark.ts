/**
 * Validation Library Benchmark
 * Compares VibORM, Valibot, and Zod performance on ORM-like schemas
 *
 * All libraries are tested using their StandardSchema (~standard.validate) interface
 * for a fair comparison.
 *
 * Zod JIT is DISABLED to simulate Cloudflare Workers environment
 * (where eval/new Function is not allowed)
 */

import { v } from "../src/validation";
import * as valibot from "valibot";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// IMPORTANT: Disable Zod JIT compilation BEFORE any schemas are defined
// This simulates Cloudflare Workers / edge environments where eval is forbidden
z.config({ jitless: true });

// Helper to validate via StandardSchema interface
function validateStandard<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown
) {
  return schema["~standard"].validate(value);
}

// =============================================================================
// Benchmark Utilities
// =============================================================================

const WARMUP_ITERATIONS = 1000;
const BENCHMARK_RUNS = 5;

function benchmark(name: string, fn: () => void, iterations = 10000): number {
  // Extended warmup to stabilize JIT
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn();

  // Run multiple times and take the median for stability
  const times: number[] = [];
  for (let run = 0; run < BENCHMARK_RUNS; run++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    const end = performance.now();
    times.push(end - start);
  }

  // Return median (more stable than mean)
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
  viborm: number;
  valibot: number;
  zod: number;
  iterations: number;
}

function runBenchmark(
  name: string,
  vibormFn: () => void,
  valibotFn: () => void,
  zodFn: () => void,
  iterations = 10000
): BenchmarkResult {
  return {
    name,
    viborm: benchmark("viborm", vibormFn, iterations),
    valibot: benchmark("valibot", valibotFn, iterations),
    zod: benchmark("zod", zodFn, iterations),
    iterations,
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log("\n" + "=".repeat(80));
  console.log("VALIDATION BENCHMARK RESULTS");
  console.log("=".repeat(80) + "\n");

  for (const r of results) {
    const fastest = Math.min(r.viborm, r.valibot, r.zod);
    const vibormRatio = (r.viborm / fastest).toFixed(2);
    const valibotRatio = (r.valibot / fastest).toFixed(2);
    const zodRatio = (r.zod / fastest).toFixed(2);

    console.log(`📊 ${r.name} (${r.iterations.toLocaleString()} iterations)`);
    console.log("-".repeat(60));
    console.log(
      `  VibORM:  ${formatMs(r.viborm).padEnd(12)} ${formatOpsPerSec(
        r.viborm,
        r.iterations
      ).padEnd(15)} ${
        vibormRatio === "1.00" ? "🏆 fastest" : `${vibormRatio}x slower`
      }`
    );
    console.log(
      `  Valibot: ${formatMs(r.valibot).padEnd(12)} ${formatOpsPerSec(
        r.valibot,
        r.iterations
      ).padEnd(15)} ${
        valibotRatio === "1.00" ? "🏆 fastest" : `${valibotRatio}x slower`
      }`
    );
    console.log(
      `  Zod:     ${formatMs(r.zod).padEnd(12)} ${formatOpsPerSec(
        r.zod,
        r.iterations
      ).padEnd(15)} ${
        zodRatio === "1.00" ? "🏆 fastest" : `${zodRatio}x slower`
      }`
    );
    console.log();
  }

  // Summary
  console.log("=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  let vibormWins = 0,
    valibotWins = 0,
    zodWins = 0;
  for (const r of results) {
    const fastest = Math.min(r.viborm, r.valibot, r.zod);
    if (r.viborm === fastest) vibormWins++;
    if (r.valibot === fastest) valibotWins++;
    if (r.zod === fastest) zodWins++;
  }

  console.log(`  VibORM wins:  ${vibormWins}/${results.length}`);
  console.log(`  Valibot wins: ${valibotWins}/${results.length}`);
  console.log(`  Zod wins:     ${zodWins}/${results.length}`);
}

// =============================================================================
// Pre-created Schemas for Validation Tests
// =============================================================================

const vibormString = v.string();
const valibotString = valibot.string();
const zodString = z.string();

const vibormNumber = v.number();
const valibotNumber = valibot.number();
const zodNumber = z.number();

const vibormBoolean = v.boolean();
const valibotBoolean = valibot.boolean();
const zodBoolean = z.boolean();

const vibormBigint = v.bigint();
const valibotBigint = valibot.bigint();
const zodBigint = z.bigint();

const vibormLiteral = v.literal("admin");
const valibotLiteral = valibot.literal("admin");
const zodLiteral = z.literal("admin");

// Simple Object (4 fields)
const vibormSimpleUser = v.object(
  {
    id: v.string(),
    name: v.string(),
    age: v.number(),
    active: v.boolean(),
  },
  { partial: false }
);

const valibotSimpleUser = valibot.object({
  id: valibot.string(),
  name: valibot.string(),
  age: valibot.number(),
  active: valibot.boolean(),
});

const zodSimpleUser = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number(),
  active: z.boolean(),
});

// Complex Object (nested, unions, arrays)
const vibormComplexUser = v.object(
  {
    id: v.string(),
    email: v.string(),
    name: v.string(),
    age: v.number({ optional: true }),
    role: v.union([v.literal("admin"), v.literal("user"), v.literal("guest")]),
    tags: v.string({ array: true }),
    metadata: v.object({
      createdAt: v.string(),
      updatedAt: v.string(),
      version: v.number(),
    }),
    settings: v.object(
      {
        theme: v.literal("light"),
        notifications: v.boolean(),
      },
      { partial: true }
    ),
  },
  { partial: false }
);

const valibotComplexUser = valibot.object({
  id: valibot.string(),
  email: valibot.string(),
  name: valibot.string(),
  age: valibot.optional(valibot.number()),
  role: valibot.union([
    valibot.literal("admin"),
    valibot.literal("user"),
    valibot.literal("guest"),
  ]),
  tags: valibot.array(valibot.string()),
  metadata: valibot.object({
    createdAt: valibot.string(),
    updatedAt: valibot.string(),
    version: valibot.number(),
  }),
  settings: valibot.partial(
    valibot.object({
      theme: valibot.literal("light"),
      notifications: valibot.boolean(),
    })
  ),
});

const zodComplexUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  age: z.number().optional(),
  role: z.union([z.literal("admin"), z.literal("user"), z.literal("guest")]),
  tags: z.array(z.string()),
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number(),
  }),
  settings: z
    .object({
      theme: z.literal("light"),
      notifications: z.boolean(),
    })
    .partial(),
});

// Array schemas
const vibormPost = v.object(
  {
    id: v.string(),
    title: v.string(),
    content: v.string(),
    published: v.boolean(),
    likes: v.number(),
  },
  { partial: false }
);
const vibormPosts = v.array(vibormPost);

const valibotPost = valibot.object({
  id: valibot.string(),
  title: valibot.string(),
  content: valibot.string(),
  published: valibot.boolean(),
  likes: valibot.number(),
});
const valibotPosts = valibot.array(valibotPost);

const zodPost = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  published: z.boolean(),
  likes: z.number(),
});
const zodPosts = z.array(zodPost);

// Large array of strings
const vibormStringArray = v.array(v.string());
const valibotStringArray = valibot.array(valibot.string());
const zodStringArray = z.array(z.string());

// Union schema
const vibormUnion = v.union([v.string(), v.number(), v.boolean()]);
const valibotUnion = valibot.union([
  valibot.string(),
  valibot.number(),
  valibot.boolean(),
]);
const zodUnion = z.union([z.string(), z.number(), z.boolean()]);

// Nullable/Optional
const vibormNullableOptional = v.object({
  required: v.string(),
  optional: v.string({ optional: true }),
  nullable: v.string({ nullable: true }),
  both: v.string({ optional: true, nullable: true }),
});

const valibotNullableOptional = valibot.object({
  required: valibot.string(),
  optional: valibot.optional(valibot.string()),
  nullable: valibot.nullable(valibot.string()),
  both: valibot.optional(valibot.nullable(valibot.string())),
});

const zodNullableOptional = z.object({
  required: z.string(),
  optional: z.string().optional(),
  nullable: z.string().nullable(),
  both: z.string().optional().nullable(),
});

// =============================================================================
// Test Data
// =============================================================================

const validString = "hello world";
const validNumber = 42;
const validBoolean = true;
const validBigint = BigInt(9007199254740991);

const validSimpleUser = {
  id: "user_123",
  name: "Alice",
  age: 30,
  active: true,
};

const validComplexUser = {
  id: "user_456",
  email: "alice@example.com",
  name: "Alice Smith",
  age: 28,
  role: "admin" as const,
  tags: ["premium", "verified", "early-adopter"],
  metadata: {
    createdAt: "2023-01-15T10:30:00Z",
    updatedAt: "2024-06-20T14:45:00Z",
    version: 3,
  },
  settings: {
    theme: "light" as const,
    notifications: true,
  },
};

const validPosts = Array.from({ length: 10 }, (_, i) => ({
  id: `post_${i}`,
  title: `Post Title ${i}`,
  content: `This is the content of post ${i}`,
  published: i % 2 === 0,
  likes: i * 10,
}));

const validStringArray100 = Array.from({ length: 100 }, (_, i) => `item_${i}`);

const validNullableOptional = {
  required: "hello",
  optional: undefined,
  nullable: null,
  both: null,
};

const invalidSimpleUser = {
  id: 123, // wrong type
  name: "Alice",
  age: "thirty", // wrong type
  active: true,
};

// =============================================================================
// Run Benchmarks
// =============================================================================

console.log("Starting benchmarks...\n");

const results: BenchmarkResult[] = [];

// ==================== PRIMITIVE VALIDATION ====================
console.log("Testing primitive validation...");

results.push(
  runBenchmark(
    "String validation",
    () => validateStandard(vibormString, validString),
    () => validateStandard(valibotString, validString),
    () => validateStandard(zodString, validString),
    100000
  )
);

results.push(
  runBenchmark(
    "Number validation",
    () => validateStandard(vibormNumber, validNumber),
    () => validateStandard(valibotNumber, validNumber),
    () => validateStandard(zodNumber, validNumber),
    100000
  )
);

results.push(
  runBenchmark(
    "Boolean validation",
    () => validateStandard(vibormBoolean, validBoolean),
    () => validateStandard(valibotBoolean, validBoolean),
    () => validateStandard(zodBoolean, validBoolean),
    100000
  )
);

results.push(
  runBenchmark(
    "BigInt validation",
    () => validateStandard(vibormBigint, validBigint),
    () => validateStandard(valibotBigint, validBigint),
    () => validateStandard(zodBigint, validBigint),
    100000
  )
);

results.push(
  runBenchmark(
    "Literal validation",
    () => validateStandard(vibormLiteral, "admin"),
    () => validateStandard(valibotLiteral, "admin"),
    () => validateStandard(zodLiteral, "admin"),
    100000
  )
);

// ==================== OBJECT VALIDATION ====================
console.log("Testing object validation...");

results.push(
  runBenchmark(
    "Simple Object (4 fields)",
    () => validateStandard(vibormSimpleUser, validSimpleUser),
    () => validateStandard(valibotSimpleUser, validSimpleUser),
    () => validateStandard(zodSimpleUser, validSimpleUser),
    50000
  )
);

results.push(
  runBenchmark(
    "Complex Object (nested)",
    () => validateStandard(vibormComplexUser, validComplexUser),
    () => validateStandard(valibotComplexUser, validComplexUser),
    () => validateStandard(zodComplexUser, validComplexUser),
    20000
  )
);

results.push(
  runBenchmark(
    "Nullable/Optional Object",
    () => validateStandard(vibormNullableOptional, validNullableOptional),
    () => validateStandard(valibotNullableOptional, validNullableOptional),
    () => validateStandard(zodNullableOptional, validNullableOptional),
    50000
  )
);

// ==================== ARRAY VALIDATION ====================
console.log("Testing array validation...");

results.push(
  runBenchmark(
    "Array of 10 Objects",
    () => validateStandard(vibormPosts, validPosts),
    () => validateStandard(valibotPosts, validPosts),
    () => validateStandard(zodPosts, validPosts),
    10000
  )
);

results.push(
  runBenchmark(
    "Array of 100 Strings",
    () => validateStandard(vibormStringArray, validStringArray100),
    () => validateStandard(valibotStringArray, validStringArray100),
    () => validateStandard(zodStringArray, validStringArray100),
    10000
  )
);

// ==================== UNION VALIDATION ====================
console.log("Testing union validation...");

results.push(
  runBenchmark(
    "Union (first match)",
    () => validateStandard(vibormUnion, "hello"),
    () => validateStandard(valibotUnion, "hello"),
    () => validateStandard(zodUnion, "hello"),
    100000
  )
);

results.push(
  runBenchmark(
    "Union (last match)",
    () => validateStandard(vibormUnion, true),
    () => validateStandard(valibotUnion, true),
    () => validateStandard(zodUnion, true),
    100000
  )
);

// ==================== ERROR PATH ====================
console.log("Testing error path...");

results.push(
  runBenchmark(
    "Invalid data (fail-fast)",
    () => validateStandard(vibormSimpleUser, invalidSimpleUser),
    () => validateStandard(valibotSimpleUser, invalidSimpleUser),
    () => validateStandard(zodSimpleUser, invalidSimpleUser),
    50000
  )
);

// ==================== SCHEMA INSTANTIATION ====================
console.log("Testing schema instantiation...");

results.push(
  runBenchmark(
    "Create string schema",
    () => v.string(),
    () => valibot.string(),
    () => z.string(),
    100000
  )
);

results.push(
  runBenchmark(
    "Create simple object schema",
    () =>
      v.object(
        { id: v.string(), name: v.string(), age: v.number() },
        { partial: false }
      ),
    () =>
      valibot.object({
        id: valibot.string(),
        name: valibot.string(),
        age: valibot.number(),
      }),
    () => z.object({ id: z.string(), name: z.string(), age: z.number() }),
    20000
  )
);

results.push(
  runBenchmark(
    "Create array schema",
    () => v.string({ array: true }),
    () => valibot.array(valibot.string()),
    () => z.array(z.string()),
    50000
  )
);

printResults(results);
