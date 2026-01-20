import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Collect spans in memory so we can display them
const spanExporter = new InMemorySpanExporter();

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "viborm-demo",
  }),
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

sdk.start();

// ANSI color codes
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
};

function printTraceTable() {
  const spans = spanExporter.getFinishedSpans();

  if (spans.length === 0) {
    console.log("\nNo traces collected.\n");
    return;
  }

  // Group spans by traceId
  type SpanData = {
    name: string;
    duration: number;
    model: string;
    operation: string;
    sql?: string;
    parentId?: string;
    id: string;
    startTime: number;
    cacheResult?: string;
    cacheKey?: string;
    status: number;
  };

  const traceGroups = new Map<string, SpanData[]>();

  for (const span of spans) {
    const traceId = span.spanContext().traceId;
    if (!traceGroups.has(traceId)) {
      traceGroups.set(traceId, []);
    }
    // Use parentSpanContext?.spanId as parentSpanId getter is not always available
    const parentId = (span as any).parentSpanContext?.spanId as
      | string
      | undefined;
    traceGroups.get(traceId)!.push({
      name: span.name,
      duration: span.duration[1] / 1000, // nanoseconds to microseconds
      model: (span.attributes["db.collection.name"] as string) || "-",
      operation: (span.attributes["db.operation.name"] as string) || "-",
      sql: span.attributes["db.query.text"] as string | undefined,
      parentId,
      id: span.spanContext().spanId,
      startTime: span.startTime[0] * 1e9 + span.startTime[1], // convert to nanoseconds
      cacheResult: span.attributes["cache.result"] as string | undefined,
      cacheKey: span.attributes["cache.key"] as string | undefined,
      status: span.status.code,
    });
  }

  console.log(`\n${c.bgBlue}${c.white}${c.bold} TRACE SUMMARY ${c.reset}\n`);

  // Table header
  const header = `${c.bold}| ${"Span Name".padEnd(25)} | ${"Duration".padStart(10)} | ${"Model".padEnd(8)} | ${"Operation".padEnd(10)} | ${"Info".padEnd(12)} |${c.reset}`;
  const separator = `${c.dim}|${"-".repeat(27)}|${"-".repeat(12)}|${"-".repeat(10)}|${"-".repeat(12)}|${"-".repeat(14)}|${c.reset}`;

  let traceNum = 1;
  for (const [traceId, traceSpans] of traceGroups) {
    // Build a tree structure based on parent-child relationships
    const spanById = new Map(traceSpans.map((s) => [s.id, s]));
    const rootSpans = traceSpans.filter(
      (s) => !(s.parentId && spanById.has(s.parentId))
    );
    const childrenOf = (parentId: string) =>
      traceSpans
        .filter((s) => s.parentId === parentId)
        .sort((a, b) => a.startTime - b.startTime);

    // Flatten tree in depth-first order
    const orderedSpans: Array<{ span: (typeof traceSpans)[0]; depth: number }> =
      [];
    const visit = (span: (typeof traceSpans)[0], depth: number) => {
      orderedSpans.push({ span, depth });
      for (const child of childrenOf(span.id)) {
        visit(child, depth + 1);
      }
    };
    for (const root of rootSpans.sort((a, b) => a.startTime - b.startTime)) {
      visit(root, 0);
    }

    console.log(
      `${c.cyan}${c.bold}Trace #${traceNum}${c.reset} ${c.gray}(${traceId.slice(0, 16)}...)${c.reset}`
    );
    console.log(separator);
    console.log(header);
    console.log(separator);

    for (const { span, depth } of orderedSpans) {
      const indent = "  ".repeat(depth);
      const nameColor = depth > 0 ? c.dim : c.white;
      const name = (indent + span.name).padEnd(25);
      const duration = formatDuration(span.duration).padStart(10);
      const model = span.model.padEnd(8);
      const operation = span.operation.padEnd(10);

      // Build info column (cache result, status, etc.)
      let info = "";
      if (span.cacheResult) {
        info = span.cacheResult;
      } else if (span.status !== 1) {
        // 1 = OK, 2 = ERROR
        info = span.status === 2 ? "error" : "";
      }
      const infoStr = info.padEnd(12);

      // Color duration based on speed
      let durationColor = c.green;
      if (span.duration > 1000) durationColor = c.yellow;
      if (span.duration > 10_000) durationColor = c.magenta;

      // Color info based on cache result
      let infoColor = c.gray;
      if (span.cacheResult === "hit") infoColor = c.green;
      if (span.cacheResult === "miss") infoColor = c.yellow;
      if (span.cacheResult === "stale") infoColor = c.magenta;
      if (span.status === 2) infoColor = c.magenta;

      console.log(
        `| ${nameColor}${name}${c.reset} | ${durationColor}${duration}${c.reset} | ${c.blue}${model}${c.reset} | ${c.cyan}${operation}${c.reset} | ${infoColor}${infoStr}${c.reset}|`
      );

      // Show SQL for driver.execute spans
      if (span.sql) {
        const truncatedSql =
          span.sql.length > 80 ? span.sql.slice(0, 77) + "..." : span.sql;
        console.log(`${c.dim}  SQL: ${truncatedSql}${c.reset}`);
      }
    }

    console.log(separator);

    // Calculate ORM overhead for this trace
    // ORM overhead = total operation time - driver.execute time - cache time
    const operationSpan = traceSpans.find((s) => s.name === "viborm.operation");
    const driverSpan = traceSpans.find(
      (s) => s.name === "viborm.driver.execute"
    );
    const cacheSpans = traceSpans.filter((s) =>
      s.name.startsWith("viborm.cache.")
    );
    const cacheDuration = cacheSpans.reduce((sum, s) => sum + s.duration, 0);

    if (operationSpan) {
      const totalTime = operationSpan.duration;
      const dbTime = driverSpan?.duration ?? 0;
      const ormOverhead = totalTime - dbTime - cacheDuration;
      const overheadPercent = ((ormOverhead / totalTime) * 100).toFixed(1);

      console.log(
        `${c.gray}  ORM Overhead: ${c.yellow}${formatDuration(ormOverhead)}${c.gray} (${overheadPercent}% of total)${c.reset}`
      );
      if (driverSpan) {
        console.log(
          `${c.gray}  DB Time:      ${c.cyan}${formatDuration(dbTime)}${c.reset}`
        );
      }
      if (cacheDuration > 0) {
        console.log(
          `${c.gray}  Cache Time:   ${c.blue}${formatDuration(cacheDuration)}${c.reset}`
        );
      }
    }

    console.log();
    traceNum++;
  }

  // Summary stats
  const allDurations = spans.map((s) => s.duration[1] / 1000);
  const totalDuration = allDurations.reduce((a, b) => a + b, 0);
  const avgDuration = totalDuration / allDurations.length;
  const maxDuration = Math.max(...allDurations);
  const minDuration = Math.min(...allDurations);

  console.log(`\n${c.bold}Statistics${c.reset}`);
  console.log(`${c.dim}${"─".repeat(40)}${c.reset}`);
  console.log(`  Total Spans:    ${c.cyan}${spans.length}${c.reset}`);
  console.log(`  Total Traces:   ${c.cyan}${traceGroups.size}${c.reset}`);
  console.log(
    `  Avg Duration:   ${c.yellow}${formatDuration(avgDuration)}${c.reset}`
  );
  console.log(
    `  Min Duration:   ${c.green}${formatDuration(minDuration)}${c.reset}`
  );
  console.log(
    `  Max Duration:   ${c.magenta}${formatDuration(maxDuration)}${c.reset}`
  );
  console.log();
}

