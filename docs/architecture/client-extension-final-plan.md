# Client Extensions — Final Architecture Plan

**Status:** implemented and validated architecture record
**Date:** 2026-08-25
**Evidence:** [client-extension-systems-research.md](client-extension-systems-research.md)
**Principles:** [ELEGANCE.md](../../ELEGANCE.md)

The six-capability envelope, protected lifecycle rail, official cache and
instrumentation extensions, and `defaultOmit()` extraction are implemented.
Sections below preserve the design reasoning and staged gates; future-tense
language describes the decision process, not an unimplemented public promise.
The graph-policy/RBAC capability remains deliberately future work (§14).

### Final organization

The implemented generic system has one representation, one decision owner, and
one runner for each capability:

| File | Final responsibility |
|---|---|
| `src/extensions/definition.ts` | Public extension envelope, `defineExtension()`, exact definition guard, hostile-definition normalization |
| `src/extensions/chain.ts` | Single immutable resolved chain, composition, official capability attachment, handler lookup |
| `src/extensions/methods.ts` | Client/model method factories, collision rules, extension type state, concrete-view binding |
| `src/extensions/request.ts` | Request-transform types, result-shape projection, synchronous runner |
| `src/extensions/query.ts` | Query interception, continuation authority, write-outcome registration and publication |
| `src/extensions/statement.ts` | Trusted `Sql`-to-`Sql` contract and runner |
| `src/extensions/observation.ts` | Lifecycle units, protected facts access, completion onion, observer runner |
| `src/extensions/array-admission.ts` | Only the extension-specific native/fallback admission latch |
| `src/extensions/index.ts` | Intentional public/internal exports |

The official implementations remain in `src/cache/extension.ts`,
`src/instrumentation/extension.ts`, and
`src/client/default-omit-extension.ts`. Core array dispatch stays outside the
extension directory. Pending operation, client transaction coordination,
query-engine preparation and parsing, executor segment boundaries, cache facts,
and driver/provider facts remain irreducible lifecycle trigger points because
those owners create the facts; none keeps a second extension registry or runner.

### Final type disposition

The built-in `createClient({ omit })` owner was deleted after the extension
candidate stayed within the accepted type-cost gate. The deterministic comparison
used baseline `edf22a74` and the final semantically compressed candidate:

| Measure | Baseline | Compressed candidate | Change |
|---|---:|---:|---:|
| Type instantiations | 14,537,447 | 14,061,401 | -3.2746% |
| TypeScript memory median | 3,753,043K | 3,858,179K | +2.8014% |
| External wall | 21.09s | 22.75s | +7.871% |
| Peak process-group RSS | 4,360,749,056 | 4,192,190,464 | -3.8654% |

Both arms completed without diagnostics, TS2589, or TS2590. The candidate stayed
below the hard 300-second and 4-GiB limits. The accepted deterministic type-cost
criterion is type instantiations no more than 5% above baseline; wall time,
TypeScript-reported memory, and process-group RSS are recorded evidence, while
the hard time and RSS limits remain absolute. The candidate therefore passes.

### Final runtime-performance disposition

The retained budgets match the irreducible semantic unit of each capability.
Each microsecond cap applies independently to `cpuMicrosecondsPerOperation` and
`wallMicrosecondsPerOperation` for that unit:

- an unextended client adds zero allocation and performs no handler scan;
- method-only `client` and `model` capabilities remain below 3% overhead;
- `request` adds at most 5 KiB and 5 microseconds per logical operation;
- `query` adds at most 16 KiB and 5 microseconds per logical operation;
- `statement` adds at most 2 KiB and 3 microseconds per physical statement;
- `observe` adds at most 4 KiB and 6 microseconds per emitted lifecycle unit;
- no extension adds row-scaled work unless extension code itself maps rows;
- retained heap and peak RSS may not regress by more than 10%.

A change beyond `2×MAD` is treated as a real measured delta and compared with
the capability's budget; it is not an automatic refusal. Five-run SQLite
evidence and the lazy-snapshot falsifier require unit budgets instead of one
universal percentage. In particular, the immutable query-input snapshot must
be captured before user code can observe or mutate it; deferring that capture
would make the snapshot unsound. Observation cost scales with the lifecycle
units the observer explicitly receives, not only with the enclosing operation.

The final short diagnostic benchmark is directional tuning evidence only and
cannot authorize retention. The organization pass did not materially change
allocation; retention evidence comes from the five-run protocol and the
capability-specific falsifiers.

## 1. Decision

VibORM gets one immutable extension envelope:

    const scoped = db.$extends({
      name: "tenant",
      request,
      query,
      statement,
      observe,
      client,
      model,
    });

This is one language, not one omnipotent hook. Its six optional members attach
to six existing owners with different timing, authority, failure, and type
contracts:

