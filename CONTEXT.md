# VibORM Domain

This glossary names the relation, write-execution, exact-value, search, and
planned client-extension concepts whose distinctions carry domain meaning
across VibORM's schema, migration, query, and client boundaries.

## Relation language

**Relation slot**:
The public model position from which one association is read or mutated. It
declares a slot cardinality and a target domain; slot emptiness is derived from
its storage or, for variant to-one storage, its explicit optionality.
_Avoid_: Relation edge when the local public position is meant

**Slot cardinality**:
Whether one relation slot holds at most one membership or a collection of
memberships. It belongs to that slot, not to the relationship as a whole.
_Avoid_: Relation kind, when only one endpoint's one/many choice is meant

**Relation target domain**:
The model domain one relation slot may address. A single-model domain contains
one lazily resolved model; a variant domain contains one or more named target
model alternatives. Target domain and slot cardinality are independent facts.
_Avoid_: Relation family, polymorphic relation type

**Relation name**:
An optional pairing label on a relation slot. When a relationship has two
public slots, both repeat the same label; matching names distinguish that pair
from other relationships between the same models.
_Avoid_: Inverse selector, inverse field, relation type

**Relation topology**:
The one-to-one, many-to-one, one-to-many, or many-to-many shape derived from
the cardinalities of both relation slots.
_Avoid_: Stored relation type, cardinality of one slot

**Polymorphic variant**:
One named target-model alternative in a polymorphic relation. Its public name
and stable storage identity are distinct facts.
_Avoid_: Type when target model, public name, or stored identity must be clear

**Polymorphic collection**:
A to-many relation slot whose memberships can use different polymorphic
variants while remaining one public collection.
_Avoid_: Polymorphic many-to-many, because the inverse slot may be singular

**Member junction**:
The fixed-target junction table that stores one polymorphic collection
variant's memberships between the owner and that variant's model.
_Avoid_: Ordinary junction, because a member junction has an owner side and a
variant side rather than two reconciled peers

**Member view**:
An inverse relation slot whose membership is stored in a member junction it
does not own — a storage-less `toOne` or `toMany` bound to a polymorphic
collection member. It declares no storage of its own and emits no junction
table.
_Avoid_: Inverse junction, because the view reads a table the collection owner
declared rather than one reconciled between two peers

**Membership**:
The stored association between an owner and a target.
_Avoid_: Slot, target row

**Clearable membership**:
A membership whose stored association can be removed while both records remain.
_Avoid_: Optional slot

**Orphaned membership**:
A non-empty membership whose target does not exist, which is an invalid domain
state.
_Avoid_: Empty relation, null relation

**Row key**:
The ordered fields used to address one record. A row key is usually the primary
key and may contain several members.
_Avoid_: Identity when the fields or their order matter

**Addressable key**:
An ordered unique key that a public unique selector can use to name one record.
A model can have several addressable keys.
_Avoid_: Identity fields, unique field set

**Reference key**:
The ordered target fields to which a relation points. A reference key can differ
from the target's row key, such as when a relation references a compound unique
key.
_Avoid_: Row key unless both keys are known to be the same

**Referenceable key**:
An ordered key that stored relation membership may legally reference. It can be
wider than the public addressable keys when schema and database rules permit it.
_Avoid_: Addressable key unless both capabilities are known to agree

**Stored reference**:
The ordered correspondence between storage members and the fields of a
reference key.
_Avoid_: Foreign key when the storage is polymorphic or belongs to a junction

**Junction side**:
The complete ordered stored reference from a junction row to one endpoint. A
junction has two sides, and either side may contain several members.
_Avoid_: A column, B column

**Membership key**:
The complete stored fact that identifies one relation membership. It can combine
stored references with fixed qualifiers such as a polymorphic discriminator.
_Avoid_: Identity, reference key

**Recursive hierarchy**:
The nested expansion of a self-targeting collection whose membership is stored
by a foreign key on each child. A returned record has at most one predecessor
through that relation. Traversal is numerically bounded by default and can be
made exhaustive with `depth: false`; an encountered cycle is invalid hierarchy
data.
_Avoid_: Graph traversal, recursive relation kind

**Graph walk unfolding**:
The nested expansion of a self-targeting junction collection. Direction is the
asking relation slot's resolved orientation through the shared junction. A
database row reached by several directed walk prefixes appears once for each
prefix. Numeric traversal can explicitly repeat cycles through its cutoff;
`depth: false` instead exhausts simple paths and requires active-path cycle
prevention.
_Avoid_: Tree, flat transitive closure, symmetric traversal

**Traversal occurrence**:
One public appearance of a database row at one position in a recursive
hierarchy or graph walk. Several graph occurrences may represent the same row,
but each is a fresh object and none is a shared or cyclic object reference.
_Avoid_: Node identity, duplicate row

