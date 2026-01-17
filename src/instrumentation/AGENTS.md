# Instrumentation - Tracing & Logging

**Location:** `src/instrumentation/`
**Layer:** L11 - Instrumentation (see [root AGENTS.md](../../AGENTS.md))

## Purpose

Provides observability for VibORM through OpenTelemetry tracing and structured logging. Instrumentation is opt-in, has zero overhead when disabled, and gracefully handles missing OTel dependencies.

## Why This Layer Exists

Production ORMs need observability:

1. **Performance debugging** - Identify slow queries, N+1 problems, cache misses
2. **Distributed tracing** - Trace requests across services with proper span parenting
3. **Structured logging** - Query logs, cache events, errors with consistent format
4. **Zero-cost when disabled** - No performance impact if not configured

```typescript
// Enable tracing and logging
const client = createClient({
  schema,
  driver,
  instrumentation: {
    tracing: { includeSql: true, includeParams: false },
    logging: { query: true, cache: true, error: true },
  },
});

// Spans are automatically created:
// viborm.operation (findMany)
//   └── viborm.validate
//   └── viborm.build
//   └── viborm.execute
//        └── viborm.driver.execute
//   └── viborm.parse
```

---

## Entry Points

| File | Purpose | Modify When |
|------|---------|-------------|
| `context.ts` | `InstrumentationContext` - combines tracer + logger | Changing how context is created/passed |
| `tracer.ts` | `TracerWrapper` - OpenTelemetry span management | Changing tracing behavior |
| `logger.ts` | `Logger` - structured console/callback logging | Changing log format or levels |
| `spans.ts` | Span names and attribute constants | Adding new span types or attributes |
| `types.ts` | Configuration interfaces | Adding new config options |
| `index.ts` | Public exports | Adding new exports |

---

## Core Concepts

### Instrumentation Context

All instrumentation flows through a single context object:

```typescript
interface InstrumentationContext {
  config: InstrumentationConfig;     // Original user config
  tracer?: TracerWrapper;            // Tracer (if tracing enabled)
  logger?: Logger;                   // Logger (if logging enabled)
}
```

Context is created once at client initialization and passed to all layers (query engine, cache, drivers) via `setInstrumentation()`.

### Tracer Wrapper

Wraps OpenTelemetry API with graceful fallback:

```typescript
const tracer = createTracerWrapper({ includeSql: true });

// Async span (most common)
await tracer.startActiveSpan({
  name: SPAN_OPERATION,
  attributes: { [ATTR_DB_COLLECTION]: "user" },
}, async (span) => {
  // Code runs inside span context
  // Child spans automatically parented
});

// Sync span (for non-async code paths)
tracer.startActiveSpanSync({ name: SPAN_VALIDATE }, (span) => {
  // Synchronous operation
});
```

**Key behaviors:**
- OTel is dynamically imported (optional peer dependency)
- If OTel unavailable, callbacks execute without spans (no-op)
- `context.with()` ensures proper parent-child relationships
- `root: true` option starts a new trace (for background revalidation)

### Logger

Structured logging with pretty console output or custom callbacks:

```typescript
const logger = createLogger({
  query: true,                           // Pretty console
  cache: (event, log) => {               // Custom handler
    metrics.recordCacheEvent(event);
    log();                               // Also use default formatter
  },
  error: true,
});

logger.query({
  timestamp: new Date(),
  model: "user",
  operation: "findMany",
  duration: 12,
  sql: "SELECT ...",
});
```

**Log levels:** `query`, `cache`, `warning`, `error`

### Span Names

All spans follow the `viborm.*` naming convention:

| Span | Description | Parent |
|------|-------------|--------|
| `viborm.operation` | High-level client operation | Request/transaction |
| `viborm.validate` | Input validation | operation |
| `viborm.build` | SQL building | operation |
| `viborm.execute` | Query execution wrapper | operation |
| `viborm.driver.execute` | Actual database round-trip | execute |
| `viborm.parse` | Result hydration | operation |
| `viborm.transaction` | Transaction boundary | Request |
| `viborm.cache.get` | Cache read | operation |
| `viborm.cache.set` | Cache write | operation |

### Attributes

Follow OTel semantic conventions where possible:

```typescript
// Standard OTel attributes
ATTR_DB_SYSTEM        // "postgresql", "mysql", "sqlite"
ATTR_DB_COLLECTION    // Table name
ATTR_DB_OPERATION_NAME // Operation type
ATTR_DB_QUERY_TEXT    // SQL query (if includeSql)

// VibORM custom attributes
ATTR_DB_DRIVER        // Driver name ("pg", "mysql2", etc.)
ATTR_CACHE_DRIVER     // Cache driver ("memory", "cloudflare-kv")
ATTR_CACHE_RESULT     // "hit", "miss", "stale", "bypass"
```

---

## Core Rules

### Rule 1: Optional Dependency
OpenTelemetry is a peer dependency, not required. All tracing code must handle missing OTel gracefully:

```typescript
// OTel is dynamically imported
const otel = await import("@opentelemetry/api").catch(() => null);
if (!otel) return fn();  // Execute without tracing
```

### Rule 2: Instance-Scoped State
All mutable state lives inside `createTracerWrapper()` closure, not at module level. This ensures serverless compatibility (Cloudflare Workers, Lambda).