| Member | Existing owner it extends | Authority |
| --- | --- | --- |
| request | Public model-operation input boundary | May return a pre-validation patch |
| query | One prepared logical operation | May wrap execution; an authorized read may short-circuit |
| statement | Final typed Sql boundary | Trusted low-level Sql-to-Sql replacement |
| observe | Existing lifecycle composition roots | Read-only and failure-contained |
| client | Concrete client proxy | Adds typed dollar-prefixed methods |
| model | Concrete model delegate | Adds typed delegate methods |

Removing any one member would leave one requested capability without an honest
owner. Combining any pair would conflate incompatible semantics:

- request is synchronous and pre-validation; query is asynchronous and
  post-preparation;
- query failure changes the application; observer failure never may;
- one logical query can execute several physical statements;
- client/model methods change the static surface; runtime hooks do not.

There is no public plugin registry, mutable middleware stack, priority number,
ambient context bag, query-program AST, result ownership token, or second
dialect system.

## 2. Desired outcome

The foundation must be sufficient to implement:

- tenant and soft-delete defaults before validation;
- operation refusal and prepared-read memoization;
- custom typed client and model methods;
- safe tracing/logging integration at operation, statement, transaction,
  batch, progressive-segment, connection, and cache boundaries;
- the current cache as an official extension without losing exact transaction
  and progressive-write invalidation;
- client default omit as an official typed extension if its type-cost gate
  passes;
- parameter-preserving SQL comments, hints, or trusted last-mile statement
  rewrites;
- a later graph-wide authorization policy without pretending a top-level
  filter is complete RBAC.

The unextended client must preserve current behavior, SQL, errors, types,
batchability, row-consumption proofs, and hot-path allocations.

## 3. Facts the design must respect

### 3.1 One public operation is not one statement

A read normally validates, builds, executes, and parses one statement. A write
can perform planning reads, late branch validation, guards, dependent writes,
result reads, retries, and progressively committed segments. The final write
program may not exist before planning SQL executes.

Therefore:

- a query hook cannot honestly expose “the complete program before SQL”;
- statement customization must run once for each materialized statement;
- graph authorization must be consumed by the semantic owners that create
  scopes and membership mutations;
- instrumentation needs several lifecycle units, not only a query callback.

### 3.2 Validation has one owner

Core validation remains the boundary from untrusted input to trusted operation
values. Extensions may patch input before that boundary. They may not inject
callbacks inside arbitrary validator nodes or receive a mutable validated
object.

Value-level customization remains Standard Schema or scalar behavior. A public
“during validation” hook would split validation ownership and violate
parse-once.

### 3.3 Atomicity and result transport stay private

Extensions never receive operation fragments, step identifiers, output
references, guards, retry pins, postconditions, relation-index identity,
normalized-result certification, consumable-row ownership, parser-owned
relation graphs, or transaction commit control.

### 3.4 Security precedes optional behavior

No cache hit or user interceptor may bypass validation or authorization.
Mandatory preparation and future policy authorization run before a read
short-circuit can be accepted. Mutations can be denied by throwing but cannot
report a successful no-op.

## 4. Exact lifecycle

No extension code runs merely because a model method is called. The method
still returns one lazy PendingOperation.

When it is awaited or admitted to an array transaction, core runs:

    logical-operation observer begins
      request transforms
      unique-where guard and mandatory core preparation
      future root/read-graph policy authorization
      query interceptors
        official cache rail
          planning and any late branch validation
          semantic policy checks at every discovered write scope
          compile
          for each materialized typed statement:
            statement observers
            statement transforms
            render and execute
          parse public result
      query post-work settles
    logical-operation observer receives completion

Important consequences:

- request-transform failures are visible to the logical observer but do not
  invoke query interceptors;
- query interceptors see a prepared operation and cannot bypass mandatory
  read validation or policy;
- late, data-dependent mutation validation stays below proceed, so mutations
  must call proceed exactly once;
- the query continuation wraps planning, late validation, retries, physical
  execution, and parsing, not the pre-validation request phase;
- every statement path reaches the same typed statement boundary;
- the observer receives completion metadata, never the application value.

## 5. Public definition and application

### 5.1 Inline and reusable definitions

Inline definitions are contextually typed from the concrete client:

    const tenantDb = db.$extends({
      name: "tenant",
      request: {
        post: {
          findMany({ input }) {
            return {
              where: {
                AND: [input.where ?? {}, { tenantId }],
              },
            };
          },
        },
      },
    });

The reusable schema-generic form uses an opaque result generic and does not
instantiate every model-operation pair:

    export const timing = defineExtension({
      name: "timing",
      query: async ({ model, operation, proceed }) => {
        const started = performance.now();
        const value = await proceed();
        record(model, operation, performance.now() - started);
        return value;
      },
    });

Schema-specific reusable maps use a curried binder so TypeScript fixes the
schema and still infers the literal definition:

    export const tenantExtension =
      defineExtension<typeof schema>()({
        name: "tenant",
        request: {
          post: {
            findMany({ input }) {
              return { where: addTenant(input.where, tenantId) };
            },
          },
        },
      });