function formatDuration(microseconds: number): string {
  if (microseconds < 1000) {
    return `${microseconds.toFixed(1)} us`;
  }
  if (microseconds < 1_000_000) {
    return `${(microseconds / 1000).toFixed(2)} ms`;
  }
  return `${(microseconds / 1_000_000).toFixed(2)} s`;
}

import { MemoryCache } from "@cache";
import { PGlite } from "@electric-sql/pglite";
import { VibORM } from "./src/client/client";
import { PGliteDriver } from "./src/drivers/pglite";
import { s } from "./src/schema";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
});

const pglite = new PGlite();
const driver = new PGliteDriver({ client: pglite });
async function main() {
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `);

  const clientInstantStart = performance.now();
  const client = VibORM.create({
    schema: { user },
    driver,
    cache: new MemoryCache(),
    instrumentation: {
      logging: {
        query: true,
        includeParams: false,
        error: true,
        cache: true,
      },
      tracing: true,
    },
  });
  const clientInstantEnd = performance.now();
  console.log(
    `Client creation took ${clientInstantEnd - clientInstantStart}ms`
  );

  console.log("\n--- findMany ---\n");

  await client.user.findMany({
    where: {
      AND: [
        {
          email: {
            contains: "example.com",
          },
          id: {
            endsWith: "123",
          },
        },
      ],
      OR: [
        {
          name: {
            startsWith: "Alice",
          },
        },
      ],
    },
  });
  await client
    .$withCache({ key: "users", ttl: "1 second", swr: true })
    .user.findMany();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await client.$withCache({ key: "users", swr: true }).user.findMany();

  await client.$transaction(async (tx) => {
    await tx.user.create({
      data: { id: "user-1", name: "Alice", email: "alice@example.com" },
    });

    const u = await tx.user.findUnique({
      where: { id: "user-1" },
    });

    console.log(u);
  });

  // console.log("\n--- create ---\n");
  // await client.user.create({
  //   data: { id: "user-1", name: "Alice", email: "alice@example.com" },
  // });

  // console.log("\n--- findMany with where ---\n");
  // await client.user.findMany({ where: { name: "Alice" } });

  // await client.$transaction(async (tx) => {
  //   await tx.user.findMany({});

  //   await tx.user.create({
  //     data: { id: "user-1", name: "Bob", email: "bob@example.com" },
  //   });
  // });

  // Wait for async revalidation to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Print trace summary table
  printTraceTable();

  // Gracefully shutdown
  await sdk.shutdown();
}

await main();

const withoutInstrumentation = async () => {
  const client = VibORM.create({
    schema: { user },
    driver,
    cache: new MemoryCache(),
  });

  console.log("\n--- Benchmark (no instrumentation) ---\n");

  // Initial cache miss
  await client
    .$withCache({ key: "users", ttl: "10ms", swr: true })
    .user.findMany();

  // Wait for cache to become stale
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Warmup iterations
  const warmupIterations = 10;
  for (let i = 0; i < warmupIterations; i++) {
    await client.$withCache({ key: "users", swr: true }).user.findMany();
  }

  // Wait for any background revalidations to settle
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Make cache stale again
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Benchmark iterations
  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await client.$withCache({ key: "users", swr: true }).user.findMany();
  }
  const end = performance.now();

  const avgTime = (end - start) / iterations;
  console.log(
    `Stale cache hit (avg of ${iterations} iterations): ${avgTime.toFixed(3)}ms`
  );
};

await withoutInstrumentation();
