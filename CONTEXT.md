# VibORM Domain

This glossary names the relation, write-execution, exact-value, and search
concepts whose distinctions are part of VibORM's public semantics and carry
domain meaning across its schema, migration, and query boundaries.

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

## Reading a relation

One declaration, several derived views. A relation slot declares its cardinality
and target domain once. The paired topology, clearability, and physical
membership are each derived by one named owner, never stored beside their
inputs and never re-derived at the point of use.