The exact binder spelling is subject to the Phase 0 type prototype. The
requirements are not: inline contextual typing, exact schema-bound reusable
maps, and a cheap schema-generic function form.

One request or query member uses either:

- one schema-generic all-operation function; or
- one schema-specific model/operation map.

It may not use both. There is no all-model/all-operation precedence ladder.

### 5.2 Immutable derived clients

db.$extends(extension):

- validates and freezes the definition;
- returns a new lightweight client view;
- does not mutate db;
- shares the schema registry, resolved relation index, driver, pool, and
  connection lifecycle;
- carries a frozen resolved extension chain;
- receives a distinct operation scope, so operations from incompatible client
  views cannot be mixed in one array transaction.

Extension names are required, non-empty, and unique in one chain. Applying the
same extension twice is an error. There is no removal operation; an
unrestricted view must be derived from the original base client.

## 6. request — pre-validation input patches

### 6.1 Contract

A request handler:

- applies only to model operations, never raw SQL;
- runs lazily once when the PendingOperation starts;
- runs synchronously;
- receives a borrowed, shallow-read-only input view;
- returns a shallow patch, not a replacement operation;
- is composed in extension application order;
- may throw to refuse the operation;
- may not return a promise;
- has no authority to mutate caller input; mutation is unsupported;
- enters the existing core validation flow after all patches; the extension
  adds no validation or revalidation pass.

If the caller omitted an optional argument, the extension boundary presents
an immutable empty input record. The no-extension path keeps current behavior
and allocates nothing.

Core merges patches into fresh input only when a request handler exists. The
next handler sees the previous handler's patch. Non-record and promise outputs
fail at the extension boundary. Unknown operation keys remain owned by the
existing validator rather than a redundant extension guard.

### 6.2 Result-shape integrity

An ordinary request handler cannot alter any key that changes the static result
type.

This is broader than select/include/omit. It includes:

- select, include, and omit;
- count.select;
- aggregate selectors;
- groupBy.by and its aggregate selectors;
- any returning/projection key added by a future operation.

One operation-specific result-shape projector owns this list. Before invoking
ordinary request handlers, core detaches the exact caller-owned result-shaping
descriptors. Handlers receive neither those properties nor their nested
objects. Their patch type excludes them. Core then reattaches the exact
original descriptors before validation.

This is a runtime guarantee, not only Readonly TypeScript decoration. It
prevents JavaScript, assertions, or nested in-place mutation from changing the
result while the call site retains its old result type.

The official default-omit extension uses a separate declarative projection
witness described in §13. It does not weaken this rule for ordinary handlers.

### 6.3 Correct uses

Request transforms can express:

- top-level tenant predicates;
- soft-delete filters;
- default pagination;
- forced create/update values;
- operation refusal;
- normalization that core validation then checks.

They do not provide complete nested authorization.

## 7. query — prepared logical-operation interception

### 7.1 Contract

A query interceptor:

- applies to a prepared model operation or, in the generic form, a classified
  raw operation;
- runs once per public operation, outside internal race retries;
- can do asynchronous work before and after proceed;
- receives execution mode and immutable operation identity;
- receives an inspection input that core no longer consumes as mutable
  operation state;
- calls proceed zero or one time for an eligible read;
- must call proceed exactly once for a mutation or raw operation, unless it
  throws;
- cannot pass replacement arguments to proceed;
- preserves the exact call-site result type;
- propagates failures with extension identity and original cause.

The operation-specific handler is polymorphic in the original call-site
argument so select/include/omit, returning, count, aggregate, groupBy, and
relation projections retain their exact result types. The schema-generic form
uses an opaque R and can return only an R it already owns.

### 7.2 Continuation authority

The rule is deliberately stronger than ordinary middleware:

- if proceed is never called on an authorized read, the interceptor's result is
  the public result;
- once proceed is called, the child operation's fulfilled value or failure is
  authoritative;
- core still awaits the interceptor's completion so post-work finishes;
- a different fulfilled value returned after proceed is ignored;
- a child failure cannot be swallowed;
- if the child succeeds and post-work rejects, the extension failure
  propagates;
- if child and post-work both fail, the child failure remains primary and the
  extension failure is retained as suppressed diagnostic evidence.

This prevents:

    void proceed();
    return fabricatedSuccess;

from submitting a write and reporting an unrelated success. Query code may
inspect or mutate the same returned object after proceed because it is trusted
application behavior, but it cannot replace its static shape. The official
cache must isolate its stored value and every hit from that mutable public
object; §13.1 makes that a cache-boundary invariant.

### 7.3 Raw-operation matrix

| Surface | request | query | statement | observe | policy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Model operation | yes | yes | every typed statement | yes | every semantic scope |
| Tagged safe queryRaw/executeRaw | no | yes; must proceed | yes | yes | deny unless explicitly allowed |
| Unsafe/verbatim raw | no | yes; must proceed | no | yes, disclosure-limited | deny by default |
| Connect/disconnect | no | no | no | yes | not applicable |
| Transaction/batch container | no | no | child operations only | yes | inherited by children |

