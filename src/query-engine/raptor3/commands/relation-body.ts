import { NestedWriteError } from "@errors";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { unreachable } from "../shared/invariant";
import type { PreparedSelector, SelectorFacts } from "../shared/query";
import { entries, type Input, record } from "../shared/schema";
import {
  bindMembership,
  type Membership,
  storedFields,
} from "../shared/storage";
import { Assignments, type FieldValue, type Origin } from "./assignments";
import type {
  AbsenceRequirement,
  Choose,
  CommandOccurrence,
  Commands,
  Deletion,
  JunctionCapture,
  MembershipRequirement,
  RecordCommand,
  Removal,
  SelectedSeries,
  SeriesCapture,
  SeriesOccurrence,
  SetMutation,
} from "./commands";
import { membershipRaceFailure } from "./commands";
import {
  type BoundMembership,
  membershipFields,
  nestedTargetAddressesConstraint,
  type Selection,
  type SelectionSource,
} from "./selection";

type Junction = Extract<Membership, { kind: "junction" }>;
type Supplier =
  | { readonly kind: "query"; readonly selector: PreparedSelector }
  | { readonly kind: "producer"; readonly producer: Assignments };

const mutationOrder = [
  "disconnect",
  "delete",
  "create",
  "connect",
  "connectOrCreate",
  "upsert",
  "update",
  "set",
  "updateMany",
] as const;
const collectionMutationOrder = [
  "disconnect",
  "delete",
  "update",
  "upsert",
  "connectOrCreate",
  "set",
  "updateMany",
  "deleteMany",
  "connect",
  "create",
  "createMany",
] as const;
/**
 * The relation-write vocabulary, DERIVED from the two orders that already own
 * it — the orders are what runs a payload's verbs, so nothing can be a verb
 * here without being one there. Validation's nested-write object schemas
 * (`validation/relations/{create,update,to-one-mutation-schema}.ts` and
 * `relations/polymorphic/{create,update,collection-mutation}.ts`) are strict
 * by `primitives/object.ts`'s default and admit no other key, which is what
 * lets {@link RelationBody.expand} name the payload's keys at this type.
 */
type RelationVerb =
  | (typeof mutationOrder)[number]
  | (typeof collectionMutationOrder)[number];

/** Two admitted unique selectors address the same row. */
function sameTarget(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>
): boolean {
  return (
    left.size === right.size &&
    [...left].every(
      ([field, value]) => right.has(field) && Object.is(right.get(field), value)
    )
  );
}

