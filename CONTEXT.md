# VibORM Domain

This glossary names the relation concepts that distinguish public cardinality
from the stored association between records.

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

**Series member**:
One record operation that a transactional record series runs — an ordinary
single-record operation with its own locate, guards and failure, of which the
series runs N in sequence. It is the ATOM's sense of "member" and has nothing to
do with a membership's stored members.
_Avoid_: Member on its own where a membership is also in scope

## Reading a relation

One stored topology, several derived views. A relation is declared once; its
cardinality, its clearability, and its physical membership are each DERIVED from
that declaration by one named owner, never stored beside it and never
re-derived at the point of use.