Generic query handlers receive a discriminated kind. Model/operation maps never
silently match raw calls.

### 7.4 Array transactions

Every array transaction, native or transaction-fallback, uses one internal
continuation coordinator:

1. reserve and admit every member under the same client and extension scope;
2. run request transforms, mandatory preparation, and root policy checks;
3. start each query chain;
4. suspend at each proceed call before provider work;
5. wait until every chain reaches proceed or fails;
6. require proceed exactly once for every member;
7. on failure, submit nothing;
8. execute with substrate-specific completion ordering:
   - fallback execution, parsing, and interceptor post-work stay inside the
     database transaction; a parse or post-work failure rolls it back;
   - a native batch commits when its one provider call succeeds, then publishes
     write outcomes, parses, and runs post-work with committed certainty;
9. after a successful fallback commit, publish its write outcomes;
10. settle all public results in caller order.

Read short-circuiting is refused in array mode. The official cache bypasses and
calls proceed. An asynchronous pre-proceed handler may delay admission, but it
cannot cause an earlier array member to execute.

The coordinator is internal. PendingOperation remains the only public thenable
and transaction operation.

## 8. Write outcomes

Cache invalidation is behavior, not observation. Core therefore publishes
write outcomes to registered behavioral listeners.

The facts are:

- committed — the durable unit is known committed;
- may-have-committed — dispatch happened but acknowledgement is ambiguous.

The durable unit depends on execution:

- one direct transaction;
- one native or fallback array transaction;
- one committed progressive segment;
- the outermost callback transaction.

Writes inside a callback transaction register effects on the transaction
scope. A savepoint release promotes them to its parent; rollback discards
them; only outer commit publishes them. This avoids falsely calling
transaction-local visibility a durable commit.

Rules:

- listener registration closes at the first proceed call;
- each registered listener sees each durable unit at most once;
- ambiguous dispatch publishes conservative effects;
- all listeners are attempted, with failures retained in registration order;
- if the write otherwise succeeds, listener failure rejects with commit
  certainty attached;
- if the write also fails, the write failure stays primary and listener
  failures are retained as suppressed evidence;
- the official cache listener is idempotent.

The public name may be onWriteOutcome. Do not call a pre-commit transaction
event committed.

## 9. statement — trusted low-level typed SQL

A statement transform:

- receives one fully materialized typed Sql value;
- runs synchronously before placeholder rendering;
- returns one Sql value;
- composes in extension application order;
- runs for ORM planning reads, guards, writes, result reads, and tagged safe
  raw calls;
- does not run for verbatim unsafe raw strings;
- runs in direct, transaction, fallback-batch, and native-batch execution;
- propagates failure before that invocation reaches the provider.

Example:

    const commentPrefix = raw("/* extension:query-origin */ ");

    const commented = defineExtension({
      name: "query-origin",
      statement({ statement }) {
        return sql`${commentPrefix}${statement}`;
      },
    });

The static comment is an explicit raw fragment; interpolating comment text as
an ordinary value would create a placeholder inside SQL grammar and is wrong.

This is trusted low-level authority. Checking that the return is Sql and that
its bind count fits the provider does not prove that it preserves selected
columns, write meaning, or a single SQL statement. Documentation must say that
plainly. A bad statement extension can break the query.

What remains protected is the program around the statement: the extension
does not receive or reorder steps, references, guards, postconditions, retry
state, parser shape, or transaction control.

Systematic dialect grammar remains owned by DatabaseAdapter. A custom dialect
uses a custom adapter at driver construction. Client extensions do not create
a second adapter protocol or decorate result parsing, which would invalidate
the stock-driver consumable-row proof.

## 10. observe — protected lifecycle observation

### 10.1 Completion-only continuation

An observer must be able to establish active tracing context without gaining
behavioral authority:

    observe(unit, proceed) {
      tracer.startActiveSpan(spanOptions(unit), async (span) => {
        const outcome = await proceed();
        recordOutcome(span, outcome);
        span.end();
      });
    }

proceed starts the protected child synchronously and returns a
completion-only promise. It never exposes:

- the public result;
- provider rows;
- a mutable application error;
- an ownership or transaction token.

The completion value is a deeply immutable summary such as success, normalized
error metadata, duration, and commit certainty. Core separately owns and
returns the exact child promise.

### 10.2 Failure containment

- proceed is idempotent;
- if the observer does not call it synchronously, core starts the child;
- the observer's return value is ignored;
- observer throw, rejection, asynchronous non-settlement after the callback
  returns, no-proceed, double-proceed, fabricated result, or attempted error
  swallowing cannot alter the application outcome;
- rejected observer work is consumed to prevent unhandled rejections;
- SQL and parameters follow core-owned disclosure and sanitization;
- observer result mutation is impossible because no result is exposed.