**Record field publication**:
Making the exact value of one record field produced by an INSERT or UPDATE
available to later mutation work. Publication may use an existing statement
output, planning value, final reference, or a focused read of the same record;
it does not imply that the field identifies the record.
_Avoid_: Identity when the field is not a row key, generated identity when the
value can also come from an UPDATE or an ordinary database-produced field

**Consumed field publication**:
Publishing, after a successful statement, the exact pre-cast literal or prior
record output that the same statement wrote. It proves value transport, not
database generation, and cannot cross a committed boundary while still encoded
as batch scratch.
_Avoid_: Generated identity, branch result

**Progressive boundary premise**:
What a nested record series re-asserts in every write batch after a committed
segment. It is TWO facts, never one: **parent liveness**, the parent's complete
row key, and **exact membership**, the referenced value the later writes will
store. Liveness cannot be proved by a reference value, and membership cannot be
proved by a live row key — between two commits a referenced value can move to a
different row while the row key still resolves. A premise that cannot be stated
exactly declines the placement instead of guarding half of it.
_Avoid_: Parent guard, existence check

**Selected-row continuity**:
Proof that later relation work still addresses the exact record chosen by the
original locate when that record's row key changes. It carries the complete
row key before and after the change plus the placement that decides which one
names the record at that moment; it never re-runs the original selector.
Portable continuity identifies the logical record by complete key and exact
membership. Distinguishing delete-and-reinsert of the same key requires an
explicit version fact.
_Avoid_: Same ID, old ID/new ID

## Write-execution language

**Record tree**:
One record mutation together with the nested record and relation mutations it
owns.
_Avoid_: Record series, bulk write

**Record series**:
An ordered sequence of record trees in which a later member may observe the
effects of earlier members.
_Avoid_: Bulk statement, record tree

**Write segment**:
One provider submission whose user-table writes share one commit or rollback
decision. A segment can contain part of a record tree or one complete member.
_Avoid_: Record member, public operation, SQL statement

**Operation-atomic execution**:
Execution in which every write of one public operation commits or rolls back
together.
_Avoid_: Transactional when only one internal segment is atomic

**Segment-atomic execution**:
Execution in which each ordered write segment commits or rolls back
independently, so a later failure can leave an earlier segment committed.
_Avoid_: Atomic operation, best-effort transaction

**Series member**:
One record operation that a transactional record series runs — an ordinary
single-record operation with its own locate, guards and failure, of which the
series runs N in sequence. It is the ATOM's sense of "member" and has nothing to
do with a membership's stored members.
_Avoid_: Member on its own where a membership is also in scope

## Exact value language

**Fixed decimal**:
An exact decimal domain with a declared maximum digit count, fractional scale,
and rounding rule. Its values lie on multiples of `10^-scale`; values outside
that finite domain are invalid rather than approximate.
_Avoid_: Float with formatting, database DECIMAL spelling

**Unscaled decimal value**:
The signed integer coefficient that names a fixed decimal before its declared
scale is applied.
_Avoid_: Cents, because the scale need not be two

**Fixed decimal list**:
An ordered list of non-null decimal values that all belong to one fixed-decimal
domain. Nullability applies to the whole list, not to individual elements.
_Avoid_: Decimal array when the shared descriptor or element nullability matters

## Search language

**Search declaration**:
The model-level intent that names searchable fields, composites, attributes,
and an optional implementation preset.
_Avoid_: Search index when referring only to public schema intent

**Resolved search definition**:
The final-model form of a search declaration, including its ordered row key,
mapped members, implementation identity, and semantic revision.
_Avoid_: Search program, search deployment

**Search deployment**:
The complete reconstructable database artifact group that maintains one
resolved search definition.
_Avoid_: Search table, search index when referring to the whole artifact group

**Search query source**:
The provider-compiled, joinable source that exposes one search row per source
record, its complete row-key join, rank, and declared attribute expressions.
_Avoid_: Search predicate when rank or attributes must reach the outer query

**Matched set**:
The records selected by one normalized search query together with its model and
attribute filters, before projection or faceting.
_Avoid_: Hits when pagination or projection has already narrowed the records

## Physical database language

**Namespace**:
The SQL qualifier for one driver's persistent objects: a PostgreSQL schema,
MySQL database, or requested Vitess keyspace qualifier. A Vitess qualifier may
be redirected and is not a PlanetScale database resource, shard, tenant,
SQLite attachment, or proof of the final backend.
_Avoid_: Database schema or database name as the cross-dialect public term

**Migration namespace attestation**:
The MySQL2 caller's explicit `"non-redirecting"` assertion that qualified
database references cannot be remapped by the transport during effectful
migration work. It does not select a namespace and is never inferred from a
driver class, URL, handshake, host, or server version.
_Avoid_: Backend detection, migration permission, or a second namespace value

