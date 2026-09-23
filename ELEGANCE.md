# Elegance — fewer independent truths, more expressive composition

> Elegance is the minimum number of independent concepts needed to make the
> required behaviour inevitable.

The goal is not cosmetic cleanliness. It is fewer independent decisions to
understand, change and verify, with less code and less work to extend it.
Start from required behaviour and constraints, not the entitlement of existing
code to survive. Preserve a mechanism because its responsibility is necessary.

This is a reusable design and review standard, not authorization to refactor.
Apply it within the user's task: analysis stays analysis; implementation stays
within agreed scope and compatibility decisions. Layer guides and active plans
own exact contracts, evidence gates and budgets.

## Principles

### 1. One necessary fact, one authority

Distinguish declared facts, derived views and observations. Establish immutable
facts once at their rightful owner. Derive what follows instead of maintaining
another independently mutable answer. Reobserve what can change. “Once” has a
scope and lifetime; it does not mean caching everything forever.

A decision belongs at the first boundary with enough information **and authority**
to decide it at the required time. Consumers use the answer rather than another
interpretation of its inputs. Several projections of one meaning are legitimate;
several authorities for that meaning are not.

### 2. Resolve meaning once; lower it where needed

Prepare admitted meaning independently of physical realization. Execution,
dependency analysis and decoding should consume that meaning instead of each
parsing the public vocabulary. Keep physical details with their existing owner;
construct only the path actually needed.

Do not manufacture an intermediate language for every helper. An inspectable
representation earns its cost when real consumers need shared meaning, deferred
work or analysis. A small interpreter hiding a large compiler is not compression.

### 3. Share structure without erasing distinctions

When analysis and execution describe the same composition, use one authoritative
structure with the traversals each needs. Logical order and physical phases need
not be one total order. Attach effects and dependencies to their semantic cause
instead of recovering ownership through a parallel history.

Distinguish a reusable definition from each placed occurrence. Reuse construction
rules through composition and ordinary recursion, not another occurrence's
evaluated state. A template's earlier answer is not proof about every instance.
Do not build interpreters per placement, depth or verb when the same rule applies.

### 4. Broad context, precise ownership and lifetimes

A broad operation context can remove parameter cascades and expose facts children
need. It must not mix every responsibility and lifetime into one mutable bag.
Compose behavioral owners around genuine invariants; mutations of parent state
go through methods that preserve them. Prefer composition. Inheritance needs
genuinely substitutable implementations, not merely fewer parameters.

Separate prepared intent, attempt-local observations/bindings, and durable
acknowledged progress. Where retry semantics permit, replace an attempt's owned
state together instead of teaching each field how to reset. Keep durable facts
outside replacement. Do not erase committed work or uncertain outcomes.

### 5. Validate at real boundaries; trust below them

Validate untrusted input where it becomes a domain value. Preserve that
boundary's timing, including deferred admission. Downstream code trusts the
value instead of parsing or checking its shape again. Replaying an admitted
occurrence does not itself authorize repeating defaults or transforms.

Provider results, external errors and genuinely new representations may cross
new trust boundaries. Existence, membership, concurrency and affected-row
requirements are execution facts, not payload validation. Preserve their exact
checks. For each guard, name the distinct failure or boundary it alone owns.

Use precise types. Where project rules permit, a narrow assertion can express an
invariant already established upstream; it cannot establish a missing fact.
Do not add runtime defense or elaborate generics solely to avoid an honest
assertion. Never hide an impossible state behind plausible empty output.

### 6. An observation is not a lasting requirement

What was found, how it was selected, and what must remain true at consumption
are different facts. Initial absence differs from loss after observation;
identity differs from membership. Enforce requirements where their loss would
make an effect incorrect, using the actual substrate's guarantees.

Caching an observation needs a valid lifetime and invalidation story. An earlier
absence does not establish later absence. Re-entry and concurrency must not
silently turn an observation into permanent truth.

### 7. Semantics do not follow physical packaging

Result shape, cardinality and identity are independent of statement count,
batching, chunking or transport format. An aggregate value need not pretend to
be an addressable row. Prepare one output description for physical lowering and
decoding; do not construct execution work merely to obtain its shape.

Share semantic rules without forcing incompatible physical algorithms together.
Set mutations and ordered record series may need different paths. That does not
justify duplicate admission, assignment, relation or codec semantics. Pure reads
must not acquire write machinery merely for uniformity.

### 8. Capability does not grant authority

An available mechanism does not mean the caller owns permission to use it.
Borrowing a resource does not grant lifecycle, rollback, retry or cleanup
ownership. Keep those decisions with the boundary that owns them, not consumers
rediscovering permission from capabilities.