JavaScript cannot contain an observer that synchronously loops forever or does
long CPU work before returning control. Observer callbacks are trusted to
return promptly. Failure containment is not process isolation.

Observers form a protected onion only for active context. The application
outcome is never the onion's return value.

### 10.3 Lifecycle units

The read-only discriminated union covers:

- logical operation;
- physical statement;
- native or fallback batch;
- transaction and savepoint;
- progressive write segment;
- connect and disconnect;
- official cache get, set, revalidation, and invalidation.

There are no fictional beforeValidate, afterValidate, beforeBuild, or
afterParse events. The operation observer spans the real work; statement and
transaction units expose the real subdivisions.

## 11. client and model — typed surface contributions

### 11.1 Client methods

Client factories return only dollar-prefixed functions. They cannot collide
with core client members, schema model keys, or prior extension methods.
Duplicate names fail statically where provable and atomically at application
for hostile JavaScript.

The extension definition is shared, but its factory runs once for each
concrete view:

- the derived root;
- each callback-transaction view;
- each nested-transaction view.

It receives a restricted scope-common client surface: delegates, raw methods,
schema access, transaction operations, and prior extension methods. It does
not receive root-only connect, disconnect, driver, or $extends methods.
Methods that use this supplied surface are therefore correctly transaction
bound. JavaScript can still capture an external root client in the extension's
own closure; that is an explicit, author-controlled escape and cannot be
prevented by typing the factory parameter.

Methods in one returned object do not see sibling methods from that same
object. Mutually dependent additions use sequential extensions.

### 11.2 Model methods

A model factory receives the delegate from the same concrete client view and
returns functions. Added names cannot collide with core operations or a prior
method on that model. The same name on different models is legal.

A model method can return the existing PendingOperation, preserving lazy
execution and array-transaction admission.

The specialized cached client remains read-only and does not automatically
inherit arbitrary model methods, because those methods may write. Adding a
second “read-only method capability” solely for this is not justified in V1.

Example shape:

    const actorDomain = defineExtension<typeof schema>()({
      name: "actor-domain",
      client() {
        return {
          $actor: () => actor,
        };
      },
      model: {
        user(delegate) {
          return {
            findByEmail(email: string) {
              return delegate.findUnique({ where: { email } });
            },
          };
        },
      },
    });

## 12. Composition

For db.$extends(A).$extends(B).$extends(C):

| Capability | Into core | Out from core |
| --- | --- | --- |
| Request | A, B, C | not applicable |
| Query | A wraps B wraps C | C, B, A |
| Statement | A, B, C | not applicable |
| Observe | A active around B around C | completion only |
| Client/model methods | accumulated | overriding forbidden |

Mandatory validation and policy are not ordered extension handlers. They run
before an accepted read short-circuit regardless of extension order.

The official cache occupies a reserved inner query rail:

    arbitrary query interceptors
      official cache
        core execution

This means user post-processing runs on cache hits and misses, while the cache
stores the core result. Cache safety does not depend on “declare cache last.”

If any low-level statement transform is active, the official cache bypasses
unless a later measured design provides a trustworthy semantic fingerprint.
Names or function identity are not a valid cache key.

A future policy client fails closed when any arbitrary statement transform is
active. Such a transform runs after policy SQL exists and can erase a predicate
or guard. A policy-owned SQL contribution, such as a proven database-RLS
session setup, requires a separately branded composition whose policy owner
authorizes and verifies it; ordinary statement transforms never inherit that
trust.

## 13. Official extensions

### 13.1 Cache

The existing CacheDriver remains the storage protocol. The official cache
extension gets private capabilities that arbitrary extensions cannot spoof:

- canonical post-request, validated read arguments;
- exact model and operation identity;
- policy cache partition;
- write outcomes;
- cache lifecycle observation.

It contributes the current $withCache and $invalidate surface and preserves
the specialized Promise-returning read-only client.

Rules:

- reads are validated and authorized before lookup;
- array and callback-transaction reads bypass unless transaction-local caching
  is explicitly designed later;
- cached provider results never receive a consumable-row claim;
- cache put takes an isolated snapshot before outer query post-work can mutate
  the returned object, and every hit materializes a fresh public value;
- that isolation uses the compiled result shape and preserves Date, bigint,
  fixed decimal, bytes, JSON, nullability, aggregates, and relation graphs; a
  JSON stringify clone is not acceptable;
- request defaults and client projection defaults are part of the canonical
  key;
- future policy contributes principal plus effective policy
  identity/version, not only tenant ID;
- missing required policy partition fails closed or bypasses;
- progressive segments invalidate per committed segment;
- outer transaction commit invalidates after commit;
- may-have-committed invalidates conservatively;
- raw calls remain uncached;
- arbitrary statement transforms force bypass.

Move the current cache implementation onto these facts first. Delete bespoke
client/cache branches only after behavior parity.

### 13.2 Instrumentation

