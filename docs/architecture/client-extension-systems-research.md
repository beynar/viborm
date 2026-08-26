# Client extension systems: primary-source research

**Status:** research record, 2026-08-25
**Scope:** lifecycle hooks, query and SQL rewriting, result and type mutation,
request context and authorization, cache and instrumentation replacement,
composition, async behavior, failures, and transactions.

This note reports what the cited systems expose. It does **not** propose a
VibORM extension design. Statements marked **Inference** are conclusions drawn
from the linked public contracts or source; the rest are documented behavior.
Only official documentation, official repositories, and OpenTelemetry
specifications are used.

## Executive comparison

| System | Semantic query hook | Compiled SQL hook | Execution continuation | Result hook | Static type extension | Separate cache / telemetry surface |
| --- | --- | --- | --- | --- | --- | --- |
| Prisma Client Extensions | Typed operation arguments through `query` | None in the documented extension callback | `query(args)` | The query callback can inspect the eager result; `result` adds lazy computed fields | `client`, `model`, and `result` extend the public client/model/result types | No general cache or telemetry contract is documented as an extension component ([overview](https://www.prisma.io/docs/orm/prisma-client/client-extensions), [query](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query), [result](https://www.prisma.io/docs/orm/prisma-client/client-extensions/result)) |
| Kysely plugins | Synchronous `OperationNode` tree transform | No compiled-SQL transform in `KyselyPlugin` | No continuation in `KyselyPlugin` | Asynchronous `QueryResult<UnknownRow>` transform | `withPlugin()` retains `Kysely<DB>`; plugins do not declare a new result type | Logger is a separate configuration contract ([plugin API](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html), [executor API](https://kysely-org.github.io/kysely-apidoc/classes/DefaultQueryExecutor.html), [Kysely source](https://github.com/kysely-org/kysely/blob/master/src/kysely.ts), [logger type](https://kysely-org.github.io/kysely-apidoc/types/Logger.html)) |
| Drizzle reviewed surfaces | Custom column codecs transform values at the schema boundary | Logger observes SQL and parameters but cannot replace them | Cache has its own `get` / `put` / `onMutate` contract | Custom column `fromDriver` / codec transforms values | Custom columns declare application and driver types | Cache and logger are separate configuration surfaces ([custom types](https://orm.drizzle.team/docs/custom-types), [cache](https://orm.drizzle.team/docs/cache), [logger source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/logger.ts)) |
| SQLAlchemy events | `do_orm_execute` can replace ORM statements and re-invoke execution | `before_cursor_execute(..., retval=True)` can replace the exact statement and parameters | `ORMExecuteState.invoke_statement()` supports nested execution | ORM execution can return a cached or merged result; Core has after-execute events | Python runtime system, not a TypeScript result-type extension mechanism | Events cover ORM, engine, connection, pool, mapper, session, and attributes ([session events](https://docs.sqlalchemy.org/en/20/orm/session_events.html), [Core events](https://docs.sqlalchemy.org/en/20/core/events.html)) |
| OpenTelemetry | Instruments the logical database call, not ORM semantics | SQL text can be recorded under database semantic conventions | Instrumentation wraps the call but does not define query rewriting | Records spans, attributes, status, and exceptions | None | API is library-side and no-op without an SDK; SDK owns processors/exporters ([library guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/), [database spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/), [Trace SDK](https://opentelemetry.io/docs/specs/otel/trace/sdk/)) |

The Kysely and Drizzle cells that say a hook is absent are bounded observations
of the linked public plugin/configuration contracts, not claims that arbitrary
behavior is impossible by forking or replacing lower-level components.

## 1. Prisma Client Extensions

### Public extension families

Prisma exposes four components under `$extends`: `client` adds top-level client
methods, `model` adds model methods, `query` hooks operations, and `result` adds
computed result fields or methods. `$extends` creates an extended client instead
of mutating the original client, and multiple differently extended clients can
coexist. Extension names can appear in error logs. ([overview](https://www.prisma.io/docs/orm/prisma-client/client-extensions),
[client](https://www.prisma.io/docs/orm/prisma-client/client-extensions/client),
[model](https://www.prisma.io/docs/orm/prisma-client/client-extensions/model),
[result](https://www.prisma.io/docs/orm/prisma-client/client-extensions/result))

When extensions define the same client or model method, the last declared
extension wins. Query extensions compose as middleware and are invoked in
declared first-in, first-out order. ([multiple extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions#multiple-extensions))

### Query lifecycle

A query callback receives `{ model, operation, args, query }`; it can be scoped
to one operation, a model, all models, all operations, or raw operations. `args`
is operation-specific and type-safe. The documented contract permits mutation
of its properties except `select` and `include`, because changing those would
change the expected output type. The callback invokes the next operation with
`query(args)`, may await it, and may inspect or modify the returned value.
([query component](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query))

The query component eagerly computes any post-query result work. Prisma
recommends the `result` component when possible because a result computation is
lazy and runs only when the field is accessed. ([query result modification](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query#modify-the-result-of-a-query),
[result considerations](https://www.prisma.io/docs/orm/prisma-client/client-extensions/result#considerations-for-fields))

**Inference:** the documented callback is an operation-argument continuation,
not a SQL compiler hook. It exposes neither a provider-neutral query AST nor the
compiled SQL/parameter pair, so it cannot directly rewrite the final SQL string
through this API. This follows from the complete callback shape documented on
the [query component page](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query).

### Result and type behavior

The result component declares a computed member with `needs` and `compute`.
`needs` determines the statically typed input available to `compute`; computed
members are added to the returned model type and are evaluated on access.
Dependencies are currently limited to scalar fields, computed fields cannot be
aggregated, and relation fields are not supported as dependencies.
([result component](https://www.prisma.io/docs/orm/prisma-client/client-extensions/result))

Prisma also exposes type utilities for extension authors and documents
`Prisma.Result` for deriving an operation result type that includes an
extension's computed fields. ([extension type utilities](https://www.prisma.io/docs/orm/prisma-client/client-extensions/type-utilities),
[`Prisma.Result` example](https://www.prisma.io/docs/orm/prisma-client/client-extensions#extending-model-types-with-prismaresult))

Prisma's `omit` is a declarative query/client option whose result type excludes
the omitted fields; it can be configured locally per query or globally on the
client. ([excluding fields](https://www.prisma.io/docs/orm/prisma-client/queries/excluding-fields))

**Inference:** Prisma separates arbitrary runtime interception from
shape-changing static typing. The generic query hook cannot alter `select` or
`include`, while the dedicated `result` and `omit` declarations carry enough
static information to compute a different public type. A runtime-only result
callback is therefore not, by itself, evidence for sound result-type mutation.
([query mutation restriction](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query),
[typed result declarations](https://www.prisma.io/docs/orm/prisma-client/client-extensions/result),
[typed omit](https://www.prisma.io/docs/orm/prisma-client/queries/excluding-fields))

### Authorization, nesting, and transactions

Prisma documents request- or user-bound extended clients as a way to isolate
behavior, including row-level-security use cases. However, query extensions do
not support nested read or nested write operations. Prisma's official input
validation example therefore validates only the top-level `data` object and
explicitly says nested writes bypass that validation. ([extended clients and
RLS](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query),
[nested-operation limitation](https://www.prisma.io/docs/orm/prisma-client/client-extensions#usage-with-nested-operations),
[official input-validation example](https://github.com/prisma/prisma-client-extensions/tree/main/input-validation))

The query documentation shows wrapping an operation in a batch transaction.
The official RLS example does this for every query to set transaction-local
PostgreSQL state, but warns that explicit transactions on the extended client
may not work as intended. ([batch-transaction example](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query#wrap-a-query-into-a-batch-transaction),
[official RLS example and caveat](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security))

There is a second transaction boundary hazard for shared extensions: Prisma
documents that an extension which calls a client-level method from inside a
transaction issues those queries on a new connection and ignores the current
transaction context. ([shared-extension transaction warning](https://www.prisma.io/docs/orm/prisma-client/client-extensions/shared-extensions#create-a-shareable-extension))

**Inference:** a security extension needs an operation model that includes
nested work and preserves transaction identity. An API that is type-safe at the
top-level callback can still be authorization-incomplete if nested operations
or rebinding escape it. The inference is supported by Prisma's own
[nested-write caveat](https://github.com/prisma/prisma-client-extensions/tree/main/input-validation)
and [RLS transaction caveat](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security).

### Middleware direction

Prisma 7 removed the former client middleware API and directs users toward
Client Extensions. ([Prisma 7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7#removed-apis))

## 2. Kysely plugins

### The two-stage contract

`KyselyPlugin` has exactly two methods: synchronous `transformQuery`, which
receives and returns a `RootOperationNode`, and asynchronous `transformResult`,
which receives and returns `QueryResult<UnknownRow>`. The former runs before
execution and the latter after execution. ([plugin API](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html))

The query representation is an `OperationNode` tree. Kysely recommends
`OperationNodeTransformer`, whose default behavior creates a transformed deep
copy and whose node-specific methods can be overridden. ([plugin query
contract](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html#transformQuery),
[`OperationNodeTransformer`](https://kysely-org.github.io/kysely-apidoc/classes/OperationNodeTransformer.html))

The executor transforms the query before compilation, compiles the transformed
tree, executes the compiled query, and then runs result transforms. The source
runs both query transforms and result transforms forward through the installed
plugin list. `withPlugin` appends, `withPluginAtFront` prepends, and both return
new executor values. ([executor API](https://kysely-org.github.io/kysely-apidoc/classes/DefaultQueryExecutor.html),
[executor source](https://github.com/kysely-org/kysely/blob/master/src/query-executor/query-executor-base.ts))

**Inference:** Kysely's composition is not an around/onion continuation. Both
pre- and post-execution transforms run in list order, because the official
[executor source](https://github.com/kysely-org/kysely/blob/master/src/query-executor/query-executor-base.ts)
iterates forward for both stages.

### Per-query state and failures

Kysely supplies the same `queryId` to the two transforms. Its documentation says
cross-stage state should use a `WeakMap`, specifically because a
`transformQuery` call is not guaranteed to have a matching `transformResult`
call and a strong map could retain orphaned state. ([plugin state guidance](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html#transformQuery))

**Inference:** the missing result callback is an ordinary control-flow outcome,
not an exceptional plugin condition: compilation, execution, or an earlier
plugin can prevent that stage. Extension state therefore needs cleanup semantics
that do not depend on a successful post hook. This follows from Kysely's own
[WeakMap warning](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html#transformQuery).

The official executor source does not convert plugin failures into values;
query-transform exceptions throw and asynchronous result-transform failures
reject execution. **Inference:** absent a separately documented recovery
contract, a mutating or policy plugin is fail-closed by normal exception
propagation. ([executor source](https://github.com/kysely-org/kysely/blob/master/src/query-executor/query-executor-base.ts))

### SQL, execution, result types, and transactions

The plugin transforms the semantic operation tree before the compiler; the
documented `KyselyPlugin` interface has no callback over `CompiledQuery` and no
execution continuation. The result hook starts only after database execution.
([plugin API](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html),
[executor sequence](https://kysely-org.github.io/kysely-apidoc/classes/DefaultQueryExecutor.html))

**Inference:** a plugin can rewrite semantics at the AST level but cannot, via
this interface, replace the final SQL string, suppress database execution for a
cache hit, retry the provider call, or wrap the provider call itself. Those
capabilities sit outside the two documented methods. ([plugin API](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html))

`withPlugin(plugin)` returns `Kysely<DB>`, and `transformResult` operates on
`QueryResult<UnknownRow>`. **Inference:** a plugin may change runtime rows but
does not declare a corresponding new static query-result type through this API.
([Kysely source](https://github.com/kysely-org/kysely/blob/master/src/kysely.ts),
[plugin API](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html))

Kysely creates transaction-scoped clients by reusing the executor with a
transaction connection provider; transaction clients retain the database type
and plugin-bearing executor. ([transaction source](https://github.com/kysely-org/kysely/blob/master/src/kysely.ts))

### Logging is separate

Kysely configuration accepts a distinct `log` setting. A custom logger can be
synchronous or asynchronous and receives query/error events, including the
compiled query, query duration, and the error for error events. ([configuration](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyConfig.html),
[logger type](https://kysely-org.github.io/kysely-apidoc/types/Logger.html),
[error event](https://kysely-org.github.io/kysely-apidoc/interfaces/ErrorLogEvent.html))

**Inference:** Kysely gives structural mutation and observation different
contracts. The plugin owns transformations, while logging does not need to
pretend it can replace queries or results. ([plugin API](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html),
[logger type](https://kysely-org.github.io/kysely-apidoc/types/Logger.html))

## 3. Drizzle reviewed extension surfaces

### Typed value extension

Drizzle custom types declare the application `data` type, optional driver-side
types, the emitted SQL data type, and optional `toDriver`, `fromDriver`, and
codec behavior. The documentation specifies the transform order around the
driver codec for reads and writes. ([custom types](https://orm.drizzle.team/docs/custom-types))

**Inference:** this is a narrow, statically typed value-boundary extension. It
is a stronger fit for one column's representation than a generic operation
middleware because the declaration carries both schema and TypeScript meaning.
([custom-type generics and methods](https://orm.drizzle.team/docs/custom-types#methods-and-generic-types),
[transform order](https://orm.drizzle.team/docs/custom-types#transform-layers-and-execution-order))

### Logger

Drizzle's `Logger` contract has one synchronous
`logQuery(query: string, params: unknown[]): void` method. It observes compiled
SQL and parameters and returns no replacement. ([official logger source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/logger.ts))

**Inference:** the logger is deliberately insufficient for SQL rewriting,
result transformation, cache short-circuiting, or authorization. Treating this
observer as middleware would require a new contract rather than an accidental
interpretation of its existing return value. ([logger source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/logger.ts))

### Cache

Drizzle caching is opt-in by default, can be enabled globally, and supports a
custom cache implementation with strategy, asynchronous fetch/store, and
mutation invalidation responsibilities. Query-level options include custom
tags and automatic-invalidation control. ([cache documentation](https://orm.drizzle.team/docs/cache),
[cache base class](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/cache/core/cache.ts))

The documented cache does not handle raw queries or transactions, and currently
lists relational queries, AWS Data API drivers, and views as temporary
limitations. ([cache limitations](https://orm.drizzle.team/docs/cache#limitations))

**Inference:** replacing a cache is more than observing before/after values. It
needs a stable key, permission to skip execution, storage, mutation metadata,
invalidation, and explicit transaction behavior. Drizzle's purpose-built cache
surface exposes several of these concerns and its limitation list shows what
happens when some execution domains are not integrated. ([custom cache](https://orm.drizzle.team/docs/cache#custom-cache),
[limitations](https://orm.drizzle.team/docs/cache#limitations))

### Audit boundary

The reviewed public configuration exposes `logger` and `cache`, while custom
types expose column transforms. ([configuration source](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/utils.ts),
[custom types](https://orm.drizzle.team/docs/custom-types))

**Inference:** no Kysely-style general query/result plugin appears in these
officially reviewed surfaces. This is an audit result limited to these contracts,
not proof that every Drizzle package or internal dialect seam lacks an
extension point.

## 4. SQLAlchemy events as a lifecycle counterexample

SQLAlchemy is useful here because it exposes several distinct interception
levels instead of calling all of them middleware.

### ORM semantic execution

`SessionEvents.do_orm_execute` intercepts top-level ORM statement execution.
Handlers may replace the statement, add options, or call
`ORMExecuteState.invoke_statement()` to perform nested execution; the latter
skips handlers already invoked in the current call. The documentation uses this
mechanism for result caching and horizontal sharding. ([ORM execution events](https://docs.sqlalchemy.org/en/20/orm/session_events.html#execute-events),
[re-executing statements](https://docs.sqlalchemy.org/en/20/orm/session_events.html#re-executing-statements))

The cache example freezes a result, stores it, and merges it back into the
current session on a cache hit. ([dogpile caching example](https://docs.sqlalchemy.org/en/20/orm/session_events.html#deep-alchemy))

`with_loader_criteria` adds global WHERE/ON criteria for every occurrence of an
entity and propagates to relationship loaders; the docs explicitly describe
its use for access-control roles. ([`with_loader_criteria`](https://docs.sqlalchemy.org/en/20/orm/queryguide/api.html#sqlalchemy.orm.with_loader_criteria))

**Inference:** authorization and caching both need the power to affect execution,
but they do not have identical semantics. Authorization rewrites the semantic
statement and must propagate into relation loads; caching may replace execution
and then reconcile a result with the active identity/session context.
([access criteria](https://docs.sqlalchemy.org/en/20/orm/queryguide/api.html#sqlalchemy.orm.with_loader_criteria),
[cache re-execution](https://docs.sqlalchemy.org/en/20/orm/session_events.html#re-executing-statements))

### SQL expression and wire-level SQL

Core `before_execute` sees SQL expression constructs before compilation.
`before_cursor_execute` sees the exact SQL string and DBAPI parameters sent to
the cursor; when registered with `retval=True`, it must return a replacement
`(statement, parameters)` pair. ([connection events](https://docs.sqlalchemy.org/en/20/core/events.html#sqlalchemy.events.ConnectionEvents))

**Inference:** semantic-AST rewriting and final-SQL rewriting are separate
capabilities. Exposing only the former cannot support a SQL commenter or
dialect-specific last-mile rewrite; exposing only the latter loses model,
relation, and operation meaning. SQLAlchemy's two documented stages make that
distinction concrete. ([Core execution events](https://docs.sqlalchemy.org/en/20/core/events.html#sqlalchemy.events.ConnectionEvents.before_execute),
[cursor execution events](https://docs.sqlalchemy.org/en/20/core/events.html#sqlalchemy.events.ConnectionEvents.before_cursor_execute))

### Validation and async events

SQLAlchemy attribute events can validate or normalize assigned values and may
return a replacement value when registered with `retval=True`; raising rejects
the assignment. ([attribute events](https://docs.sqlalchemy.org/en/20/orm/events.html#sqlalchemy.orm.AttributeEvents.set))

SQLAlchemy's asyncio extension does not provide an async event-handler API.
Regular synchronous handlers target the synchronous proxy objects used under
`AsyncEngine` and `AsyncSession`; calls are adapted back to the async driver.
([asyncio events](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-events-with-the-asyncio-extension))

**Inference:** whether a hook is synchronous or asynchronous belongs to its
stage. A pure tree rewrite or hot observer can remain synchronous, while an
execution replacement, external policy lookup, or cache backend may require an
awaitable boundary. One universal callback timing would either forbid useful
I/O or impose promise overhead where it has no semantic role.
([Kysely's sync/async split](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html),
[SQLAlchemy async-event adaptation](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-events-with-the-asyncio-extension))

## 5. OpenTelemetry instrumentation boundaries

OpenTelemetry recommends that instrumented libraries depend on the API, which
is no-op when no SDK is installed, while the application owns SDK setup and
configuration. Native instrumentation can be built into the library without a
library-specific hook. ([library instrumentation guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

Database client spans represent the logical database call as observed by the
caller. Their duration should cover the logical operation, including retries;
the specification recommends instrumenting a higher-level API rather than
creating spans for every low-level internal call. ([database client spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/))

Database parameter capture is opt-in because values may contain sensitive
information. Non-parameterized SQL must be sanitized before it is recorded;
SQL commenter propagation is opt-in and disabled by default because high-cardinality
comments can affect prepared statements and database performance.
([database span attributes and security](https://opentelemetry.io/docs/specs/semconv/db/database-spans/))

The Trace SDK permits custom span processors and invokes them in registration
order. `OnStart` and `OnEnd` are synchronous callbacks; processors must not
block or throw. ([span processors](https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-processor))

OpenTelemetry's error-handling specification says telemetry errors must not
make the host application fail at runtime and must be handled internally.
Exception recording guidance records an exception that escapes the instrumented
operation, marks the span appropriately, and rethrows the application error.
([error handling](https://opentelemetry.io/docs/specs/otel/error-handling/),
[exception recording](https://opentelemetry.io/docs/specs/otel/trace/exceptions/))

**Inference:** instrumentation is not an ordinary policy extension. A cache or
authorization hook normally needs its failure to affect the operation; an OTel
exporter or span processor must not. A shared composition mechanism can host
both only if failure policy remains attached to the capability, instead of
globally swallowing or globally propagating every extension error.
([OTel error handling](https://opentelemetry.io/docs/specs/otel/error-handling/),
[Prisma validation example](https://github.com/prisma/prisma-client-extensions/tree/main/input-validation))

## Cross-system findings

Everything in this section is **inference** from the cited contracts, not a
description or proposal for VibORM.

### 1. “Extension” covers three independent powers

The evidence separates at least three powers:

1. **Surface extension:** add statically known client, model, or result members,
   as Prisma does with `client`, `model`, and `result`.
2. **Program transformation:** rewrite a semantic operation before compilation,
   as Kysely does with `OperationNode` and SQLAlchemy does with ORM statements.
3. **Execution control:** surround, replace, retry, or skip execution, as
   Prisma's continuation and SQLAlchemy's `invoke_statement()` permit in
   different ways.

([Prisma components](https://www.prisma.io/docs/orm/prisma-client/client-extensions),
[Kysely plugin](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html),
[SQLAlchemy re-execution](https://docs.sqlalchemy.org/en/20/orm/session_events.html#re-executing-statements))

Conflating these powers makes capability and type claims hard to state. Kysely
shows that a clean tree transform need not own execution; Prisma shows that a
continuation hook need not expose compiler internals; SQLAlchemy shows why both
levels can be independently useful.

### 2. Semantic rewriting and SQL-string rewriting are not substitutes

RBAC needs schema-aware predicates that survive nested relation loading. A SQL
commenter, provider hint, or last-mile SQL transform needs the compiled string
and bound parameter pair. SQLAlchemy exposes both boundaries separately;
Kysely stops at the semantic tree; Prisma stops at typed operation arguments.
([SQLAlchemy statement/cursor events](https://docs.sqlalchemy.org/en/20/core/events.html#sqlalchemy.events.ConnectionEvents),
[Kysely transform](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html#transformQuery),
[Prisma query arguments](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query))

A final-SQL hook that permits replacement also needs to preserve the SQL/parameter
pair atomically. SQLAlchemy makes this explicit by requiring both values in the
`retval=True` return contract. ([`before_cursor_execute`](https://docs.sqlalchemy.org/en/20/core/events.html#sqlalchemy.events.ConnectionEvents.before_cursor_execute))

### 3. Static result mutation requires a declarative type witness

Prisma can type computed fields because the extension declaration names the
field and its dependencies. It forbids generic query hooks from changing
`select` or `include`. Kysely plugins can transform runtime `UnknownRow` values
but `withPlugin` preserves `Kysely<DB>`. Therefore, arbitrary post-processing
and sound static result mutation are different features.
([Prisma result declaration](https://www.prisma.io/docs/orm/prisma-client/client-extensions/result),
[Prisma query restriction](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query),
[Kysely public type](https://github.com/kysely-org/kysely/blob/master/src/kysely.ts))

This also explains why omission is more naturally typed when declared as a
shape-level option than when performed by an opaque callback. Prisma's built-in
`omit` changes the inferred result shape, while query extensions cannot mutate
shape-defining selection arguments. ([Prisma omit](https://www.prisma.io/docs/orm/prisma-client/queries/excluding-fields),
[query restriction](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query))

### 4. RBAC correctness is graph- and transaction-wide

A top-level filter hook is not sufficient evidence for authorization. Prisma's
official example says nested writes bypass its validation extension and its RLS
example warns about explicit transactions. SQLAlchemy's access-control example
instead uses criteria that propagate to relationship loaders. The common lesson
is that policy context must follow every derived operation and the exact active
transaction/connection.
([Prisma nested caveat](https://github.com/prisma/prisma-client-extensions/tree/main/input-validation),
[Prisma RLS caveat](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security),
[SQLAlchemy propagated criteria](https://docs.sqlalchemy.org/en/20/orm/queryguide/api.html#sqlalchemy.orm.with_loader_criteria))

### 5. Cache replacement requires execution and invalidation ownership

A cache needs authority to return without provider execution, observe mutations,
define a key, store results, invalidate by affected data, and state transaction
semantics. SQLAlchemy demonstrates execution replacement and session-aware
result merging; Drizzle exposes a purpose-built cache contract and explicitly
lists transaction/raw-query gaps. A before/after observer alone does not cover
this responsibility.
([SQLAlchemy cache recipe](https://docs.sqlalchemy.org/en/20/orm/session_events.html#re-executing-statements),
[Drizzle custom cache](https://orm.drizzle.team/docs/cache#custom-cache),
[Drizzle limitations](https://orm.drizzle.team/docs/cache#limitations))

### 6. Composition order must define both halves

Prisma documents FIFO query middleware whose continuation naturally nests
downstream work. Kysely runs query and result transforms forward in the same
plugin order. OpenTelemetry invokes processors in registration order. These are
different, valid models; an extension contract is underspecified unless it says
who sees input first, who sees output first, and what happens when a stage does
not complete.
([Prisma chaining](https://www.prisma.io/docs/orm/prisma-client/client-extensions#middleware-chaining-with-query-extensions),
[Kysely executor source](https://github.com/kysely-org/kysely/blob/master/src/query-executor/query-executor-base.ts),
[OTel processors](https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-processor))

### 7. Cross-stage state cannot assume an after hook

Kysely explicitly warns that a query transform may have no matching result
transform and recommends weakly keyed state. Errors, short-circuits, compilation
failures, and cancellation all make “after always runs” an unsafe foundation;
resource cleanup needs an execution boundary with `finally` semantics rather
than dependence on a successful result transform.
([Kysely state guidance](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html#transformQuery),
[OTel exception pattern](https://opentelemetry.io/docs/specs/otel/trace/exceptions/))

### 8. Failure policy belongs to the capability

Validation and authorization should reject an operation when they fail. Normal
query/result transforms propagate failures in Kysely's executor. Telemetry must
not make the application fail, according to OpenTelemetry. A single global rule
such as “extension failures are ignored” or “all extension failures abort” is
therefore semantically wrong for at least one legitimate capability.
([Prisma validation example](https://github.com/prisma/prisma-client-extensions/tree/main/input-validation),
[Kysely executor source](https://github.com/kysely-org/kysely/blob/master/src/query-executor/query-executor-base.ts),
[OTel error handling](https://opentelemetry.io/docs/specs/otel/error-handling/))

### 9. Stage-specific sync/async behavior is observable

Kysely keeps tree transforms synchronous and result transforms asynchronous;
Drizzle's logger is synchronous; SQLAlchemy adapts synchronous events under its
async facade; OpenTelemetry requires span processor start/end callbacks not to
block. These systems avoid making every hook an arbitrary async continuation.
([Kysely plugin](https://kysely-org.github.io/kysely-apidoc/interfaces/KyselyPlugin.html),
[Drizzle logger](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/logger.ts),
[SQLAlchemy asyncio events](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#using-events-with-the-asyncio-extension),
[OTel processor requirements](https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-processor))

### 10. Instrumentation's natural boundary is the logical operation

OpenTelemetry asks database instrumentation to describe the logical client call
and include retries in its duration, while avoiding a span for each low-level
internal call. Parameter capture and query-comment propagation have explicit
privacy/performance policies. This points toward semantic operation metadata
plus a trusted execution boundary, not instrumentation implemented only as a
late SQL logger.
([database client spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/),
[library guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

## Questions any later design must answer

These are research questions, not proposed answers:

- Which representations are stable contracts: validated operation input,
  semantic program, adapter SQL structure, compiled SQL/parameters, raw driver
  result, parsed public result?
- Which stages may mutate, replace, short-circuit, retry, or only observe?
- Which stage owns value validation, and can nested work bypass it?
- How is request/policy context carried through nested operations, batches,
  transactions, retries, and extension-created queries?
- Is composition onion-shaped or ordered-stage-shaped, and what output order is
  guaranteed?
- Which callbacks may await? Which hot-path callbacks must be synchronous?
- What static declaration proves a result-shape change to TypeScript?
- How does a cache key include operation, parameters, schema, policy context,
  transaction visibility, and result-shape extensions?
- Which failures abort the operation, and which observer failures are isolated?
- What does a SQL rewriter return so SQL and bound parameters cannot diverge?
- What happens to per-operation state when compilation, execution, parsing, or
  an earlier extension fails before the corresponding later stage?

Each question is forced by at least one documented boundary above; none requires
introducing a single universal middleware abstraction.
