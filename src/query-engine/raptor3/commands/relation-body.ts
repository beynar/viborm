import { NestedWriteError } from "@errors";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import type { PreparedSelector, SelectorFacts } from "../shared/query";
import { entries, record, type Input } from "../shared/schema";
import {
  bindMembership,
  storedFields,
  type Membership,
} from "../shared/storage";
import { Assignments, type FieldValue, type Origin } from "./assignments";
import type {
  AbsenceRequirement,
  Choose,
  Commands,
  Deletion,
  JunctionCapture,
  MembershipRequirement,
  RecordCommand,
  Removal,
  SelectedSeries,
} from "./commands";
import {
  membershipFields,
  type Selection,
  type SelectionSource,
  type BoundMembership,
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
    private readonly raw: Input,
  ) {
    this.direct =
      !slot.member &&
      (slot.edge.kind === "variantRowCarrier" ||
        slot.edge.kind === "variantJunctionCarrier");
    this.hasSupply = ["create", "connect", "connectOrCreate", "upsert"].some(
      (verb) => admitted[verb] !== undefined,
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
      ([a], [b]) => order.indexOf(a) - order.indexOf(b),
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
        if (
          payload &&
          !this.hasSupply &&
          clearability.kind === "columns"
        )
          for (const field of clearability.fields)
            parent.fields.contribute(
              field,
              { kind: "literal", value: null },
              `Cannot disconnect relation '${name}'.`,
              { owner: parent, origin, scope: resolved },
            );
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
          this.clearMembership(membership(member.variant), []);
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
    origin: Origin,
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
              membership: { edge, parent: parent.located!.fields },
            },
            new NestedWriteError(
              `Cannot ${verb} relation '${edge.name}': target record was not found for this parent.`,
              edge.name,
            ),
          );
          outgoing.origin = origin;
          this.membershipSource(edge, parent.located!.fields);
          this.requireLookup(outgoing);
          if (edge.kind === "reference" && edge.owner === "source") {
            if (!hasSupply) {
              if (edge.clearability.kind === "columns")
                for (const field of edge.clearability.fields)
                  parent.fields.contribute(
                    field,
                    { kind: "literal", value: null },
                    `Cannot disconnect relation '${edge.name}'.`,
                    { owner: outgoing, origin, scope: edge.scope },
                  );
            }
            if (verb === "delete")
              parent.after.push({ kind: "delete", located: outgoing, origin });
          } else {
            parent.after.push(
              verb === "delete"
                ? { kind: "delete", located: outgoing, origin }
                : {
                    kind: "remove",
                    edge,
                    source: parent.fields,
                    target: outgoing.fields,
                    keep: [],
                  },
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
            parent.fields.deferred,
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
            parent.fields.deferred,
          );
          target.origin = origin;
          if (body.skipDuplicates)
            target.suppression = { kind: "skipDuplicate" };
          this.association(edge, target, false, target);
          return target;
        });
        parent.after.push({ kind: "series", records });
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
                  parent.fields.deferred,
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
            facts =
              ownFacts.fields.size === 0 ? supplierFacts : ownFacts;
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
              storedFields(this.commands.context.schema, edge.target),
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
              ? new NestedWriteError(
                  `Cannot ${verb} relation '${edge.name}': target record was not found${verb === "update" ? " for this parent" : ""}.`,
                  edge.name,
                )
              : undefined,
            facts,
          );
          lookup.origin = origin;
          if (verb === "connectOrCreate")
            lookup.retained = new NestedWriteError(
              "Record was replaced by another transaction during nested connectOrCreate",
              edge.name,
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
              failure: new NestedWriteError(
                `Cannot upsert relation '${edge.name}': target record was not found for this parent.`,
                edge.name,
              ),
            };
          const target: Choose = {
            kind: "choose",
            model: edge.target,
            lookup,
            foundRequirement,
            missing,
            fields: new Assignments(
              edge.target,
              "select",
              {},
              {},
              undefined,
              missing ? [missing.fields] : [],
            ),
            foundRecord:
              verb === "upsert" || verb === "update"
                ? this.commands.update(
                    lookup,
                    record(
                      verb === "upsert" ? conditional.update : conditional.data,
                    ),
                    record(
                      verb === "upsert"
                        ? source.update
                        : (source.data ?? source),
                    ),
                    true,
                  )
                : undefined,
          };
          if (target.foundRecord) {
            target.foundRecord.origin = origin;
            target.foundRecord.requirement = foundRequirement;
          }
          this.association(edge, target, correlated);
          this.supply(target);
        }
        break;
      case "set": {
        this.replaceMembership(edge, entries(payload));
        break;
      }
      case "updateMany":
      case "deleteMany": {
        const rawMembers = entries(rawPayload);
        parent.fields.select(this.commands.context.schema.keys(parent.model));
        this.membershipSource(edge, parent.fields);
        for (const [index, member] of entries(payload).entries()) {
          const input = record(member);
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
            new NestedWriteError(
              `Cannot ${verb === "updateMany" ? "update" : "delete"} relation '${edge.name}': target record was not found for this parent.`,
              edge.name,
            ),
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
                  true,
                )
              : { kind: "delete", located: selection, origin };
          if (analysis.kind === "record") analysis.origin = origin;
          const series: SelectedSeries = {
            selection,
            analysis,
            mutation,
          };
          this.requireSeriesCapture(series);
          parent.after.push({
            kind: "series",
            series,
          });
        }
        break;
      }
      default:
        throw new Error(
          `Raptor 3 G1 relation operation is not implemented: ${verb}`,
        );
    }
  }
  private requireLookup(
    lookup: Selection | JunctionCapture | AbsenceRequirement,
  ): void {
    const parent = this.parent;
    if (lookup.kind === "lookup") lookup.retained ??= lookup.required;
    const firstEffect = parent.before.findIndex(
      (command) =>
        command.kind !== "lookup" &&
        command.kind !== "junction" &&
        command.kind !== "absent",
    );
    parent.before.splice(
      firstEffect < 0 ? parent.before.length : firstEffect,
      0,
      lookup,
    );
  }
  private requireSeriesCapture(series: SelectedSeries): void {
    const command: { kind: "captureSeries"; series: SelectedSeries } = {
      kind: "captureSeries",
      series,
    };
    const firstEffect = this.parent.after.findIndex(
      (candidate) => candidate.kind !== "captureSeries",
    );
    this.parent.after.splice(
      firstEffect < 0 ? this.parent.after.length : firstEffect,
      0,
      command,
    );
  }
  private replaceMembership(edge: Membership, selectors: Input[]): void {
    const targets = this.setTargets(edge, selectors);
    this.clearMembership(edge, targets);
    for (const target of targets) this.association(edge, target);
  }
  private setTargets(edge: Membership, selectors: Input[]): Choose[] {
    return selectors.map((where): Choose => {
      const lookup = this.commands.lookup(
        edge.target,
        { kind: "query", where },
        new NestedWriteError(
          `Cannot set relation '${edge.name}': target record was not found.`,
          edge.name,
        ),
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
        this.commands.context.schema.keys(edge.target),
      );
      return target;
    });
  }
  private clearMembership(edge: Membership, targets: Choose[]): void {
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
        this.requireLookup({
          kind: "absent",
          model: edge.target,
          membership: { edge, parent: parent.located!.fields },
          excluding: targets.map((target) => target.lookup.fields),
          failure: new NestedWriteError(
            `Cannot set relation '${edge.name}' because foreign key field(s) ${required.join(", ")} are required: rows removed from the set cannot be disconnected. Delete them instead.`,
            edge.name,
          ),
        });
      } else
        parent.after.push({
          kind: "remove",
          edge,
          source: parent.fields,
          keep: targets.map((target) => target.lookup.fields),
        });
    } else
      parent.after.push({
        kind: "remove",
        edge,
        source: parent.fields,
        keep: [],
      });
  }
  private association(
    edge: Membership,
    target: RecordCommand | Choose,
    premise = false,
    seriesMember?: RecordCommand,
  ): void {
    const source = this.parent;
    if (target.kind === "choose" && target.foundRecord)
      target.fields.forward(target.foundRecord.fields);
    const origin =
      target.kind === "choose" ? target.lookup.origin : target.origin;
    const contribution = origin
      ? { owner: target, origin, scope: edge.scope }
      : undefined;
    if (edge.kind === "reference" && edge.owner === "source") {
      if (!premise || (target.kind === "choose" && target.missing))
        this.commands.assignMembership(
          edge,
          source.fields,
          target.fields,
          contribution,
        );
      source.before.push(target);
      return;
    }
    if (edge.kind === "reference" && target.kind === "choose" && !premise) {
      if (!target.foundRecord) {
        target.foundRecord = this.commands.update(target.lookup, {}, {}, true);
        target.fields.forward(target.foundRecord.fields);
      }
      target.foundRecord.origin ??= target.lookup.origin;
      for (const pair of edge.pairs)
        target.foundRecord.fields.absorb(
          pair.target,
          source.fields,
          pair.source,
          `Relation '${edge.name}' owns '${edge.pairs.map((member) => member.target).join(", ")}'; omit it from nested create and update data.`,
        );
      this.commands.assignMembership(
        edge,
        target.foundRecord.fields,
        source.fields,
        contribution,
      );
      for (const pair of edge.pairs) source.fields.field(pair.source);
    }
    if (!seriesMember) source.after.push(target);
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
            ]),
          ),
        };
        if (address !== source.located) this.requireLookup(address);
        this.requireLookup(captured);
      }
      const removals = source.after.filter(
        (command): command is Removal & { edge: Junction } =>
          command.kind === "remove" &&
          command.edge.kind === "junction" &&
          command.edge.table === edge.table,
      );
      for (const removal of removals) {
        this.linkFields(removal.edge, removal.source, removal.target);
        for (const retained of removal.keep)
          this.linkFields(removal.edge, undefined, retained);
      }
      (seriesMember?.after ?? source.after).push({
        kind: "link",
        edge,
        values: this.linkFields(edge, source.fields, target.fields),
        captured,
        removals,
      });
    } else if (
      edge.kind === "junction" &&
      target.kind === "choose" &&
      target.missing
    )
      target.missing.after.push({
        kind: "link",
        edge,
        values: this.linkFields(edge, source.fields, target.missing.fields),
      });
  }
  private membershipSource(
    edge: Membership,
    source: Assignments,
  ): Record<string, FieldValue> {
    return source.select(membershipFields(edge));
  }
  private linkFields(
    edge: Junction,
    source?: Assignments,
    target?: Assignments,
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