The official instrumentation extension consumes lifecycle observation. It
owns:

- OpenTelemetry span creation and active context;
- logger/exporter integration;
- filtering;
- duration and cache event presentation.

Core retains:

- lifecycle fact production;
- lazy correlation identity;
- exact transaction/batch/segment outcomes;
- error normalization and deduplication;
- parameter disclosure, redaction, and sanitization;
- observer failure containment.

Migration runs old and new rails together only in tests, proves identical
events and error behavior, switches configuration sugar to instantiate the
extension, then deletes duplicate wrappers. The no-observer path remains the
current zero-observation fast path.

### 13.3 Client default omit

Only client default omit moved:

- model omit remains schema truth;
- per-query omit remains query language;
- client default omit is `defaultOmit<typeof schema>()(...)`.

defaultOmit returns a branded declarative extension carrying the exact
per-model projection witness. It reuses the existing runtime resolver and
shallow fail-closed type carrier. Ordinary extensions cannot forge this
witness or gain arbitrary result mutation.

The gate passed at the measured disposition above. Built-in client omit was
deleted. The retained static ordering fact refuses `defaultOmit()` after a
schema-mapped query contribution or client/model factory whose result types
were established before omission. Request, statement, observe, a global
polymorphic query function, and official cache/instrumentation are safe before
it. Model omit remains schema truth; query omit remains call-owned projection.

## 14. Authorization and RBAC

### 14.1 What V1 safely enables

An actor-bound derived client can:

- capture actor and tenant in closures without global mutable state;
- deny top-level operations;
- patch top-level predicates and data;
- deny raw calls;
- survive transaction rebinding;
- contribute a stable cache partition.

This is useful policy scaffolding, not complete RBAC.

### 14.2 The later graph-policy capability

Complete ORM authorization becomes one declarative policy contribution in the
same extension envelope only after its contract is separately proven. Core,
not user middleware, resolves it at every semantic scope.

The policy action vocabulary must cover:

- read;
- create;
- update;
- delete;
- link and unlink.

It must also classify field use, because row predicates alone do not stop
inference:

- select and return;
- filter;
- order;
- group and aggregate;
- create/update data;
- relation traversal;
- relation link/unlink.

The core policy consumer must cover:

- root and nested reads;
- root and nested writes;
- ordinary and variant relations;
- junction membership;
- to-one projections without a user-facing where;
- unique connect/disconnect/set/connectOrCreate paths;
- planning probes and result refetches;
- retries;
- count, aggregate, and groupBy inference;
- callback, savepoint, fallback-array, and native-array transactions.

Read policies are resolved before cache lookup. Mutation policies are also
consumed during data-dependent planning below proceed. Query interception
cannot bypass either because reads are prepared before interception and
mutations must proceed.

Raw methods and arbitrary statement transforms on a policy client are denied
by default. Database-native RLS may
be supported only with exact connection and transaction pinning. VibORM cannot
infer authorization from arbitrary SQL text.

No rbac package or security claim ships until an adversarial bypass corpus
proves all these paths.

## 15. Type architecture

The initial type state stores only capabilities that V1 actually retains:

    interface ClientExtensionState<
      ClientMethods extends object = NoMethods,
      ModelMethods extends object = NoMethods,
    > {
      readonly client: ClientMethods;
      readonly models: ModelMethods;
    }

NoMethods has no keys. ModelMethods is the exact inferred object keyed by
actual schema model keys, not Record<PropertyKey, object>.

Merge rules:

- shallow-intersect client methods;
- merge exact per-model method maps;
- do not encode runtime handler lists in conditional types;
- do not prettify the complete client;
- thread state through VibORMClient, delegates, TransactionClient, and
  $extends;
- add the exact private projection witness only if the omit experiment passes.

Conceptual public signature:

    $extends<const E>(
      extension:
        E
        & ContextualExtensionDefinition<C, X>
        & ExactExtensionKeys<E, C>
        & ExtensionCollisionGuard<E, C, X>
    ): VibORMClient<C, MergeExtensionState<X, InferExtensionState<E>>>

The E intersection captures literal additions; the contextual term supplies
schema completion; structural guards reject unknown non-fresh keys and
collisions.

Public probes must cover:

- inline core-client and every driver-wrapper $extends call;
- schema-generic all-query handler;
- curried schema-bound reusable definition;
- zero, one, two, five, and ten chained extensions;
- exact select/include/omit, returning, count, aggregate, and groupBy results;
- recursive and variant schemas remaining non-any;
- root and transaction-derived methods;
- model methods returning batchable PendingOperation values;
- envelope/model/operation typos beside a real key, fresh and non-fresh;
- non-function method values;
- missing client dollar prefix;
- collisions with core, schema, and prior-extension names.

Method-name typo probes are meaningless because a new method name is
intentional by definition.

Arbitrary input/result type mutation remains deferred. Users can expose
alternate typed operations as client/model methods. A future computed-field
feature must declare field name, dependencies, validation schema, and
computation together.

