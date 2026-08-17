# VibORM Domain

This glossary names the relation and search concepts whose distinctions carry
domain meaning across VibORM's schema, migration, and query boundaries.

## Relation language

**Relation slot**:
The public position whose cardinality determines whether having no member is a
valid state.
_Avoid_: Relation field when discussing absence semantics

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

**Membership key**:
The complete stored fact that identifies one relation membership. It can combine
stored references with fixed qualifiers such as a polymorphic discriminator.
_Avoid_: Identity, reference key

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
