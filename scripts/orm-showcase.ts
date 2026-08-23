/**
 * VibORM query, insert, logging, SQL, and OpenTelemetry showcase.
 *
 * Run from the repository root:
 *   bun run scripts/orm-showcase.ts
 */

import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { createClient } from "../src/drivers/pglite";
import { push } from "../src/migrations";
import { s } from "../src/schema";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    posts: s.toMany(() => post),
  })
  .map("showcase_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean().default(false),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    comments: s.toMany(() => comment),
  })
  .map("showcase_posts");

const comment = s
  .model({
    id: s.string().id(),
    body: s.string(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("showcase_comments");

const schema = { user, post, comment };

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
tracerProvider.register();

let isShowcaseRunning = false;
const orm = createClient({
  schema,
  instrumentation: {
    logging: {
      includeSql: true,
      includeParams: true,
      query: (_event, log) => {
        if (isShowcaseRunning) log();
      },
      warning: true,
      error: true,
    },
    tracing: {
      includeSql: true,
      includeParams: true,
    },
  },
});

async function main(): Promise<void> {
  console.log("\nVibORM ORM showcase");
  console.log("Database: in-memory PGlite (no setup required)");
  console.log(
    "SQL parameters are visible because this uses demo-only values.\n"
  );

  try {
    await push(orm, { force: true });
    await tracerProvider.forceFlush();
    spanExporter.reset();
    isShowcaseRunning = true;

    await showcase("1. SIMPLE INSERT — create one user", () =>
      orm.user.create({
        data: {
          id: "user-alice",
          name: "Alice",
          email: "alice@viborm.dev",
        },
      })
    );

    await showcase("2. SIMPLE QUERY — unique email lookup", () =>
      orm.user.findUnique({
        where: { email: "alice@viborm.dev" },
        select: { id: true, name: true, email: true },
      })
    );

    await showcase(
      "3. COMPLEX INSERT — user, posts, and comments in one nested write",
      () =>
        orm.user.create({
          data: {
            id: "user-bob",
            name: "Bob",
            email: "bob@acme.dev",
            posts: {
              create: [
                {
                  id: "post-observability",
                  title: "Observability without guesswork",
                  published: true,
                  views: 420,
                  comments: {
                    create: [
                      { id: "comment-1", body: "The trace tree is excellent." },
                      { id: "comment-2", body: "Show me the generated SQL." },
                    ],
                  },
                },
                {
                  id: "post-types",
                  title: "Types without code generation",
                  published: true,
                  views: 180,
                  comments: {
                    create: {
                      id: "comment-3",
                      body: "The inferred result shape is the best part.",
                    },
                  },
                },
                {
                  id: "post-draft",
                  title: "A private draft",
                  views: 12,
                },
              ],
            },
          },
          include: {
            posts: {
              orderBy: { views: "desc" },
              include: { comments: { orderBy: { id: "asc" } } },
            },
          },
        })
    );

    await showcase(
      "4. COMPLEX QUERY — relation filter plus deep, filtered includes",
      () =>
        orm.user.findMany({
          where: {
            OR: [
              { email: "alice@viborm.dev" },
              {
                posts: {
                  some: { published: true, views: { gte: 100 } },
                },
              },
            ],
          },
          orderBy: { name: "asc" },
          include: {
            posts: {
              where: { published: true },
              orderBy: { views: "desc" },
              take: 2,
              include: { comments: { orderBy: { id: "asc" } } },
            },
          },
        })
    );
  } finally {
    isShowcaseRunning = false;
    try {
      await orm.$disconnect();
    } finally {
      await tracerProvider.shutdown();
      trace.disable();
    }
  }
}

async function showcase<T>(
  title: string,
  operation: () => PromiseLike<T>
): Promise<T> {
  console.log(`\n${"=".repeat(88)}\n${title}\n${"=".repeat(88)}`);
  console.log("\nInstrumentation query log and generated SQL:");

  const firstSpanIndex = spanExporter.getFinishedSpans().length;
  const operationValue = await operation();
  await tracerProvider.forceFlush();

  console.log("\nResult:");
  console.log(JSON.stringify(operationValue, null, 2));
  console.log("\nOpenTelemetry trace:");
  printTrace(spanExporter.getFinishedSpans().slice(firstSpanIndex));

  return operationValue;
}

function printTrace(spans: ReadableSpan[]): void {
  const spanIds = new Set(spans.map((span) => span.spanContext().spanId));
  const childrenByParentId = new Map<string, ReadableSpan[]>();

  for (const span of spans) {
    const parentId = span.parentSpanContext?.spanId;
    if (!(parentId && spanIds.has(parentId))) continue;

    const siblings = childrenByParentId.get(parentId);
    if (siblings) {
      siblings.push(span);
    } else {
      childrenByParentId.set(parentId, [span]);
    }
  }

  const roots = spans.filter((span) => {
    const parentId = span.parentSpanContext?.spanId;
    return !(parentId && spanIds.has(parentId));
  });

  if (roots.length === 0) {
    console.log("  No spans were exported.");
    return;
  }

  for (const root of roots) {
    console.log(`  trace ${root.spanContext().traceId}`);
    printSpan(root, childrenByParentId, "    ");
  }
}

function printSpan(
  span: ReadableSpan,
  childrenByParentId: Map<string, ReadableSpan[]>,
  indent: string
): void {
  const collection = span.attributes["db.collection.name"];
  const operation = span.attributes["db.operation.name"];
  const target = [collection, operation].filter(Boolean).join(".");
  const context = target ? ` · ${target}` : "";
  const duration = hrTimeToMilliseconds(span.duration).toFixed(2);
  const status = ["UNSET", "OK", "ERROR"][span.status.code] ?? span.status.code;

  console.log(`${indent}${span.name}${context} · ${duration} ms · ${status}`);

  const sql = span.attributes["db.query.text"];
  if (typeof sql === "string") {
    console.log(`${indent}  sql: ${sql}`);
  }

  const parameterPrefix = "db.query.parameter.";
  const parameters = Object.entries(span.attributes)
    .filter(([key]) => key.startsWith(parameterPrefix))
    .sort(
      ([left], [right]) =>
        Number(left.slice(parameterPrefix.length)) -
        Number(right.slice(parameterPrefix.length))
    )
    .map(([, value]) => value);
  if (parameters.length > 0) {
    console.log(`${indent}  params: ${JSON.stringify(parameters)}`);
  }

  const childIndent = `${indent}  `;
  for (const child of childrenByParentId.get(span.spanContext().spanId) ?? []) {
    printSpan(child, childrenByParentId, childIndent);
  }
}

function hrTimeToMilliseconds([seconds, nanoseconds]: [
  number,
  number,
]): number {
  return seconds * 1000 + nanoseconds / 1_000_000;
}

await main();