/** One admitted relation body owns its order, parent, slot and supplied continuation. */
export class RelationBody {
  private supplier?: Supplier;
  private readonly direct: boolean;
  private readonly hasSupply: boolean;
  constructor(
    private readonly commands: Commands,
    private readonly parent: RecordCommand,
    private readonly slot: ResolvedSlot,
    private readonly admitted: Input,
    private readonly raw: Input
  ) {
    this.direct =
      !slot.member &&
      (slot.edge.kind === "variantRowCarrier" ||
        slot.edge.kind === "variantJunctionCarrier");
    this.hasSupply = ["create", "connect", "connectOrCreate", "upsert"].some(
      (verb) => admitted[verb] !== undefined
    );
  }
  private supply(target: RecordCommand | Choose): void {
    if (this.direct) return;
    this.supplier =
      target.kind === "choose" && !target.missing
        ? { kind: "query", selector: target.lookup.selector }
        : { kind: "producer", producer: target.fields };
  }
  expand(): void {
    const parent = this.parent;
    const resolved = this.slot;
    const name = resolved.slot.field;
    const mutation = this.admitted;
    const rawMutation = this.raw;
    const direct = this.direct;
    const schema = this.commands.context.schema;
    const order: readonly string[] =
      parent.model["~"].state.relations[name]!["~"].state.cardinality === "many"
        ? collectionMutationOrder
        : mutationOrder;
    const bound = new Map<string | undefined, Membership>();
    const membership = (variant?: string) => {
      let edge = bound.get(variant);
      if (edge) return edge;
      edge = bindMembership(schema, parent.model, name, variant);
      bound.set(variant, edge);
      if (parent.fields.operation === "update" && edge.kind === "reference") {
        const keys = schema.keys(parent.model);
        for (const pair of edge.pairs)
          if (edge.owner === "source" || !keys.includes(pair.source))
            parent.fields.requireLiteral(pair.source, edge.name);
      }
      return edge;
    };
    // Admission is the boundary: the relation's nested-write schema admits
    // only the keys of {@link RelationVerb}, so the admitted payload's entries
    // are read AT that type here, once, and every consumer below trusts it
    // (ELEGANCE §5).
    const verbs = Object.entries(mutation).sort(
      ([a], [b]) => order.indexOf(a) - order.indexOf(b)
    ) as [RelationVerb, unknown][];
    for (const [verb, payload] of verbs) {
      if (payload === undefined) continue;
      // One origin per verb for what the verb does as a whole (a set's clear,
      // a variant carrier's clear); each payload ENTRY of a verb is its own
      // mutation and gets its own origin (N1): entries run in declaration
      // order, a later entry's read observes an earlier entry's write, and a
      // mutation's own effects — placed behind its read — are told apart from
      // a sibling entry's by that origin.
      const origin = this.commands.createOrigin(name, verb);
      const entryOrigin = () => this.commands.createOrigin(name, verb);
      if (!direct) {
        this.relation(membership(), verb, payload, rawMutation[verb], origin);
        continue;
      }
      if (
        resolved.edge.kind === "variantRowCarrier" &&
        verb === "disconnect" &&
        typeof payload === "boolean"
      ) {
        const clearability = schema.clearability(resolved);
        if (payload && !this.hasSupply && clearability.kind === "columns") {
          const owner = this.commands.place(
            parent,
            { kind: "membership" },
            "before"
          );
          const contribution = {
            origin,
            scope: resolved,
            identity: parent.located?.facts,
          };
          for (const field of clearability.fields)
            parent.fields.contribute(
              field,
              { kind: "literal", value: null },
              `Cannot disconnect relation '${name}'.`
            );
          this.commands.publishMembership(owner, parent.fields, contribution);
        }
        continue;
      }
      if (verb === "set") {
        const carrier = resolved.edge as Extract<
          typeof resolved.edge,
          { kind: "variantJunctionCarrier" }
        >;
        const targets = entries(payload).map((tagged) => {
          const edge = membership(tagged.type as string);
          return {
            edge,
            target: this.setTargets(edge, [record(tagged.where)], origin)[0]!,
          };
        });
        for (const member of carrier.members)
          this.clearMembership(membership(member.variant), [], origin);
        for (const { edge, target } of targets) this.association(edge, target);
        continue;
      }
      for (const [index, tagged] of entries(payload).entries()) {
        const origin = entryOrigin();
        const rawTagged = entries(rawMutation[verb])[index]!;
        const edge = membership(tagged.type as string);
        const untag = (value: Input) =>
          verb === "create"
            ? value.data
            : verb === "connect" || verb === "delete" || verb === "disconnect"
              ? value.where
              : value;
        this.relation(edge, verb, untag(tagged), untag(rawTagged), {
          ...origin,
          relation: edge.name,
        });
      }
    }
  }
  private relation(
    edge: Membership,
    verb: RelationVerb,
    payload: unknown,
    rawPayload: unknown,
    origin: Origin
  ): void {
    const parent = this.parent;
    const hasSupply = this.hasSupply;
    // Each payload entry is its own mutation (N1): its own origin, in
    // declaration order behind the verb's.
    const entryOrigin = () =>
      this.commands.createOrigin(
        origin.relation,
        origin.operation,
        origin.slot
      );
    if (
      parent.fields.operation === "update" &&
      edge.kind === "reference" &&
      edge.owner === "target" &&
      edge.pairs.some((pair) => parent.fields.writesField(pair.source)) &&
      !parent.transitions.includes(edge)
    )
      parent.transitions.push(edge);
    switch (verb) {
      case "disconnect":
      case "delete": {
        if (payload === false) break;
        // DESIGN §5.3's truth table, decided where the payload's form is
        // known: `disconnect: true` and `delete: true` are LAX — an empty slot
        // is a no-op, so the lookup is not required and a consumer that binds
        // no row emits nothing — while an explicit selector is STRICT and a
        // missing target is the correlated refusal.
        const lax = payload === true;
        for (const selector of lax ? [undefined] : entries(payload)) {
          const origin = entryOrigin();
          const outgoing = this.commands.lookup(
            edge.target,
            {
              kind: "query",
              where: selector,
              unique: nestedTargetAddressesConstraint(edge, verb),
              membership: { edge, parent: parent.located!.fields },
            },
            lax
              ? undefined
              : () =>
                  new NestedWriteError(
                    `Cannot ${verb} relation '${edge.name}': target record was not found for this parent.`,
                    edge.name
                  )
          );
          outgoing.origin = origin;
          this.membershipSource(edge, parent.located!.fields);
          // Initial absence and loss after observation are distinct facts
          // (ELEGANCE §6, D-32): `required` says what an empty slot means
          // (lax or strict), `retained` what the captured member's loss
          // between the plan-time read and the batch means, asserted where the
          // observation is taken, before any write of the unit. Only the LAX
          // form names no row: its loss is the membership race, and the one
          // recovery re-plans the slot as the race left it. The strict form
          // names a row by its selector; a recovery would re-read that selector
          // and act on whatever row answers it now — the one thing a
          // captured-row loss must not authorise (D-34) — so it keeps the
          // identity sentence `requireLookup` supplies from `required`.
          if (lax)
            outgoing.retained = () =>
              membershipRaceFailure(verb, edge.name, "removed");
          const outgoingOccurrence = this.requireLookup(outgoing);
          if (edge.kind === "reference" && edge.owner === "source") {
            if (!hasSupply && edge.clearability.kind === "columns") {
              const contribution = {
                origin,
                scope: edge.scope,
                identity: parent.located?.facts,
              };
              for (const field of edge.clearability.fields)
                parent.fields.contribute(
                  field,
                  { kind: "literal", value: null },
                  `Cannot disconnect relation '${edge.name}'.`
                );
              this.commands.publishMembership(
                outgoingOccurrence,
                parent.fields,
                contribution
              );
            }
            if (verb === "delete")
              this.commands.place(
                parent,
                { kind: "delete", located: outgoing, origin },
                "after",
                origin
              );
          } else {
            // A lax removal names no target: it clears whatever member the
            // slot holds at execution (at most one on a to-one edge), which is
            // the set-based clear a `Removal` without a target already is.
            const removal: Removal = {
              kind: "remove",
              edge,
              source: parent.fields,
              target: lax ? undefined : outgoing.fields,
              keep: [],
              origin,
            };
            // A JUNCTION `delete` removes the LINK row before the target, in
            // this one region: the link references the target, so deleting the
            // target first is a foreign-key violation wherever the constraint
            // is enforced. The order is the shipped engine's own — "locate the
            // connected child, DELETE its join rows, then the child"
            // (`write-engine/RelationJunctionPart.ts:911-937` `compileDelete`:
            // `junctionDeleteTargets` then `childDelete`). A `disconnect`
            // places the removal alone, and a reference-held target carries its
            // own foreign key, so it places the deletion alone.
            if (verb === "delete" && edge.kind === "junction")
              this.commands.place(parent, removal, "after", origin);
            this.commands.place(
              parent,
              verb === "delete"
                ? { kind: "delete", located: outgoing, origin }
                : removal,
              "after",
              origin
            );
          }
        }
        break;
      }
      case "create":
        for (const [index, child] of entries(payload).entries()) {
          const origin = entryOrigin();
          const target = this.commands.create(
            edge.target,
            child,
            entries(rawPayload)[index]!,
            edge.kind === "reference" && edge.owner === "target"
              ? { edge, source: parent.fields }
              : undefined,
            parent.operation ?? parent.fields.operation,
            parent.fields.deferred
          );
          target.origin = origin;
          this.association(edge, target);
          this.supply(target);
        }
        break;
      case "createMany": {
        const body = record(payload);
        const rawBody = record(rawPayload);
        const rawRows = entries(rawBody.data);
        const records = entries(body.data).map((child, index) => {
          const target = this.commands.create(
            edge.target,
            child,
            rawRows[index]!,
            edge.kind === "reference" && edge.owner === "target"
              ? { edge, source: parent.fields }
              : undefined,
            parent.operation ?? parent.fields.operation,
            parent.fields.deferred
          );
          target.origin = origin;
          if (body.skipDuplicates)
            target.suppression = { kind: "skipDuplicate" };
          return this.association(edge, target, false, target);
        });
        this.commands.place(
          parent,
          { kind: "series", records },
          "after",
          origin
        );
        break;
      }
      case "connect":
      case "connectOrCreate":
      case "upsert":
      case "update": {
        // `docs/architecture/retired/write-engine-ATOM.md` §12 "Same-operation
        // duplicate": the rows this body's earlier `connectOrCreate` entries
        // PROVABLY create.
        const createdTargets: ReadonlyMap<string, unknown>[] = [];
        for (const [index, supplied] of entries(payload).entries()) {
          const origin = entryOrigin();
          const source = entries(rawPayload)[index]!;
          const conditional: Input =
            verb === "connect" ? { where: supplied } : supplied;
          // The child's OWN key update is judged by the same owner that judges
          // the root's, at the position this body already admits it, and R-D2
          // (c) is about the SHAPE, not the site. `connect` and
          // `connectOrCreate` carry no update payload, so they ask nothing.
          //
          // WHEN the answer is stated is the shipped engine's placement, not
          // this body's. A nested `update` is asserted at COMPILE time
          // (`RelationWritePart.ts:856`), so its refusal is raised here, before
          // anything is located. A nested `upsert` is not: the shipped engine
          // builds the same assertion as a closure (`RelationUpsertPart.ts:1006`)
          // and invokes it only inside the FOUND arm (`:468`), so an absent
          // target takes the create arm and the update payload is never judged
          // — the shape `EngineSchema.keyPortabilityRefusal`'s own docblock
          // warns a wider placement breaks, "an upsert that CREATES a row the
          // arithmetic never touches". The upsert's refusal is therefore handed
          // to its found arm below, the way the ROOT upsert hands it to its own
          // (`commands.ts:1236-1239`). The carrier differs because the position
          // does: the root assigns `CommandOccurrence.refusal` on an already
          // MATERIALIZED arm, while this body writes a recipe, and a recipe
          // never carries occurrence refusal into materialization (guide,
          // "Reusing a command or `Selection` never reuses occurrence ancestry,
          // children, refusal, or attempt state"). The found arm's own deferred
          // `Assignments` is the recipe-borne half of the same channel: it holds
          // the refusal until `activate()` observes the choice
          // (`execution.ts:259`, `:389`), which is the arm-conditional rule the
          // guide already states for every `Choose` arm.
          const childUpdate =
            verb === "upsert" ? conditional.update : conditional.data;
          const keyRefusal = this.commands.context.schema.keyPortabilityRefusal(
            edge.target,
            childUpdate
          );
          if (keyRefusal && verb !== "upsert") throw keyRefusal;
          const missing =
            conditional.create === undefined
              ? undefined
              : this.commands.create(
                  edge.target,
                  record(conditional.create),
                  record(source.create),
                  edge.kind === "reference" && edge.owner === "target"
                    ? { edge, source: parent.fields }
                    : undefined,
                  parent.operation ?? parent.fields.operation,
                  parent.fields.deferred
                );
          if (missing) missing.origin = origin;
          const correlated =
            (verb === "update" || verb === "upsert") &&
            parent.fields.operation === "update";
          const continuation =
            verb === "update" && !edge.many ? this.supplier : undefined;
          const suppliedSelector =
            continuation?.kind === "query" ? continuation : undefined;
          const queries = this.commands.context.queries;
          const ownSelector = queries.prepareSelector(
            edge.target,
            conditional.where as Input | undefined,
            nestedTargetAddressesConstraint(edge, verb)
          );
          // `docs/architecture/retired/write-engine-ATOM.md` §12:
          // first-create-wins locally. An entry whose target an earlier entry
          // of the SAME operation provably creates ADOPTS that
          // row — the association is the earlier entry's — so it opens no
          // second decision read, no found guard and no missing race pin: its
          // producer is inside this operation. The two facts are the ones
          // `CommandExecution.matchesSelectedConstraint` already reads together.
          const addressed = ownSelector.uniqueValues;
          if (verb === "connectOrCreate" && addressed) {
            if (
              createdTargets.some((earlier) => sameTarget(earlier, addressed))
            )
              continue;
            if (
              missing &&
              [...addressed].every(([field, value]) => {
                const proposed = missing.fields.known(field);
                return (
                  proposed?.kind === "literal" &&
                  Object.is(proposed.value, value)
                );
              })
            )
              createdTargets.push(addressed);
          }
          let selectionSource: SelectionSource = {
            kind: "query",
            where: conditional.where as Input | undefined,
            selector: ownSelector,
          };
          let facts: SelectorFacts | undefined;
          if (suppliedSelector) {
            const supplierSelector = suppliedSelector.selector;
            const ownFacts = queries.selectorFacts(ownSelector);
            const supplierFacts = queries.selectorFacts(supplierSelector);
            facts = ownFacts.fields.size === 0 ? supplierFacts : ownFacts;
            selectionSource = {
              kind: "query",
              selector: queries.andSelectors(edge.target, [
                supplierSelector,
                ownSelector,
              ]),
            };
          }
          if (continuation?.kind === "producer") {
            selectionSource = {
              kind: "producer",
              where: selectionSource.where,
              selector: selectionSource.selector,
              producer: continuation.producer,
            };
            continuation.producer.select(
              storedFields(this.commands.context.schema, edge.target)
            );
          }
          let foundMembership: BoundMembership | undefined;
          // The parent's FINAL membership value, pair by pair: what its own
          // payload NAMES for that column, and otherwise the row it located.
          // "The parent's FK value is its FINAL value" is the delegated fold's
          // pinned semantics (M1,
          // `tests/contracts/engine/write/parent-held-delegated-fk-rebind-correlation.test.ts`):
          // a rebind in the parent's own SET moves the member, so a correlated
          // arm locates — and writes — the row the parent ENDS on, never the
          // one it is moving away from. The same value is what that row HOLDS
          // for the edge's referenced field, which is why a correlated arm's
          // own membership contribution RESTATES the parent's assignment
          // instead of adding a second final one.
          let correlation: Record<string, FieldValue> | undefined;
          if (correlated && !continuation) {
            const values =
              edge.kind === "reference"
                ? edge.pairs.map((pair) => ({
                    ...pair,
                    value:
                      parent.fields.known(pair.source) ??
                      parent.located!.fields.field(pair.source),
                  }))
                : [];
            correlation = Object.fromEntries(
              values.map(({ target, value }) => [target, value])
            );
            const membership = {
              edge,
              parent: this.correlationParent(
                edge,
                verb,
                Object.fromEntries(
                  values.map(({ source, value }) => [source, value])
                )
              ),
            };
            this.membershipSource(edge, membership.parent);
            if (verb === "upsert" && conditional.where !== undefined)
              foundMembership = membership;
            else
              selectionSource = {
                kind: "query",
                where: selectionSource.where,
                selector: selectionSource.selector,
                membership,
              };
          }
          const lookup = this.commands.lookup(
            edge.target,
            selectionSource,
            verb === "connect" || verb === "update"
              ? () =>
                  new NestedWriteError(
                    `Cannot ${verb} relation '${edge.name}': target record was not found${verb === "update" ? " for this parent" : ""}.`,
                    edge.name
                  )
              : undefined,
            facts
          );
          lookup.origin = origin;
          // The missing arm inserts the key this probe just looked for, so the
          // probe does not lock the absence it may find
          // (`Selection.insertsWhenAbsent`).
          if (missing) lookup.insertsWhenAbsent = true;
          if (verb === "connectOrCreate")
            lookup.retained = () =>
              new NestedWriteError(
                "Record was replaced by another transaction during nested connectOrCreate",
                edge.name
              );
          lookup.membershipOnly =
            verb === "connect" &&
            !(edge.kind === "reference" && edge.owner === "source");
          // A connect whose located value the PARENT's own SET spends carries
          // that row's presence into the write: the premise is proved inside
          // the atomic unit that carries the write it protects (D-29), so a
          // target that vanishes between the plan-time read and the batch
          // aborts the unit with the arm's own identity sentence instead of
          // reaching the provider as a foreign-key violation on a column the
          // engine chose. Every other connect already states it — a
          // child-held one through the target's own record command, a
          // junction through its captured pair, `connectOrCreate` through the
          // replacement race above — and this selector NAMES a row, so its
          // loss is the non-raceable identity sentence (D-34), which is what
          // `required` already spells.
          if (verb === "connect" && !lookup.membershipOnly)
            lookup.retained = lookup.required;
          if (this.direct && verb === "connect") this.requireLookup(lookup);
          if (
            correlated &&
            !continuation &&
            verb === "update" &&
            edge.kind === "junction"
          )
            this.requireLookup(lookup);
          const foundRequirement: MembershipRequirement | undefined =
            foundMembership && {
              selection: lookup,
              membership: foundMembership,
              failure: () =>
                new NestedWriteError(
                  `Cannot upsert relation '${edge.name}': target record was not found for this parent.`,
                  edge.name
                ),
            };
          const chosen = new Assignments(
            edge.target,
            "select",
            {},
            {},
            undefined,
            missing ? [missing.fields] : []
          );
          for (const [field, value] of Object.entries(correlation ?? {}))
            chosen.restate(field, value);
          const target: Choose = {
            kind: "choose",
            model: edge.target,
            lookup,
            foundRequirement,
            missing: missing
              ? this.commands.occurrence(missing, "after")
              : undefined,
            fields: chosen,
            found:
              verb === "upsert" || verb === "update"
                ? this.commands.occurrence(
                    this.commands.update(
                      lookup,
                      record(childUpdate),
                      record(
                        verb === "upsert"
                          ? source.update
                          : (source.data ?? source)
                      ),
                      true
                    ),
                    "after"
                  )
                : undefined,
          };
          if (target.found) {
            target.found.command.origin = origin;
            target.found.command.requirement = foundRequirement;
            // The upsert's key refusal, on the arm that owns it: the update the
            // found arm would run is the payload being judged, its `Assignments`
            // is deferred, and an untaken arm never activates. `undefined` for a
            // nested `update`, which already refused above.
            if (keyRefusal) target.found.command.fields.reject(keyRefusal);
          }
          this.association(edge, target, correlated);
          this.supply(target);
        }
        break;
      }
      case "set": {
        this.replaceMembership(edge, entries(payload), origin);
        break;
      }
      case "updateMany":
      case "deleteMany": {
        const rawMembers = entries(rawPayload);
        parent.fields.select(this.commands.context.schema.keys(parent.model));
        this.membershipSource(edge, parent.fields);
        for (const [index, member] of entries(payload).entries()) {
          const origin = entryOrigin();
          const input = record(member);
          // The same owner, at the third nested position that admits an update
          // payload. A `deleteMany` member has no `data`, so it asks nothing.
          const keyRefusal = this.commands.context.schema.keyPortabilityRefusal(
            edge.target,
            input.data
          );
          if (keyRefusal) throw keyRefusal;
          const where =
            verb === "updateMany"
              ? input.where === undefined
                ? undefined
                : record(input.where)
              : record(input.where ?? input);
          // Rule 6's first sentence: keep scalar bulk work set-oriented. The
          // provider evaluates the membership and the member filter at this
          // statement's own position, so a row-held membership whose payload
          // names no relation needs no lookup, no series and no capture — the
          // shipped `buildUpdateMany`/`buildDeleteMany` shape
          // (`RelationWritePart.ts:484-504`, `:674-693`). A junction member set
          // must still be materialised through the join table, and a
          // relation-bearing `updateMany` still owns a record per member.
          const context = this.commands.context;
          if (
            edge.kind === "reference" &&
            (verb === "deleteMany" ||
              !context.schema.namesRelation(edge.target, record(input.data)))
          ) {
            const mutation: SetMutation = {
              kind: "set",
              edge,
              parent: parent.fields,
              model: edge.target,
              selector: context.queries.prepareSelector(edge.target, where),
              ...(verb === "updateMany"
                ? {
                    values: context.schema.scalars(
                      edge.target,
                      record(input.data)
                    ),
                  }
                : {}),
              operation: verb,
              origin,
            };
            this.commands.place(parent, mutation, "after", origin);
            continue;
          }
          const selection = this.commands.lookup(
            edge.target,
            {
              kind: "query",
              where,
              membership: { edge, parent: parent.fields },
            },
            () =>
              new NestedWriteError(
                `Cannot ${verb === "updateMany" ? "update" : "delete"} relation '${edge.name}': target record was not found for this parent.`,
                edge.name
              )
          );
          selection.origin = origin;
          const mutation: SelectedSeries["mutation"] =
            verb === "updateMany"
              ? {
                  kind: "update",
                  raw: record(rawMembers[index]!.data),
                }
              : { kind: "delete", origin };
          const analysis: RecordCommand | Deletion =
            mutation.kind === "update"
              ? this.commands.update(
                  selection,
                  record(input.data),
                  mutation.raw,
                  true
                )
              : { kind: "delete", located: selection, origin };
          if (analysis.kind === "record") analysis.origin = origin;
          const series: SelectedSeries = {
            selection,
            analysis,
            mutation,
          };
          const target = this.commands.place(
            parent,
            this.commands.selectedSeries(series),
            "after",
            origin
          );
          this.requireSeriesCapture(target);
        }
        break;
      }
      default:
        unreachable(verb, "relation verb");
    }
  }
  private requireLookup(
    lookup: Selection | JunctionCapture | AbsenceRequirement
  ): CommandOccurrence<Selection | JunctionCapture | AbsenceRequirement> {
    const parent = this.parent;
    if (lookup.kind === "lookup") lookup.retained ??= lookup.required;
    return this.commands.place(parent, lookup, "before");
  }
  private requireSeriesCapture(
    target: CommandOccurrence<SeriesOccurrence>
  ): void {
    const command: SeriesCapture = {
      kind: "captureSeries",
      target,
    };
    this.commands.place(this.parent, command, "capture");
  }
  private replaceMembership(
    edge: Membership,
    selectors: Input[],
    origin: Origin
  ): void {
    const targets = this.setTargets(edge, selectors, origin);
    this.clearMembership(edge, targets, origin);
    for (const target of targets) this.association(edge, target);
  }
  private setTargets(
    edge: Membership,
    selectors: Input[],
    origin: Origin
  ): Choose[] {
    return selectors.map((where): Choose => {
      const lookup = this.commands.lookup(
        edge.target,
        {
          kind: "query",
          where,
          unique: nestedTargetAddressesConstraint(edge, "set"),
        },
        () =>
          new NestedWriteError(
            `Cannot set relation '${edge.name}': target record was not found.`,
            edge.name
          )
      );
      // One origin for the whole set: its lookups, its clear and its
      // associations are one mutation, and a dependent lookup lands ahead of
      // the clear that keeps its row (N1).
      lookup.origin = origin;
      this.requireLookup(lookup);
      const target: Choose = {
        kind: "choose",
        model: edge.target,
        lookup,
        fields: new Assignments(edge.target, "select"),
      };
      target.lookup.fields.select(
        this.commands.context.schema.keys(edge.target)
      );
      return target;
    });
  }
  private clearMembership(
    edge: Membership,
    targets: Choose[],
    origin: Origin
  ): void {
    const parent = this.parent;
    if (edge.kind === "reference") {
      if (edge.clearability.kind === "none") {
        const required = [
          ...(edge.discriminator?.side === "target"
            ? [edge.discriminator.field]
            : []),
          ...edge.pairs.map((pair) => pair.target),
        ];
        this.membershipSource(edge, parent.located!.fields);
        const requirement: AbsenceRequirement = {
          kind: "absent",
          model: edge.target,
          membership: { edge, parent: parent.located!.fields },
          excluding: targets.map((target) => target.lookup.fields),
          failure: () =>
            new NestedWriteError(
              `Cannot set relation '${edge.name}' because foreign key field(s) ${required.join(", ")} are required: rows removed from the set cannot be disconnected. Delete them instead.`,
              edge.name
            ),
        };
        this.commands.place(
          parent,
          requirement,
          "before",
          targets.at(-1)?.lookup.origin ?? origin
        );
      } else
        this.commands.place(
          parent,
          {
            kind: "remove",
            edge,
            source: parent.fields,
            keep: targets.map((target) => target.lookup.fields),
            origin,
          },
          "after",
          origin
        );
    } else
      this.commands.place(
        parent,
        { kind: "remove", edge, source: parent.fields, keep: [], origin },
        "after",
        origin
      );
  }
  private association(
    edge: Membership,
    target: RecordCommand,
    premise?: boolean,
    seriesMember?: RecordCommand
  ): CommandOccurrence<RecordCommand>;
  private association(
    edge: Membership,
    target: Choose,
    premise?: boolean,
    seriesMember?: RecordCommand
  ): CommandOccurrence<Choose>;
  private association(
    edge: Membership,
    target: RecordCommand | Choose,
    premise = false,
    seriesMember?: RecordCommand
  ): CommandOccurrence<RecordCommand | Choose> {
    const source = this.parent;
    const conditionalParentBinding =
      edge.kind === "reference" &&
      edge.owner !== "source" &&
      target.kind === "choose" &&
      !premise
        ? { edge, target }
        : undefined;
    if (conditionalParentBinding && !conditionalParentBinding.target.found) {
      const { lookup } = conditionalParentBinding.target;
      conditionalParentBinding.target.found = this.commands.occurrence(
        this.commands.update(lookup, {}, {}, true),
        "after"
      );
    }
    // ONE rule, for every found arm whose probe did not keep its lock. Such an
    // arm's UPDATE can address a row that is no longer there
    // (`Selection.insertsWhenAbsent`), and an UPDATE that asks the provider for
    // nothing back never learns whether it addressed one — so on a provider
    // without RETURNING the loss is invisible. Two arms reach it and both are
    // built here: the binding an inverse-reference `connect`/`connectOrCreate`
    // constructs above, which exists only to write the child's foreign key and
    // therefore demands nothing at all, and a nested to-ONE `upsert`, whose
    // found arm does carry the caller's payload but carries no `where`, so no
    // found membership confirmation is built for it (`Choose.foundRequirement`)
    // and the locking `Selection.confirm` read that states the CORRELATED arm's
    // target proves nothing about this one. Demanding the target's own keys is
    // what makes `OperationContext.update` issue the read that answers "which
    // row did this UPDATE write?" — the CURRENT stored-row read where the
    // provider has no RETURNING — and raise `UPDATE did not produce the
    // required record` when there is none. It is the reader of LAST resort: the
    // shared confirmation (`CommandExecution.confirmFound`) holds the row under
    // lock through the effect wherever the provider has one to take, and this
    // is what answers on a provider whose select assembly omits `FOR UPDATE`
    // (SQLite). The arms whose probe still locks are untouched.
    if (
      target.kind === "choose" &&
      target.found &&
      target.lookup.insertsWhenAbsent &&
      target.foundRequirement === undefined
    )
      target.found.command.fields.select(
        this.commands.context.schema.keys(target.model)
      );
    if (target.kind === "choose" && target.found)
      target.fields.forward(target.found.command.fields);
    const origin =
      target.kind === "choose" ? target.lookup.origin : target.origin;
    const conditionalFound = conditionalParentBinding?.target.found;
    if (conditionalParentBinding && conditionalFound) {
      const { edge: reference, target: conditionalTarget } =
        conditionalParentBinding;
      conditionalFound.command.origin ??= conditionalTarget.lookup.origin;
      for (const pair of reference.pairs)
        conditionalFound.command.fields.absorb(
          pair.target,
          source.fields,
          pair.source,
          `Relation '${reference.name}' owns '${reference.pairs.map((member) => member.target).join(", ")}'; omit it from nested create and update data.`
        );
    }
    const placement =
      edge.kind === "reference" && edge.owner === "source" ? "before" : "after";
    const occurrence = seriesMember
      ? this.commands.occurrence(target, "root")
      : this.commands.place(source, target, placement, origin);
    if (edge.kind === "reference" && edge.owner === "source") {
      const contribution = origin
        ? {
            origin,
            scope: edge.scope,
            identity: source.located?.facts,
          }
        : undefined;
      this.commands.assignMembership(edge, source.fields, target.fields, {
        carried:
          premise && target.kind === "choose"
            ? target.found?.command.fields
            : undefined,
        requested:
          !premise || (target.kind === "choose" && target.missing !== undefined),
      });
      if (contribution)
        this.commands.publishMembership(
          occurrence,
          source.fields,
          contribution
        );
      return occurrence;
    }
    if (conditionalParentBinding && conditionalFound) {
      const { edge: reference, target: conditionalTarget } =
        conditionalParentBinding;
      const contribution = origin
        ? {
            origin,
            scope: reference.scope,
            identity: conditionalFound.command.located?.facts,
          }
        : undefined;
      this.commands.assignMembership(
        reference,
        conditionalFound.command.fields,
        source.fields
      );
      if (contribution)
        this.commands.publishMembership(
          occurrence,
          conditionalFound.command.fields,
          contribution
        );
      for (const pair of reference.pairs) source.fields.field(pair.source);
    }
    if (edge.kind === "junction" && !premise) {
      let captured: JunctionCapture | undefined;
      const address =
        edge.uniqueSide === "source"
          ? source.located
          : edge.uniqueSide === "target" && target.kind === "choose"
            ? target.lookup
            : undefined;
      if (address) {
        const side =
          edge.uniqueSide === "source" ? edge.sourceSide : edge.targetSide;
        captured = {
          kind: "junction",
          edge,
          address,
          final: edge.uniqueSide === "source" ? source.fields : target.fields,
          values: Object.fromEntries(
            side.members.map((pair) => [
              pair.junctionField,
              address.fields.field(pair.referencedField),
            ])
          ),
        };
        if (address !== source.located) this.requireLookup(address);
        this.requireLookup(captured);
      } else if (
        seriesMember &&
        edge.uniqueSide === "target" &&
        target.kind === "record" &&
        edge.targetSide.members.every(
          (pair) =>
            target.fields.known(pair.referencedField)?.kind === "literal"
        )
      ) {
        // A singular slot is a TRANSFER, and this member spells the target key
        // itself, so the current owner is addressed directly — the shipped
        // transfer's `values` address
        // (`write-engine/junction-singular-transfer.ts`). It is captured at
        // THIS member's own position, so a later member naming the same target
        // observes the membership this one already moved.
        captured = {
          kind: "junction",
          edge,
          final: target.fields,
          values: Object.fromEntries(
            edge.targetSide.members.map((pair) => [
              pair.junctionField,
              target.fields.field(pair.referencedField),
            ])
          ),
        };
        this.commands.place(seriesMember, captured, "before");
      }
      const removals = source.body
        .map((candidate) => candidate.command)
        .filter(
          (command): command is Removal & { edge: Junction } =>
            command.kind === "remove" &&
            command.edge.kind === "junction" &&
            command.edge.table === edge.table
        );
      for (const removal of removals) {
        this.linkFields(removal.edge, removal.source, removal.target);
        for (const retained of removal.keep)
          this.linkFields(removal.edge, undefined, retained);
      }
      this.commands.place(
        seriesMember ?? source,
        {
          kind: "link",
          edge,
          values: this.linkFields(edge, source.fields, target.fields),
          captured,
          removals,
          origin,
        },
        "after",
        origin
      );
    } else if (
      edge.kind === "junction" &&
      target.kind === "choose" &&
      target.missing
    )
      this.commands.place(
        target.missing.command,
        {
          kind: "link",
          edge,
          values: this.linkFields(
            edge,
            source.fields,
            target.missing.command.fields
          ),
          origin,
        },
        "after",
        origin
      );
    return occurrence;
  }
  /**
   * The parent value a CORRELATED arm locates its target by, at the position
   * the arm's own lookup stands (N1: an observation is valid where it is
   * taken).
   *
   * A CHILD-HELD arm is placed AFTER the parent's write ({@link association}),
   * so the key valid there is the one that write left the row holding — under
   * a key transition the provider has already moved the child's foreign key
   * onto it (`ON UPDATE CASCADE`), and the pre-transition key names no member
   * at all. The parent's own `Assignments` are that answer at every point,
   * which is why a nested `update` placed BEFORE the write reads them too:
   * there they state what the payload names for the column, else the row the
   * parent located. An `upsert` on a PARENT-HELD edge cannot read them — its
   * create arm contributes the CHOSEN row's key into those same assignments
   * (`association` → `Commands.assignMembership`), so correlating on them
   * would make the arm's lookup wait on the value that lookup is what
   * produces, a read that depends on its own write, which no order satisfies
   * (N1). It reads the same two answers as its own view, taken before that
   * contribution exists, and forwards its demands so the located row still
   * projects what the view will read. A JUNCTION's membership is the captured
   * PAIR, which no SET of the parent's own columns moves.
   */
  private correlationParent(
    edge: Membership,
    verb: RelationVerb,
    final: Record<string, FieldValue>
  ): Assignments {
    const parent = this.parent;
    const located = parent.located!.fields;
    if (edge.kind === "junction") return located;
    if (edge.owner !== "source" || verb === "update") return parent.fields;
    const view = new Assignments(parent.model, "select", {}, {}, located, [
      located,
    ]);
    for (const [field, value] of Object.entries(final))
      view.restate(field, value);
    return view;
  }
  private membershipSource(
    edge: Membership,
    source: Assignments
  ): Record<string, FieldValue> {
    return source.select(membershipFields(edge));
  }
  private linkFields(
    edge: Junction,
    source?: Assignments,
    target?: Assignments
  ): Record<string, FieldValue> {
    return Object.fromEntries([
      ...(source
        ? edge.sourceSide.members.map((pair) => [
            pair.junctionField,
            source.field(pair.referencedField),
          ])
        : []),
      ...(target
        ? edge.targetSide.members.map((pair) => [
            pair.junctionField,
            target.field(pair.referencedField),
          ])
        : []),
    ]);
  }
}