Children perform their work; the enclosing owner completes the larger operation
and releases resources still needed by siblings. Error propagation must remain
inside that owner too: for example, `return await` is necessary when rejection
must be caught by the current `try/catch`. An apparently redundant step may
carry a real lifetime or failure boundary.

### 9. One semantic rule across its real consumers

If consumers must agree on an operation's meaning, share that meaning—not just
a name or signature. Mutation arithmetic and final-key derivation must not grow
independent operator implementations; codecs must not be reinvented per verb.
Extend the existing owner and test another applicable consumer or placement.

Necessary branches are not a failure of abstraction. Provider, storage, choice
and failure distinctions can be irreducible. Remove duplicated decisions and
synchronization rules, not every conditional. Similar syntax with different
meanings should remain separate.

### 10. An abstraction must pay for itself

Prefer deleting a rule, deriving a fact, moving a decision to its rightful owner,
strengthening a representation, or composing existing owners before adding a
concept. Add one when existing owners cannot express a necessary responsibility
without conflict or duplication.

Do not split files solely for size, merge code solely for similar syntax, or
create wrapper classes, strategies, registries and extension hooks for imagined
consumers. A class earns its place by owning behavior or an invariant, not by
renaming a parameter bag. One genuine boundary can justify an abstraction;
multiple call sites alone cannot.

## Apply the principles

Before a consequential change, inspect relevant code, contracts and the current
worktree. Establish the bounded goal and baseline, then answer:

1. What necessary behaviour or distinction must the system express?
2. Which owner has the information, authority and lifetime to own it?
3. What disappears, and which invariant makes it unnecessary?
4. What results, failure timing, order and progress must remain intact?
5. What witness would falsify this ownership, including another applicable use?

Do not turn these questions into a production framework. When a witness fails,
identify the missing fact and repair its owner. Do not scatter fixes across
symptoms or widen scope to work around failure.

Removing a refusal makes previously unreachable paths reachable. Check their
result modes, empty cases, siblings, repeated placements and failure boundaries,
not only the first success. Expected outcomes must be independent of candidate
implementation; a green test copied from its assumptions proves little.

Preserve public results, error identity and timing, atomicity, admission and
progress unless a behaviour change is authorized. A legacy bug is not automatic
permission to change an observable contract. Delete superseded mechanisms and
obsolete implementation-only pins, but retain behavioral witnesses and historical
evidence. An active comparison specimen stays outside the shipped graph, never
as a hidden fallback.

## Measure compression and extension cost

Fewer LOC and tokens are real objectives, not forbidden optimizations. They are
not sufficient proof of elegance. Count the whole relevant production perimeter,
including moved/shared code; separate tests, evidence and retired comparison
code. Shorter names, denser formatting and moved work are not semantic gains.

Measure decisions and exceptional paths as well as code. For an extension,
record which owners and independent rules changed. A larger foundation can be
justified by demonstrated lower extension cost or fewer semantic decisions—not
a promise that future features will be free. Test that claim through
representative implemented extensions when it drives the decision.

No arbitrary percentage overrides correctness or agreed review policy. Report
growth honestly and justify necessity. A feature may add new meaning without
deleting anything; say “no deletion” instead of inventing cleanup to claim
compression. Source savings do not establish bundle, allocation, latency or
throughput improvements; measure those separately.

## Evidence and completion

Work in coherent units with focused checks and cross-position witnesses. For
larger changes, review integrated code before expensive qualification, then
freeze source and harness. Resource-bound validation against an exact identity
matters more than repeated runs against a moving target. Follow the active
plan's gates and stop rules; this document grants no additional repair budget.

Retain required proof, not just summaries. Keep failed attempts failed, preserve
historical identities and put later attestations outside sealed evidence.
Packaging-only repair can reuse intact proof for unchanged code; missing
evidence cannot be inferred into existence.

A compression claim succeeds when required behavior remains intact and the diff
demonstrates fewer independent decisions: one authority replaces several, a
special case becomes ordinary, an invalid combination disappears, or a redundant
mechanism is removed without reappearing elsewhere. “Never needed again” means
while the named invariant holds, not under every future feature.

Report consolidated truths, actual deletions, rightful owners, measured cost
and behavioral evidence. State irreducible complexity and uncertainty. Green
fixtures alone are neither structural proof nor completion.

## Local application

Raptor 3's concrete owners, retired mechanisms and execution contracts live in
[its architecture guide](src/query-engine/raptor3/AGENTS.md). Its active
[implementation plan](docs/architecture/raptor3-implementation-plan.md) owns
qualification and adoption. The [G4 handoff](docs/architecture/raptor3-g4-claude-handoff.md#rules-we-learned-the-hard-way)
maps these principles to that checkpoint. Keep those details local rather than
turning every engine-specific contract into a universal coding rule.