## 16. Internal shape

### 16.1 ResolvedExtensionChain

The client owns one optional frozen chain containing:

- precompiled request/query/statement/observer handlers by exact operation;
- client/model method factories;
- private official-extension capabilities.

An unextended client stores undefined. It does not allocate an empty chain,
context, closure, or handler list.

Handler lookup is compiled when deriving the client, not scanned on every
operation.

### 16.2 Scope threading

QueryEngine and trusted QueryExecutionContext carry the optional chain by
identity. QueryEngine.bind(transactionDriver) preserves it and creates the
normal new transaction scope.

Caller-created context objects cannot spoof it. There is no mutable per-call
own scratchpad; handler-local variables and extension closures own state.

### 16.3 PendingOperation

PendingOperation remains the sole deferred public object. It gains only
internal state for:

- memoized request patch resolution;
- prepared query interceptor chain;
- one-shot continuation state;
- write-outcome registrations;
- array-continuation handshake;
- existing reservation and client/scope checks.

Do not implement query interception by stacking wrapExecutor: native shared
batches do not execute those wrappers.

### 16.4 Statement owner

The last common typed Sql execution/preparation boundary applies transforms
before rendering. Direct execution, preparation, transaction-bound drivers,
fallback batches, and native batches must thread the trusted context. Unsafe
raw execution stays outside.

### 16.5 Observer owner

One protected runner separates:

- the real child application promise; and
- the immutable completion promise exposed to observers.

Lifecycle calls exist only at current composition owners: PendingOperation,
driver statement/connection/transaction, client native/fallback batch,
OperationExecutor progressive segment, and official cache. No duplicate lower
layer event is added for a unit already owned above.

## 17. Implementation sequence

### E0 — Falsify the architecture first

1. Freeze current direct, callback-transaction, savepoint, fallback-array,
   native-array, raw, progressive-write, cache, omit, and instrumentation
   behavior.
2. Prototype protected observation, continuation authority, and the unified
   array coordinator.
3. Prototype types and run the full public probes.
4. Prove the no-extension path needs no new allocation.
5. Record operation-pipeline baselines for flat read, 1,000-row read, flat
   create, nested write, and 100-operation batch.

### E1 — Derived clients and typed methods

1. Add exact Extension definition validation and defineExtension.
2. Add immutable $extends and optional ResolvedExtensionChain.
3. Add client/model methods with collision rules.
4. Bind factories per concrete root/transaction view.
5. Preserve schema/relation/driver identity and add view-specific operation
   scope.
6. Prove methods using the supplied scope stay transaction-bound and document
   an externally captured root client as an explicit author escape.

### E2 — Request transforms

1. Add the operation-specific result-shape projector.
2. Run lazy synchronous patch chains before unique guard and validation.
3. Detach and restore every result-shaping descriptor.
4. Pin absent input, order, one invocation, thrown/promise/non-record output,
   validation ownership, and caller-object preservation.
5. Add count/aggregate/groupBy/returning falsifiers, not only
   select/include/omit.

### E3 — Query interception

1. Start query chains after mandatory preparation.
2. Add exact read short-circuit and mutation/raw proceed rules.
3. Make the child outcome authoritative after proceed.
4. Add deterministic dual-failure preservation.
5. Add write-outcome registration and transaction-scope promotion.
6. Implement one coordinator for native and fallback array transactions.
7. Pin direct and batch detached-proceed attacks.
8. Prove fallback parse/post-work failures roll back while native post-commit
   failures report committed certainty.

### E4 — Statement transforms

1. Thread trusted context to the common typed statement boundary.
2. Apply transforms before render in direct and prepared paths.
3. Recheck Sql instance and bind limits.
4. Cover planning, guards, writes, result reads, tagged raw, transactions, and
   both batch substrates.
5. Prove unsafe raw is unreachable and unchanged.

### E5 — Protected observers

1. Add immutable lifecycle units and completion summaries.
2. Implement the protected runner.
3. Instrument each existing composition owner once.
4. Falsify result mutation, error mutation/swallowing, throw, rejection,
   asynchronous non-settlement, no-proceed, double-proceed, and fabricated
   return.
5. Prove application result, error identity, and commit are unchanged; prove a
   never-settling observer promise does not delay the application after its
   callback returns.

### E6 — Instrumentation extraction

Move instrumentation onto observe, prove event/error parity, switch config
sugar, delete duplicate owners, and preserve the no-observer fast path.

### E7 — Cache extraction

Move cache onto the reserved logical rail and exact write outcomes. Prove
policy partitioning, transaction behavior, progressive invalidation, ambiguous
dispatch, statement-transform bypass, borrowed cached rows, and cache value
isolation from outer query mutation before deleting bespoke branches.

### E8 — Client default omit experiment

Prototype the declarative witness, run all result/type/performance gates, and
retain only on exact parity. Otherwise leave the built-in intact.

