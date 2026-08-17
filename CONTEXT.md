# VibORM Domain

This glossary names the relation and exact-value concepts whose distinctions
are part of VibORM's public semantics.

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

## Reading a relation

One stored topology, several derived views. A relation is declared once; its
cardinality, its clearability, and its physical membership are each DERIVED from
that declaration by one named owner, never stored beside it and never
re-derived at the point of use.
