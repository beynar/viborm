/**
 * Validation Library Benchmark
 * Compares VibORM, Valibot, Zod, and ArkType performance on ORM-like schemas
 *
 * All libraries are tested using their StandardSchema (~standard.validate) interface
 * for a fair comparison.
 *
 * Zod JIT is DISABLED for fair comparison - Zod v4 is the only library that uses
 * JIT compilation (eval/new Function). Disabling it levels the playing field
 * and also simulates edge environments like Cloudflare Workers.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type } from "arktype";
import { configure } from "arktype/config";
import * as valibot from "valibot";
import { z } from "zod";
import { v } from "../src/validation";

configure({ jitless: true });

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

function benchmark(name: string, fn: () => void, iterations = 10_000): number {
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
  if (ops > 1000) return (ops / 1000).toFixed(2) + "K ops/s";
  return ops.toFixed(2) + " ops/s";
}

interface BenchmarkResult {
  name: string;
  viborm: number;
  valibot: number;
  zod: number;
  arktype: number;
  iterations: number;
}

function runBenchmark(
  name: string,
  vibormFn: () => void,
  valibotFn: () => void,
  zodFn: () => void,
  arktypeFn: () => void,
  iterations = 10_000
): BenchmarkResult {
  return {
    name,
    viborm: benchmark("viborm", vibormFn, iterations),
    valibot: benchmark("valibot", valibotFn, iterations),
    zod: benchmark("zod", zodFn, iterations),
    arktype: benchmark("arktype", arktypeFn, iterations),
    iterations,
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log("\n" + "=".repeat(80));
  console.log("VALIDATION BENCHMARK RESULTS (Zod JIT disabled)");
  console.log("=".repeat(80) + "\n");

  for (const r of results) {
    const fastest = Math.min(r.viborm, r.valibot, r.zod, r.arktype);
    const vibormRatio = (r.viborm / fastest).toFixed(2);
    const valibotRatio = (r.valibot / fastest).toFixed(2);
    const zodRatio = (r.zod / fastest).toFixed(2);
    const arktypeRatio = (r.arktype / fastest).toFixed(2);

    console.log(`📊 ${r.name} (${r.iterations.toLocaleString()} iterations)`);
    console.log("-".repeat(70));
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
    console.log(
      `  ArkType: ${formatMs(r.arktype).padEnd(12)} ${formatOpsPerSec(
        r.arktype,
        r.iterations
      ).padEnd(15)} ${
        arktypeRatio === "1.00" ? "🏆 fastest" : `${arktypeRatio}x slower`
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
    zodWins = 0,
    arktypeWins = 0;
  for (const r of results) {
    const fastest = Math.min(r.viborm, r.valibot, r.zod, r.arktype);
    if (r.viborm === fastest) vibormWins++;
    if (r.valibot === fastest) valibotWins++;
    if (r.zod === fastest) zodWins++;
    if (r.arktype === fastest) arktypeWins++;
  }

  console.log(`  VibORM wins:  ${vibormWins}/${results.length}`);
  console.log(`  Valibot wins: ${valibotWins}/${results.length}`);
  console.log(`  Zod wins:     ${zodWins}/${results.length}`);
  console.log(`  ArkType wins: ${arktypeWins}/${results.length}`);
}

// =============================================================================
// Pre-created Schemas for Validation Tests
// =============================================================================

const vibormString = v.string();
const valibotString = valibot.string();
const zodString = z.string();
const arktypeString = type("string");

const vibormNumber = v.number();
const valibotNumber = valibot.number();
const zodNumber = z.number();
const arktypeNumber = type("number");

const vibormBoolean = v.boolean();
const valibotBoolean = valibot.boolean();
const zodBoolean = z.boolean();
const arktypeBoolean = type("boolean");

const vibormBigint = v.bigint();
const valibotBigint = valibot.bigint();
const zodBigint = z.bigint();
const arktypeBigint = type("bigint");

const vibormLiteral = v.literal("admin");
const valibotLiteral = valibot.literal("admin");
const zodLiteral = z.literal("admin");
const arktypeLiteral = type("'admin'");

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

const arktypeSimpleUser = type({
  id: "string",
  name: "string",
  age: "number",
  active: "boolean",
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

const arktypeComplexUser = type({
  id: "string",
  email: "string",
  name: "string",
  "age?": "number",
  role: "'admin' | 'user' | 'guest'",
  tags: "string[]",
  metadata: {
    createdAt: "string",
    updatedAt: "string",
    version: "number",
  },
  settings: {
    "theme?": "'light'",
    "notifications?": "boolean",
  },
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

const arktypePost = type({
  id: "string",
  title: "string",
  content: "string",
  published: "boolean",
  likes: "number",
});
const arktypePosts = arktypePost.array();

// Large array of strings
const vibormStringArray = v.array(v.string());
const valibotStringArray = valibot.array(valibot.string());
const zodStringArray = z.array(z.string());
const arktypeStringArray = type("string[]");

// Union schema
const vibormUnion = v.union([v.string(), v.number(), v.boolean()]);
const valibotUnion = valibot.union([
  valibot.string(),
  valibot.number(),
  valibot.boolean(),
]);
const zodUnion = z.union([z.string(), z.number(), z.boolean()]);
const arktypeUnion = type("string | number | boolean");

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

const arktypeNullableOptional = type({
  required: "string",
  "optional?": "string",
  nullable: "string | null",
  "both?": "string | null",
});

// =============================================================================
// Test Data
// =============================================================================

const validString = "hello world";
const validNumber = 42;
const validBoolean = true;
const validBigint = BigInt(9_007_199_254_740_991);

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
// console.log("Testing primitive validation...");

// results.push(
//   runBenchmark(
//     "String validation",
//     () => validateStandard(vibormString, validString),
//     () => validateStandard(valibotString, validString),
//     () => validateStandard(zodString, validString),
//     () => validateStandard(arktypeString, validString),
//     100000
//   )
// );

// results.push(
//   runBenchmark(
//     "Number validation",
//     () => validateStandard(vibormNumber, validNumber),
//     () => validateStandard(valibotNumber, validNumber),
//     () => validateStandard(zodNumber, validNumber),
//     () => validateStandard(arktypeNumber, validNumber),
//     100000
//   )
// );

// results.push(
//   runBenchmark(
//     "Boolean validation",
//     () => validateStandard(vibormBoolean, validBoolean),
//     () => validateStandard(valibotBoolean, validBoolean),
//     () => validateStandard(zodBoolean, validBoolean),
//     () => validateStandard(arktypeBoolean, validBoolean),
//     100000
//   )
// );

// results.push(
//   runBenchmark(
//     "BigInt validation",
//     () => validateStandard(vibormBigint, validBigint),
//     () => validateStandard(valibotBigint, validBigint),
//     () => validateStandard(zodBigint, validBigint),
//     () => validateStandard(arktypeBigint, validBigint),
//     100000
//   )
// );

// results.push(
//   runBenchmark(
//     "Literal validation",
//     () => validateStandard(vibormLiteral, "admin"),
//     () => validateStandard(valibotLiteral, "admin"),
//     () => validateStandard(zodLiteral, "admin"),
//     () => validateStandard(arktypeLiteral, "admin"),
//     100000
//   )
// );

// ==================== OBJECT VALIDATION ====================
console.log("Testing object validation...");

results.push(
  runBenchmark(
    "Simple Object (4 fields)",
    () => validateStandard(vibormSimpleUser, validSimpleUser),
    () => validateStandard(valibotSimpleUser, validSimpleUser),
    () => validateStandard(zodSimpleUser, validSimpleUser),
    () => validateStandard(arktypeSimpleUser, validSimpleUser),
    50_000
  )
);

results.push(
  runBenchmark(
    "Complex Object (nested)",
    () => validateStandard(vibormComplexUser, validComplexUser),
    () => validateStandard(valibotComplexUser, validComplexUser),
    () => validateStandard(zodComplexUser, validComplexUser),
    () => validateStandard(arktypeComplexUser, validComplexUser),
    20_000
  )
);

results.push(
  runBenchmark(
    "Nullable/Optional Object",
    () => validateStandard(vibormNullableOptional, validNullableOptional),
    () => validateStandard(valibotNullableOptional, validNullableOptional),
    () => validateStandard(zodNullableOptional, validNullableOptional),
    () => validateStandard(arktypeNullableOptional, validNullableOptional),
    50_000
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
    () => validateStandard(arktypePosts, validPosts),
    10_000
  )
);

results.push(
  runBenchmark(
    "Array of 100 Strings",
    () => validateStandard(vibormStringArray, validStringArray100),
    () => validateStandard(valibotStringArray, validStringArray100),
    () => validateStandard(zodStringArray, validStringArray100),
    () => validateStandard(arktypeStringArray, validStringArray100),
    10_000
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
    () => validateStandard(arktypeUnion, "hello"),
    100_000
  )
);

results.push(
  runBenchmark(
    "Union (last match)",
    () => validateStandard(vibormUnion, true),
    () => validateStandard(valibotUnion, true),
    () => validateStandard(zodUnion, true),
    () => validateStandard(arktypeUnion, true),
    100_000
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
    () => validateStandard(arktypeSimpleUser, invalidSimpleUser),
    50_000
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
    () => type("string"),
    100_000
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
    () => type({ id: "string", name: "string", age: "number" }),
    20_000
  )
);

results.push(
  runBenchmark(
    "Create array schema",
    () => v.string({ array: true }),
    () => valibot.array(valibot.string()),
    () => z.array(z.string()),
    () => type("string[]"),
    50_000
  )
);

printResults(results);

// ============================================================================
// VibORM SYNTAX COMPARISON: Options vs Wrappers
// ============================================================================
console.log("\n" + "=".repeat(80));
console.log("VibORM SYNTAX COMPARISON: Options vs Wrappers");
console.log("=".repeat(80) + "\n");

interface SyntaxResult {
  name: string;
  options: number;
  wrappers: number;
  iterations: number;
}

function benchmarkSyntax(
  name: string,
  optionsFn: () => void,
  wrappersFn: () => void,
  iterations = 100_000
): SyntaxResult {
  return {
    name,
    options: benchmark("options", optionsFn, iterations),
    wrappers: benchmark("wrappers", wrappersFn, iterations),
    iterations,
  };
}

function formatOps(ops: number): string {
  if (ops > 1_000_000) return (ops / 1_000_000).toFixed(2) + "M ops/s";
  if (ops > 1000) return (ops / 1000).toFixed(2) + "K ops/s";
  return ops.toFixed(2) + " ops/s";
}

function printSyntaxResults(results: SyntaxResult[]) {
  for (const r of results) {
    const optionsOps = (r.iterations / r.options) * 1000;
    const wrappersOps = (r.iterations / r.wrappers) * 1000;
    const faster = r.options < r.wrappers ? "options" : "wrappers";
    const ratio =
      r.options < r.wrappers ? r.wrappers / r.options : r.options / r.wrappers;

    console.log(`📊 ${r.name} (${r.iterations.toLocaleString()} iterations)`);
    console.log("-".repeat(70));
    console.log(
      `  Options:  ${r.options.toFixed(2)}ms`.padEnd(25) +
        `${formatOps(optionsOps)}`.padEnd(18) +
        (faster === "options" ? "🏆 faster" : `${ratio.toFixed(2)}x slower`)
    );
    console.log(
      `  Wrappers: ${r.wrappers.toFixed(2)}ms`.padEnd(25) +
        `${formatOps(wrappersOps)}`.padEnd(18) +
        (faster === "wrappers" ? "🏆 faster" : `${ratio.toFixed(2)}x slower`)
    );
    console.log();
  }
}

const syntaxResults: SyntaxResult[] = [];

// Schema creation comparisons
console.log("Testing schema CREATION speed...\n");

syntaxResults.push(
  benchmarkSyntax(
    "Create: nullable string",
    () => v.string({ nullable: true }),
    () => v.nullable(v.string()),
    100_000
  )
);

syntaxResults.push(
  benchmarkSyntax(
    "Create: optional string",
    () => v.string({ optional: true }),
    () => v.optional(v.string()),
    100_000
  )
);

syntaxResults.push(
  benchmarkSyntax(
    "Create: array of strings",
    () => v.string({ array: true }),
    () => v.array(v.string()),
    100_000
  )
);

syntaxResults.push(
  benchmarkSyntax(
    "Create: nullable array of strings",
    () => v.string({ array: true, nullable: true }),
    () => v.nullable(v.array(v.string())),
    100_000
  )
);

syntaxResults.push(
  benchmarkSyntax(
    "Create: optional nullable array",
    () => v.string({ array: true, nullable: true, optional: true }),
    () => v.optional(v.nullable(v.array(v.string()))),
    100_000
  )
);

syntaxResults.push(
  benchmarkSyntax(
    "Create: with default value",
    () => v.string({ default: "hello" }),
    () => v.optional(v.string(), "hello"),
    100_000
  )
);

printSyntaxResults(syntaxResults);

// Validation comparisons
console.log("Testing VALIDATION speed...\n");

const validationSyntaxResults: SyntaxResult[] = [];

// Pre-create schemas for validation benchmarks
const optionsNullableStr = v.string({ nullable: true });
const wrappersNullableStr = v.nullable(v.string());

const optionsArrayStr = v.string({ array: true });
const wrappersArrayStr = v.array(v.string());

const optionsNullableArrayStr = v.string({ array: true, nullable: true });
const wrappersNullableArrayStr = v.nullable(v.array(v.string()));

const optionsFullCombo = v.string({
  array: true,
  nullable: true,
  optional: true,
});
const wrappersFullCombo = v.optional(v.nullable(v.array(v.string())));

validationSyntaxResults.push(
  benchmarkSyntax(
    "Validate: nullable string (valid)",
    () => validateStandard(optionsNullableStr, "hello"),
    () => validateStandard(wrappersNullableStr, "hello"),
    100_000
  )
);

validationSyntaxResults.push(
  benchmarkSyntax(
    "Validate: nullable string (null)",
    () => validateStandard(optionsNullableStr, null),
    () => validateStandard(wrappersNullableStr, null),
    100_000
  )
);

validationSyntaxResults.push(
  benchmarkSyntax(
    "Validate: array of strings",
    () => validateStandard(optionsArrayStr, ["a", "b", "c"]),
    () => validateStandard(wrappersArrayStr, ["a", "b", "c"]),
    50_000
  )
);

validationSyntaxResults.push(
  benchmarkSyntax(
    "Validate: nullable array (valid array)",
    () => validateStandard(optionsNullableArrayStr, ["a", "b"]),
    () => validateStandard(wrappersNullableArrayStr, ["a", "b"]),
    50_000
  )
);

validationSyntaxResults.push(
  benchmarkSyntax(
    "Validate: nullable array (null)",
    () => validateStandard(optionsNullableArrayStr, null),
    () => validateStandard(wrappersNullableArrayStr, null),
    100_000
  )
);

validationSyntaxResults.push(
  benchmarkSyntax(
    "Validate: full combo (undefined)",
    () => validateStandard(optionsFullCombo, undefined),
    () => validateStandard(wrappersFullCombo, undefined),
    100_000
  )
);

printSyntaxResults(validationSyntaxResults);

// Summary
const allSyntax = [...syntaxResults, ...validationSyntaxResults];
const optionsWins = allSyntax.filter((r) => r.options < r.wrappers).length;
const wrappersWins = allSyntax.filter((r) => r.wrappers < r.options).length;

console.log("=".repeat(80));
console.log("SYNTAX SUMMARY");
console.log("=".repeat(80));
console.log(`  Options syntax wins:  ${optionsWins}/${allSyntax.length}`);
console.log(`  Wrappers syntax wins: ${wrappersWins}/${allSyntax.length}`);