## Client-extension language (planned)

**Client extension**:
One immutable, named contribution applied to a client view. Its optional
members attach to existing request, query, statement, observation, client, or
model owners; it is not a mutable plugin registry or a second query pipeline.
_Avoid_: Universal hook, plugin manager

**Derived client**:
The lightweight client view returned by `$extends()`. It shares schema and
database infrastructure with its base, while carrying an immutable extension
chain and a distinct operation scope. A transaction view inherits that exact
chain but binds contributed methods to the transaction scope.
_Avoid_: Client clone, mutable extended client

**Request transform**:
A synchronous patch over the non-result-shaping part of one unvalidated model
operation input. Core preserves the caller's result-shaping descriptors and
feeds the final patched input through the existing semantic validation flow
without an extra validation pass.
_Avoid_: Validation hook, argument middleware

**Query interceptor**:
An asynchronous wrapper around one prepared logical operation. An authorized
read may complete without provider execution; a mutation or raw operation must
run its continuation or fail. Once the continuation starts, its outcome is
authoritative.
_Avoid_: Query middleware when ordinary replacement semantics are implied

**Statement transform**:
A trusted, synchronous transformation of one materialized typed `Sql` value
before placeholder rendering. It can change low-level SQL, but it never
receives the surrounding private operation program.
_Avoid_: SQL-string hook, adapter when dialect grammar is meant

**Lifecycle observer**:
A read-only wrapper around a real operation, statement, transaction, batch,
segment, connection, or cache lifecycle unit. It receives completion metadata,
not the application result, and its failures cannot alter application behavior.
_Avoid_: Query interceptor, event handler with behavioral authority

**Query policy**:
A graph-wide authorization rule consumed by core at every affected model,
membership, and field-use scope. A top-level request filter is policy
scaffolding, not a complete query policy.
_Avoid_: RBAC when only root arguments are filtered

## Reading a relation

One declaration, several derived views. A relation slot declares its cardinality
and target domain once. The paired topology, clearability, and physical
membership are each derived by one named owner, never stored beside their
inputs and never re-derived at the point of use.

## Client-extension language (implemented)

The earlier planned-language entries are now implemented with six exact
capabilities: request transformation, query interception, statement
transformation, protected lifecycle observation, client methods, and model
methods. `$extends()` returns an immutable derived client with one compiled
ordered chain and a distinct operation scope.

The official `cache()`, `instrumentation()`, and `defaultOmit()` factories own
private unforgeable capabilities. They replace the retired built-in
`createClient` cache, instrumentation, and client-omit configuration. Cache
keys use canonical validated-operation identity; a custom key is a suffix.
Cached values are detached snapshots and every hit materializes a fresh graph.

Protected observation covers operation, statement, batch, transaction,
savepoint, progressive segment, connection, and cache lifecycle units. Public
observers receive only frozen unit/completion facts. Their failures and returned
promises cannot affect the application. Official instrumentation uses the same
rail with private facts and independent disclosure policy.

`defaultOmit()` may follow request, statement, observe, a global polymorphic
query contribution, or official cache/instrumentation. It cannot follow a
schema-mapped query contribution or client/model factory whose result types
were established before omission. Model omit remains schema truth; query omit
remains call-owned projection. Omit is not authorization, and VibORM does not
yet expose an RBAC helper: complete policy still needs graph-wide semantic
model, membership, field-use, raw, and statement authority.

## Migration V1 language

**Estate**:
One storage root holding an immutable target descriptor, content-addressed
schema snapshots, SQL blobs, and committed state manifests. It is not a journal
and has no mutable head.
_Avoid_: Migration directory when the authenticated graph is meant

**Snapshot**:
One canonical description of the VibORM-managed schema at a state. Equal
snapshots do not prove equal migration state.
_Avoid_: Latest schema file, live catalog dump

**SQL blob**:
Plain review SQL that contains every check, forward dispatch, and rollback
dispatch for a state. Production executes authenticated UTF-8 slices, not
reparsed text.
_Avoid_: Numbered up/down files, delimiter-split script

**State**:
One graph node identified by its canonical manifest hash. A name is metadata
only. A merge state holds one complete transition from each parent.
_Avoid_: Migration index, journal entry, filename order

**Marker**:
The database's last confirmed state, arrival path, snapshot, estate, path hash,
and revision. Compare-and-swap is the only write.
_Avoid_: Tracking table, applied-migrations list

**Ledger**:
Append-only database evidence of attempts, confirmed steps, outcomes, baselines,
and reset progress. It is not derived from the marker.
_Avoid_: Journal, apply history reconstructed from files

**Push plan**:
An ephemeral, baseline-specific live program. Consent is bound to its hash.
Push never writes estate storage or the marker.
_Avoid_: Generated migration, estate transition
