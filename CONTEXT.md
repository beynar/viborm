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