```typescript
// ✅ Correct: state inside closure
function createTracerWrapper() {
  let otel: OTelAPI | null = null;  // Instance-scoped
  // ...
}

// ❌ Wrong: module-level state
let globalOtel: OTelAPI | null = null;  // Breaks serverless
```

### Rule 3: Eager OTel Loading
OTel is loaded once when tracer is created, not on every span:

```typescript
// Load once at creation
const otelReady = tryLoadOtel();

// Subsequent spans just check cached value
async startActiveSpan(options, fn) {
  if (!otel) await otelReady;  // Only waits on first call
  // ...
}
```

### Rule 4: Context Propagation
Always use `context.with()` to ensure proper span parenting:

```typescript
// ✅ Correct: child spans are properly parented
return otel.context.with(contextWithSpan, async () => {
  await childOperation();  // Gets current span as parent
});

// ❌ Wrong: breaks parent-child relationship
span.end();
await childOperation();  // No parent context
```

### Rule 5: SQL Sensitivity
SQL and params are opt-in via config to prevent accidental PII exposure:

```typescript
tracing: {
  includeSql: true,      // Show SQL in traces (default: true)
  includeParams: false,  // Show params in traces (default: false - PII risk!)
}
```

---

## Anti-Patterns

### Awaiting OTel on Every Span
```typescript
// ❌ Wrong: loads OTel on every span
async startActiveSpan() {
  const otel = await import("@opentelemetry/api");  // Slow!
}

// ✅ Correct: load once, cache result
const otelReady = tryLoadOtel();
async startActiveSpan() {
  if (!otel) await otelReady;
}
```

### Module-Level Mutable State
```typescript
// ❌ Wrong: persists across requests in serverless
let tracer: Tracer;

// ✅ Correct: scoped to instance
function createTracerWrapper() {
  let tracer: Tracer | null = null;
}
```

### Blocking on Background Operations
```typescript
// ❌ Wrong: blocks response on tracing
const span = tracer.startSpan();
await backgroundWork();
span.end();
return response;

// ✅ Correct: fire-and-forget for background work
const promise = tracer.startActiveSpan({ root: true }, async () => {
  await backgroundWork();
});
waitUntil?.(promise);
return response;
```

### Missing Span Status on Error
```typescript
// ❌ Wrong: span shows success even on error
try {
  await operation();
} catch (e) {
  throw e;  // Span has no error status
}

// ✅ Correct: set error status before rethrowing
try {
  await operation();
  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.recordException(error);
  throw error;
}
```

---

## Adding New Instrumentation

### Adding a New Span Type

1. **Add constant to `spans.ts`**:
   ```typescript
   export const SPAN_MY_OPERATION = "viborm.my.operation";
   ```

2. **Add to `VibORMSpanName` union**:
   ```typescript
   export type VibORMSpanName =
     | typeof SPAN_OPERATION
     | typeof SPAN_MY_OPERATION  // Add here
     // ...
   ```

3. **Use in code**:
   ```typescript
   await ctx.instrumentation?.tracer?.startActiveSpan({
     name: SPAN_MY_OPERATION,
     attributes: { /* ... */ },
   }, async (span) => {
     // Operation code
   });
   ```

### Adding a New Attribute

1. **Add constant to `spans.ts`**:
   ```typescript
   export const ATTR_MY_CUSTOM = "viborm.my.custom";
   ```

2. **Use in span creation**:
   ```typescript
   attributes: {
     [ATTR_MY_CUSTOM]: value,
   }
   ```

### Adding a New Log Level

1. **Add to `LogLevel` type** in `types.ts`:
   ```typescript
   export type LogLevel = "query" | "cache" | "warning" | "error" | "myLevel";
   ```

2. **Add handler in `LoggingConfig`**:
   ```typescript
   myLevel?: LogLevelHandler | undefined;
   ```

3. **Add method to `Logger`** in `logger.ts`:
   ```typescript
   myLevel(event: Omit<LogEvent, "level">): void {
     emit({ ...event, level: "myLevel" });
   }
   ```

4. **Add pretty formatter case** in `prettyLog()`.

---

## Invisible Knowledge

### Why Dynamic Import for OTel
OTel is optional - many users don't need tracing. Static import would fail if `@opentelemetry/api` isn't installed. Dynamic import with catch allows graceful degradation.

### Why Root Span for Background Revalidation
SWR revalidation happens after the response is sent. If we don't use `root: true`, the span would be orphaned (parent trace already ended). Starting a new root trace keeps the span hierarchy clean.

### Why Separate Tracer and Logger
They serve different purposes: tracing is for distributed tracing systems (Jaeger, Zipkin), logging is for local debugging and monitoring. Users may want one without the other.

### Why Default includeSql=true, includeParams=false
SQL queries are generally safe to log and extremely useful for debugging. Parameters might contain PII (user data, API keys), so they're opt-in only.

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **Client** ([client/AGENTS.md](../client/AGENTS.md)) | Creates instrumentation context, wraps operations |
| **Query Engine** | Emits build/validate/parse spans |
| **Cache** ([cache/AGENTS.md](../cache/AGENTS.md)) | Emits cache get/set/invalidate spans |
| **Drivers** | Emits driver.execute spans |