### E9 — Graph policy design

Write and adversarially review a separate policy plan. Map every model,
relation, membership, field-use, planning, retry, raw, and transaction path
before implementation. Prove arbitrary statement transforms are refused on a
policy client.

### E10 — Documentation and deletion

Document authoring and security contracts, update applicable AGENTS files only
for retained architecture, delete superseded owners, and add a census against
a second middleware/plugin registry or public operation-program export.

## 18. Gates

Run sequentially under the workspace lock:

1. focused extension runtime and public type tests;
2. client, query-engine, validation, driver, instrumentation, and cache layers;
3. relevant write-engine and coverage gates;
4. package build and package export tests;
5. SQLite3, PGlite, PostgreSQL, MySQL2, D1, and Neon direct/transaction/batch
   contracts;
6. test:core, test:all, and provider suites;
7. repository-pinned Biome on every touched TypeScript file;
8. five alternating fresh-process A/B operation-pipeline runs.

Type measurements use:

    node scripts/run-node-safe.mjs 4096 300000 \
      node_modules/typescript/bin/tsc --noEmit --extendedDiagnostics

Discard one warm-up and take at least three measured runs in exact clean
baseline/candidate worktrees. Record median wall time, peak process-group RSS,
Instantiations, Memory used, and TS2589/TS2590 count.

Deterministic instantiations may not regress over 5%. Wall time,
TypeScript-reported memory, and peak process-group RSS are recorded for
attribution; they are not independent percentage rejection gates. The hard
limits remain 300 seconds and 4 GiB for the candidate.

Runtime performance requirements:

Each time cap applies independently to `cpuMicrosecondsPerOperation` and
`wallMicrosecondsPerOperation` for the stated semantic unit.

- unextended pipeline: zero added allocations and no handler scan;
- method-only client/model capabilities: below 3% overhead;
- request: at most 5 KiB allocation and 5 microseconds per logical operation;
- query: at most 16 KiB allocation and 5 microseconds per logical operation;
- statement: at most 2 KiB allocation and 3 microseconds per physical
  statement;
- observe: at most 4 KiB allocation and 6 microseconds per emitted lifecycle
  unit;
- a delta beyond 2×MAD is real and is compared with its capability budget; it
  is not an automatic refusal;
- no per-row extension cost unless extension code itself maps rows;
- no per-statement closure allocation in an unobserved/untransformed batch;
- retained heap and peak RSS: no regression over 10%.

## 19. Completion criteria

The foundation is complete only when:

1. $extends creates an immutable derived client and leaves its base unchanged.
2. Exact chains survive callback, nested, fallback-array, and native-array
   transactions.
3. Client/model methods bind to the active transaction view and infer
   naturally.
4. Request patches run once, preserve every result-shaping descriptor, and add
   no second validation pass to any existing semantic boundary.
5. No read short-circuit bypasses validation or policy.
6. No mutation/raw interceptor can fabricate success without proceed.
7. After proceed, the core child outcome is authoritative.
8. Every array member reaches the same extension lifecycle before any effect.
9. Statement transforms preserve Sql parameter ownership and cover every typed
   execution path.
10. Observers receive no result or mutable application error and cannot alter
    result, error, or commit state; synchronous latency remains subject to
    §10.2.
11. No private program, relation, result-ownership, or transaction token is
    public.
12. Instrumentation is proven on observe before old wrappers are deleted.
13. Cache is proven on canonical keys, policy fingerprints, and durable write
    outcomes before old branches are deleted, and outer result mutation cannot
    poison a later hit.
14. Client default omit moves only if runtime, static, and type-cost parity
    pass.
15. No complete-RBAC claim ships before graph and field-use proofs.
16. Policy clients reject arbitrary statement transforms unless the policy
    owner explicitly proves and authorizes their composition.
17. Fallback parse and interceptor post-work failures retain rollback behavior;
    native post-commit failures report their committed state.
18. The unextended client preserves baseline behavior, SQL, errors, types, and
    performance.

## 20. Explicit non-designs

The following are deliberately rejected:

- one universal hook;
- public hooks inside validator nodes;
- a mutable query-program AST;
- a public validated-arguments mutation token;
- bare SQL-string replacement disconnected from values;
- arbitrary runtime result-type casting;
- “declare cache last” as a security rule;
- silently bypassing or refusing every extended array transaction;
- mutable per-call scratchpads shared by hooks;
- top-level filter injection marketed as RBAC;
- omit marketed as field security;
- parsing arbitrary raw SQL for authorization;
- extension priority numbers;
- global mutable extension registration;
- a second adapter or result-parser protocol.

The asymmetry is the design: request code may change untrusted input, but not
trusted validation; query code may deny work or cache an authorized read, but
not fabricate a submitted write; statement code is explicitly trusted and
low-level, but never sees the operation program; observers can hold active
context, but never touch the application result. This gives extensions real
power without dissolving the owners that make VibORM correct.
