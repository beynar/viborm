import { NestedWriteError } from "@errors";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
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
} from "./commands";
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

const mutationOrder: readonly string[] = [
  "disconnect",
  "delete",
  "create",
  "connect",
  "connectOrCreate",
  "upsert",
  "update",
  "set",
  "updateMany",
];
const collectionMutationOrder: readonly string[] = [
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
];

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
    const order =
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
    for (const [verb, payload] of Object.entries(mutation).sort(
      ([a], [b]) => order.indexOf(a) - order.indexOf(b)
    )) {
      if (payload === undefined) continue;
      const origin = this.commands.createOrigin(name, verb);
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
              `Cannot disconnect relation '${name}'.`,
              contribution
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
            target: this.setTargets(edge, [record(tagged.where)])[0]!,
          };
        });
        for (const member of carrier.members)
          this.clearMembership(membership(member.variant), [], origin);
        for (const { edge, target } of targets) this.association(edge, target);
        continue;
      }
      for (const [index, tagged] of entries(payload).entries()) {
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
    verb: string,
    payload: unknown,
    rawPayload: unknown,
    origin: Origin
  ): void {
    const parent = this.parent;
    const hasSupply = this.hasSupply;
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
        for (const selector of payload === true
          ? [undefined]
          : entries(payload)) {
          const outgoing = this.commands.lookup(
            edge.target,
            {
              kind: "query",
              where: selector,
              unique: nestedTargetAddressesConstraint(edge, verb),
              membership: { edge, parent: parent.located!.fields },
            },
            () =>
              new NestedWriteError(
                `Cannot ${verb} relation '${edge.name}': target record was not found for this parent.`,
                edge.name
              )
          );
          outgoing.origin = origin;
          this.membershipSource(edge, parent.located!.fields);
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
                  `Cannot disconnect relation '${edge.name}'.`,
                  contribution
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
            const removal: Removal = {
              kind: "remove",
              edge,
              source: parent.fields,
              target: outgoing.fields,
              keep: [],
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
      case "update":
        for (const [index, supplied] of entries(payload).entries()) {
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
          if (correlated && !continuation) {
            const membership = {
              edge,
              parent:
                verb === "update" && edge.kind !== "junction"
                  ? parent.fields
                  : parent.located!.fields,
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
          if (verb === "connectOrCreate")
            lookup.retained = () =>
              new NestedWriteError(
                "Record was replaced by another transaction during nested connectOrCreate",
                edge.name
              );
          lookup.membershipOnly =
            verb === "connect" &&
            !(edge.kind === "reference" && edge.owner === "source");
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
          const target: Choose = {
            kind: "choose",
            model: edge.target,
            lookup,
            foundRequirement,
            missing: missing
              ? this.commands.occurrence(missing, "after")
              : undefined,
            fields: new Assignments(
              edge.target,
              "select",
              {},
              {},
              undefined,
              missing ? [missing.fields] : []
            ),
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
              : { kind: "delete" };
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
        throw new Error(
          `Raptor 3 G1 relation operation is not implemented: ${verb}`
        );
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
    const targets = this.setTargets(edge, selectors);
    this.clearMembership(edge, targets, origin);
    for (const target of targets) this.association(edge, target);
  }
  private setTargets(edge: Membership, selectors: Input[]): Choose[] {
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
      lookup.origin = this.commands.createOrigin(edge.name, "set");
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
          },
          "after",
          origin
        );
    } else
      this.commands.place(
        parent,
        { kind: "remove", edge, source: parent.fields, keep: [] },
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
    if (conditionalParentBinding && !conditionalParentBinding.target.found)
      conditionalParentBinding.target.found = this.commands.occurrence(
        this.commands.update(
          conditionalParentBinding.target.lookup,
          {},
          {},
          true
        ),
        "after"
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
      if (!premise || (target.kind === "choose" && target.missing))
        this.commands.assignMembership(
          edge,
          source.fields,
          target.fields,
          contribution
        );
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
        source.fields,
        contribution
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
        },
        "after",
        origin
      );
    return occurrence;
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
