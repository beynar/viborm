Prisma implements OpenTelemetry through the `@prisma/instrumentation` package, which provides compliant instrumentation for Prisma Client operations. The system creates structured traces for database queries, client operations, transactions, and internal processes.

## Architecture Overview

The implementation consists of several key components:

1. **PrismaInstrumentation Class** - The main entry point that registers with OpenTelemetry [1](#0-0) 
2. **ActiveTracingHelper** - Implements the actual tracing logic and span creation [2](#0-1) 
3. **TracingHelper Interface** - Defines the contract for tracing operations [3](#0-2) 

## Setup and Configuration

To enable OpenTelemetry tracing, you need to register the instrumentation:

```typescript
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { PrismaInstrumentation } from '@prisma/instrumentation'

registerInstrumentations({
  instrumentations: [new PrismaInstrumentation()],
})
``` [4](#0-3) 

The instrumentation supports configuration options like ignoring specific span types [5](#0-4) :

```typescript
new PrismaInstrumentation({
  ignoreSpanTypes: [
    'prisma:engine:connection',
    /prisma:client:operat.*/,
    'prisma:client:compile',
    'prisma:client:db_query',
  ],
})
```

## Generated Traces

Prisma generates several types of traces:

### 1. Database Query Spans
- **Name**: `prisma:client:db_query` (client engine) or `prisma:engine:db_query` (query engine)
- **Kind**: `CLIENT`
- **Attributes**:
  - `db.query.text`: The SQL query being executed
  - `db.system.name`: Database system (postgresql, mysql, etc.) [6](#0-5) 

### 2. Operation Spans
- **Name**: `prisma:client:operation`
- **Attributes**:
  - `method`: The Prisma method (findMany, create, etc.)
  - `name`: Model and method combination (e.g., "User.findMany")
  - `model`: The model name [7](#0-6) 

### 3. Transaction Spans
- **Name**: `prisma:client:transaction`
- **Attributes**:
  - `method`: `$transaction` [8](#0-7) 

### 4. Connection Spans
- **Name**: `prisma:client:connect`
- Represents the connection establishment process [9](#0-8) 

## Trace Flow Example

Here's how a typical `findMany` operation generates traces:

```mermaid
graph TD
    A[prisma.user.findMany()] --> B[prisma:client:operation]
    B --> C[prisma:client:compile]
    B --> D[prisma:client:serialize]
    B --> E[prisma:client:db_query]
    E --> F[Actual SQL Execution]
``` [10](#0-9) 

## Implementation Details

### Dynamic Tracing Helper
The system uses a dynamic tracing helper that can be enabled/disabled at runtime [11](#0-10) . It checks for global instrumentation state and falls back to a no-op helper when disabled.

### Context Propagation
The implementation uses OpenTelemetry's context propagation system to maintain trace context across async operations [12](#0-11) .

### Sampling Support
The system respects OpenTelemetry sampling configuration. When sampling is disabled (0% ratio), no traces are generated [13](#0-12) .

## Integration Points

1. **Query Execution**: The `withQuerySpanAndEvent` function wraps database queries with tracing [14](#0-13) 
2. **Client Operations**: High-level Prisma operations are instrumented through the tracing helper
3. **Engine Communication**: The query engine integration provides additional tracing context

## Notes

- The tracing feature is part of the `tracing` preview feature and may have breaking changes
- Internal spans can be shown by setting `PRISMA_SHOW_ALL_TRACES=true` environment variable [15](#0-14) 
- The system supports both client-side and server-side tracing scenarios
- Trace context is propagated to the query engine via the `traceparent` header when sampling is enabled

Wiki pages you might want to explore:
- [Prisma Overview (prisma/prisma)](/wiki/prisma/prisma#1)

### Citations

**File:** packages/instrumentation/src/PrismaInstrumentation.ts (L18-20)
```typescript
export interface PrismaInstrumentationConfig {
  ignoreSpanTypes?: (string | RegExp)[]
}
```

**File:** packages/instrumentation/src/PrismaInstrumentation.ts (L24-39)
```typescript
export class PrismaInstrumentation extends InstrumentationBase {
  private tracerProvider: TracerProvider | undefined

  constructor(config: Config = {}) {
    super(NAME, VERSION, config)
  }

  setTracerProvider(tracerProvider: TracerProvider): void {
    this.tracerProvider = tracerProvider
  }

  init() {
    const module = new InstrumentationNodeModuleDefinition(MODULE_NAME, [VERSION])

    return [module]
  }
```

**File:** packages/instrumentation/src/ActiveTracingHelper.ts (L1-35)
```typescript
import {
  Attributes,
  Context,
  context as _context,
  Span,
  SpanKind,
  SpanOptions,
  trace,
  Tracer,
  TracerProvider,
} from '@opentelemetry/api'
import { EngineSpan, EngineSpanKind, ExtendedSpanOptions, SpanCallback, TracingHelper } from '@prisma/internals'

// If true, will publish internal spans as well
const showAllTraces = process.env.PRISMA_SHOW_ALL_TRACES === 'true'

// https://www.w3.org/TR/trace-context/#examples-of-http-traceparent-headers
// If traceparent ends with -00 this trace will not be sampled
// the query engine needs the `10` for the span and trace id otherwise it does not parse this
const nonSampledTraceParent = `00-10-10-00`

type Options = {
  tracerProvider: TracerProvider
  ignoreSpanTypes: (string | RegExp)[]
}

function engineSpanKindToOtelSpanKind(engineSpanKind: EngineSpanKind): SpanKind {
  switch (engineSpanKind) {
    case 'client':
      return SpanKind.CLIENT
    case 'internal':
    default: // Other span kinds aren't currently supported
      return SpanKind.INTERNAL
  }
}
```

**File:** packages/internals/src/tracing/types.ts (L53-61)
```typescript
export interface TracingHelper {
  isEnabled(): boolean
  getTraceParent(context?: Context): string
  dispatchEngineSpans(spans: EngineSpan[]): void

  getActiveContext(): Context | undefined

  runInChildSpan<R>(nameOrOptions: string | ExtendedSpanOptions, callback: SpanCallback<R>): R
}
```

**File:** packages/instrumentation/README.md (L18-25)
```markdown
```ts
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { PrismaInstrumentation } from '@prisma/instrumentation'

registerInstrumentations({
  instrumentations: [new PrismaInstrumentation()],
})
```
```

**File:** packages/client-engine-runtime/src/tracing.ts (L43-81)
```typescript
export async function withQuerySpanAndEvent<T>({
  query,
  tracingHelper,
  provider,
  onQuery,
  execute,
}: {
  query: SqlQuery
  tracingHelper: TracingHelper
  provider: SchemaProvider
  onQuery?: (event: QueryEvent) => void
  execute: () => Promise<T>
}): Promise<T> {
  return await tracingHelper.runInChildSpan(
    {
      name: 'db_query',
      kind: SpanKind.CLIENT,
      attributes: {
        'db.query.text': query.sql,
        'db.system.name': providerToOtelSystem(provider),
      },
    },
    async () => {
      const timestamp = new Date()
      const startInstant = performance.now()
      const result = await execute()
      const endInstant = performance.now()

      onQuery?.({
        timestamp,
        duration: endInstant - startInstant,
        query: query.sql,
        params: query.args,
      })

      return result
    },
  )
}
```

**File:** packages/client/tests/functional/tracing/tests.ts (L190-204)
```typescript
    function operation(model: string | undefined, method: string, children: Tree[]) {
      const attributes: Attributes = {
        method,
        name: model ? `${model}.${method}` : method,
      }

      if (model) {
        attributes.model = model
      }
      return {
        name: 'prisma:client:operation',
        attributes,
        children,
      }
    }
```

**File:** packages/client/tests/functional/tracing/tests.ts (L546-559)
```typescript
        await waitForSpanTree({
          name: 'prisma:client:transaction',
          attributes: {
            method: '$transaction',
          },
          children: [
            operation('User', 'create', [
              ...clientCompileBatch(['createOne', 'findMany'], ['User', 'User']),
              clientSerialize(),
              ...engine([...expectedDbQueries]),
            ]),
            operation('User', 'findMany', [clientSerialize()]),
          ],
        })
```

**File:** packages/client/tests/functional/tracing/tests.ts (L723-744)
```typescript
        await waitForSpanTree([
          operation('User', 'findMany', [
            ...clientCompile('findMany', 'User'),
            {
              name: 'prisma:client:connect',
              children: engineConnect(),
            },
            clientSerialize(),
            ...engine([findManyDbQuery()]),
          ]),
        ])
      })

      test('should trace the explicit $connect call', async () => {
        await _prisma.$connect()

        await waitForSpanTree([
          {
            name: 'prisma:client:connect',
            children: engineConnect(),
          },
        ])
```

**File:** packages/client/src/runtime/core/tracing/TracingHelper.ts (L33-50)
```typescript
class DynamicTracingHelper implements TracingHelper {
  isEnabled(): boolean {
    return this.getGlobalTracingHelper().isEnabled()
  }
  getTraceParent(context: Context) {
    return this.getGlobalTracingHelper().getTraceParent(context)
  }

  dispatchEngineSpans(spans: EngineSpan[]) {
    return this.getGlobalTracingHelper().dispatchEngineSpans(spans)
  }

  getActiveContext() {
    return this.getGlobalTracingHelper().getActiveContext()
  }
  runInChildSpan<R>(options: string | ExtendedSpanOptions, callback: SpanCallback<R>): R {
    return this.getGlobalTracingHelper().runInChildSpan(options, callback)
  }
```

**File:** packages/query-plan-executor/src/tracing/handler.ts (L45-60)
```typescript
  run<R>(callback: (span?: Span, context?: Context) => R): R {
    return this.#tracer.startActiveSpan(this.#options.name, this.#options, (span) => {
      const spanProxy = new SpanProxy({
        span,
        parentSpan: this.#parentSpan,
        spanOptions: this.#options,
        trueStartTime: this.#startTime,
      })
      try {
        return this.#endSpan(spanProxy, callback(spanProxy, this.#context))
      } catch (error) {
        this.#finalizeSpan(spanProxy)
        throw error
      }
    })
  }
```

**File:** packages/client/tests/functional/tracing-no-sampling/tests.ts (L30-32)
```typescript
  const basicTracerProvider = new BasicTracerProvider({
    sampler: new TraceIdRatioBasedSampler(0), // 0% sampling!!
    resource: resourceFromAttributes({
```


---

Drizzle ORM implements OpenTelemetry tracing through a centralized tracer module that wraps OpenTelemetry's API and provides specific spans for different database operations.

## Core Tracing Implementation

The tracing system is implemented in `drizzle-orm/src/tracing.ts` [1](#0-0) , which:

1. **Conditionally imports OpenTelemetry**: The implementation dynamically imports `@opentelemetry/api` only when available [2](#0-1) 
2. **Defines specific span names**: Six predefined span types for different operations [3](#0-2) :
   - `drizzle.operation`
   - `drizzle.prepareQuery`
   - `drizzle.buildSQL`
   - `drizzle.execute`
   - `drizzle.driver.execute`
   - `drizzle.mapResponse`
3. **Provides a tracer wrapper**: The `tracer` object handles span lifecycle, error handling, and automatic span ending [4](#0-3) 

## Trace Spans Triggered

### 1. Query Execution Spans

In the PostgreSQL session implementation, multiple nested spans are created during query execution [5](#0-4) :

```typescript
// Outer span for the entire execute operation
tracer.startActiveSpan('drizzle.execute', async () => {
  // Inner span for driver-level execution
  return tracer.startActiveSpan('drizzle.driver.execute', async (span) => {
    span?.setAttributes({
      'drizzle.query.name': rawQuery.name,
      'drizzle.query.text': rawQuery.text,
      'drizzle.query.params': JSON.stringify(params),
    });
    // Actual database query execution
  });
});
```

### 2. Query Preparation Spans

Query builders wrap their preparation logic in spans [6](#0-5) :

```typescript
_prepare(name?: string): GelInsertPrepare<this> {
  return tracer.startActiveSpan('drizzle.prepareQuery', () => {
    return this.session.prepareQuery(/* ... */);
  });
}
```

### 3. Operation Spans

High-level operations are wrapped in operation spans [7](#0-6) :

```typescript
execute<T>(query: SQL): Promise<T> {
  return tracer.startActiveSpan('drizzle.operation', () => {
    const prepared = tracer.startActiveSpan('drizzle.prepareQuery', () => {
      return this.prepareQuery(/* ... */);
    });
    return prepared.execute(undefined);
  });
}
```

## Span Attributes

The tracer enriches spans with contextual attributes [8](#0-7) :

- `drizzle.query.name`: The name of the prepared query
- `drizzle.query.text`: The SQL query text
- `drizzle.query.params`: Serialized query parameters

## Error Handling

The tracer automatically captures and records errors on spans [9](#0-8) , setting the span status to ERROR with the error message.

## Integration Points

The tracing is integrated throughout the codebase:

1. **Session layers**: All database sessions use the tracer for query execution
2. **Query builders**: INSERT, UPDATE, DELETE operations wrap their logic in spans
3. **Driver implementations**: Each database driver (PostgreSQL, MySQL, SQLite) uses the same tracing patterns

## Dependencies

OpenTelemetry is declared as an optional peer dependency [10](#0-9) , allowing users to opt-in to tracing by installing `@opentelemetry/api`.

## Notes

- The tracing implementation is designed to be non-intrusive - if OpenTelemetry is not available, operations continue normally without tracing
- All spans are automatically ended, even when errors occur
- The tracer uses the Drizzle ORM version as the tracer version for better identification in observability tools
- The implementation follows OpenTelemetry best practices for span naming and attribute conventions

Wiki pages you might want to explore:
- [Database Sessions and Drivers (drizzle-team/drizzle-orm)](/wiki/drizzle-team/drizzle-orm#2.3)

### Citations

**File:** drizzle-orm/src/tracing.ts (L1-58)
```typescript
import type { Span, Tracer } from '@opentelemetry/api';
import { iife } from '~/tracing-utils.ts';
import { npmVersion } from '~/version.ts';

let otel: typeof import('@opentelemetry/api') | undefined;
let rawTracer: Tracer | undefined;
// try {
// 	otel = await import('@opentelemetry/api');
// } catch (err: any) {
// 	if (err.code !== 'MODULE_NOT_FOUND' && err.code !== 'ERR_MODULE_NOT_FOUND') {
// 		throw err;
// 	}
// }

type SpanName =
	| 'drizzle.operation'
	| 'drizzle.prepareQuery'
	| 'drizzle.buildSQL'
	| 'drizzle.execute'
	| 'drizzle.driver.execute'
	| 'drizzle.mapResponse';

/** @internal */
export const tracer = {
	startActiveSpan<F extends (span?: Span) => unknown>(name: SpanName, fn: F): ReturnType<F> {
		if (!otel) {
			return fn() as ReturnType<F>;
		}

		if (!rawTracer) {
			rawTracer = otel.trace.getTracer('drizzle-orm', npmVersion);
		}

		return iife(
			(otel, rawTracer) =>
				rawTracer.startActiveSpan(
					name,
					((span: Span) => {
						try {
							return fn(span);
						} catch (e) {
							span.setStatus({
								code: otel.SpanStatusCode.ERROR,
								message: e instanceof Error ? e.message : 'Unknown error', // eslint-disable-line no-instanceof/no-instanceof
							});
							throw e;
						} finally {
							span.end();
						}
					}) as F,
				),
			otel,
			rawTracer,
		);
	},
};


```

**File:** drizzle-orm/src/node-postgres/session.ts (L134-172)
```typescript
	async execute(placeholderValues: Record<string, unknown> | undefined = {}): Promise<T['execute']> {
		return tracer.startActiveSpan('drizzle.execute', async () => {
			const params = fillPlaceholders(this.params, placeholderValues);

			this.logger.logQuery(this.rawQueryConfig.text, params);

			const { fields, rawQueryConfig: rawQuery, client, queryConfig: query, joinsNotNullableMap, customResultMapper } =
				this;
			if (!fields && !customResultMapper) {
				return tracer.startActiveSpan('drizzle.driver.execute', async (span) => {
					span?.setAttributes({
						'drizzle.query.name': rawQuery.name,
						'drizzle.query.text': rawQuery.text,
						'drizzle.query.params': JSON.stringify(params),
					});
					return this.queryWithCache(rawQuery.text, params, async () => {
						return await client.query(rawQuery, params);
					});
				});
			}

			const result = await tracer.startActiveSpan('drizzle.driver.execute', (span) => {
				span?.setAttributes({
					'drizzle.query.name': query.name,
					'drizzle.query.text': query.text,
					'drizzle.query.params': JSON.stringify(params),
				});
				return this.queryWithCache(query.text, params, async () => {
					return await client.query(query, params);
				});
			});

			return tracer.startActiveSpan('drizzle.mapResponse', () => {
				return customResultMapper
					? customResultMapper(result.rows)
					: result.rows.map((row) => mapResultRow<T['execute']>(fields!, row, joinsNotNullableMap));
			});
		});
	}
```

**File:** drizzle-orm/src/gel-core/query-builders/insert.ts (L383-411)
```typescript
	/** @internal */
	_prepare(name?: string): GelInsertPrepare<this> {
		return tracer.startActiveSpan('drizzle.prepareQuery', () => {
			return this.session.prepareQuery<
				PreparedQueryConfig & {
					execute: TReturning extends undefined ? GelQueryResultKind<TQueryResult, never> : TReturning[];
				}
			>(this.dialect.sqlToQuery(this.getSQL()), this.config.returning, name, true, undefined, {
				type: 'insert',
				tables: extractUsedTable(this.config.table),
			});
		});
	}

	prepare(name: string): GelInsertPrepare<this> {
		return this._prepare(name);
	}

	override execute: ReturnType<this['prepare']>['execute'] = (placeholderValues) => {
		return tracer.startActiveSpan('drizzle.operation', () => {
			return this._prepare().execute(placeholderValues);
		});
	};

	$dynamic(): GelInsertDynamic<this> {
		return this as any;
	}
}

```

**File:** drizzle-orm/src/gel-core/session.ts (L174-187)
```typescript
	execute<T>(query: SQL): Promise<T> {
		return tracer.startActiveSpan('drizzle.operation', () => {
			const prepared = tracer.startActiveSpan('drizzle.prepareQuery', () => {
				return this.prepareQuery<PreparedQueryConfig & { execute: T }>(
					this.dialect.sqlToQuery(query),
					undefined,
					undefined,
					false,
				);
			});

			return prepared.execute(undefined);
		});
	}
```

**File:** drizzle-orm/package.json (L55-55)
```json
		"@opentelemetry/api": "^1.4.1",
```
