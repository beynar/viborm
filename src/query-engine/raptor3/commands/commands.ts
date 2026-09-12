import {
  NestedWriteError,
  NotFoundError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import type { AnyModel } from "@schema/model";
import type { SelectorFacts } from "../shared/query";
import { OperationContext } from "../shared/operation-context";
import { type Arguments, entries, type Input, record } from "../shared/schema";
import { type Membership, physicalField } from "../shared/storage";
import {
  Assignments,
  type FieldValue,
  type MembershipContribution,
  type Origin,
} from "./assignments";
import { CommandExecution } from "./execution";
import {
  Selection,
  type BoundMembership,
  type SelectionSource,
} from "./selection";
import { RelationBody } from "./relation-body";
export { Selection } from "./selection";

type Reference = Extract<Membership, { kind: "reference" }>;
type Junction = Extract<Membership, { kind: "junction" }>;

export interface RecordCommand {
  kind: "record";
  model: AnyModel;
  fields: Assignments;
  before: Command[];
  after: Command[];
  transitions: Reference[];
  located?: Selection;
  requirement?: MembershipRequirement;
  operation?: string;
  origin?: Origin;
  refusal?: Error;
  suppression?: { readonly kind: "skipDuplicate" };
}
export interface RecordSeriesCommand {
  readonly kind: "series";
  readonly records: RecordCommand[];
  readonly select?: Input;
}
export interface MembershipRequirement {
  readonly selection: Selection;
  readonly membership: BoundMembership;
  readonly failure: Error;
}
export interface JunctionCapture {
  readonly kind: "junction";
  readonly edge: Junction;
  readonly address: Selection;
  readonly values: Record<string, FieldValue>;
  readonly final: Assignments;
}
export interface AbsenceRequirement {
  readonly kind: "absent";
  readonly model: AnyModel;
  readonly membership: BoundMembership;
  readonly excluding: Assignments[];
  readonly failure: Error;
}
export interface Condition {
  readonly lookup: Selection;
  readonly match: Error;
  readonly skip: Error;
}
export interface Choose {
  kind: "choose";
  model: AnyModel;
  fields: Assignments;
  lookup: Selection;
  foundRequirement?: MembershipRequirement;
  operation?: string;
  missing?: RecordCommand;
  foundRecord?: RecordCommand;
  conditions?: { probes: Condition[]; missingRow: Error };
}
export interface Link {
  kind: "link";
  edge: Junction;
  values: Record<string, FieldValue>;
  captured?: JunctionCapture;
  removals?: (Removal & { edge: Junction })[];
}
export interface Removal {
  kind: "remove";
  edge: Membership;
  source?: Assignments;
  target?: Assignments;
  keep: Assignments[];
}
export interface Deletion {
  kind: "delete";
  located: Selection;
  origin: Origin;
}
export interface SelectedSeries {
  readonly selection: Selection;
  readonly analysis: RecordCommand | Deletion;
  readonly mutation:
    | { readonly kind: "update"; readonly raw: Input }
    | { readonly kind: "delete" };
}
export type SelectedSeriesMember = RecordCommand | Deletion;
type WriteOccurrence =
  RecordCommand | Deletion | Choose | Selection | Link | Removal;
export type Command =
  | RecordCommand
  | Selection
  | JunctionCapture
  | AbsenceRequirement
  | Choose
  | Link
  | Removal
  | Deletion
  | RecordSeriesCommand
  | { kind: "captureSeries"; series: SelectedSeries }
  | { kind: "series"; series: SelectedSeries };

/** Construction owns branch order; every storage consumer names exact produced fields. */
export class Commands {
  private nextMutation = 0;
  readonly execution: CommandExecution;
  constructor(readonly context: OperationContext) {
    this.execution = new CommandExecution(this);
  }

  create(
    model: AnyModel,
    admitted: Input,
    raw: Input = admitted,
    incoming?: { edge: Reference; source: Assignments },
    operation = "create",
    deferred = false,
  ): RecordCommand {
    const command: RecordCommand = {
      kind: "record",
      model,
      operation,
      before: [],
      after: [],
      transitions: [],
      fields: new Assignments(
        model,
        "create",
        this.context.schema.scalars(model, admitted),
        raw,
        undefined,
        [],
        deferred,
      ),
    };
    if (incoming)
      this.assignMembership(incoming.edge, command.fields, incoming.source);
    this.relations(command, admitted, raw);
    return command;
  }
  update(
    located: Selection,
    admitted: Input,
    raw: Input,
    deferred = false,
  ): RecordCommand {
    const model = located.model;
    const command: RecordCommand = {
      kind: "record",
      model,
      located,
      before: [],
      after: [],
      transitions: [],
      fields: new Assignments(
        model,
        "update",
        this.context.schema.scalars(model, admitted),
        raw,
        located.fields,
        undefined,
        deferred,
      ),
    };
    for (const field of this.context.schema.keys(model))
      located.fields.field(field);
    this.relations(command, admitted, raw);
    return command;
  }
  private relations(parent: RecordCommand, admitted: Input, raw: Input): void {
    for (const name of parent.model["~"].relationNames) {
      if (admitted[name] === undefined) continue;
      new RelationBody(
        this,
        parent,
        this.context.schema.index.get(parent.model)!.get(name)!,
        record(admitted[name]),
        record(raw[name]),
      ).expand();
    }
  }
  createOrigin(relation: string, operation: string, slot = relation): Origin {
    return { relation, operation, slot, order: this.nextMutation++ };
  }
  assignMembership(
    edge: Reference,
    destination: Assignments,
    producer: Assignments,
    contribution?: MembershipContribution,
  ): void {
    for (const pair of edge.pairs) {
      const field = edge.owner === "source" ? pair.source : pair.target;
      const referenced = edge.owner === "source" ? pair.target : pair.source;
      const known = producer.known(referenced);
      if (
        producer.operation === "create" &&
        (!known || (known.kind === "literal" && known.value === null))
      ) {
        const scalar = physicalField(
          this.context.schema,
          producer.model,
          referenced,
        ).scalar["~"].state;
        if (!scalar.autoGenerate)
          destination.reject(
            new UnsupportedOperationError(
              `query-engine-v2 create cannot resolve the parent id for relation '${edge.name}': referenced field '${referenced}' is neither this record's primary key nor a knowable value in its own create data.`,
            ),
          );
      }
      destination.contribute(
        field,
        producer.field(referenced),
        `query-engine-v2 ${destination.operation} has conflicting final assignments for column '${this.context.queries.columnName(destination.model, field)}' on relation '${edge.name}'.`,
        contribution,
      );
    }
    if (edge.discriminator)
      destination.contribute(
        edge.discriminator.field,
        { kind: "literal", value: edge.discriminator.value },
        `Conflicting stored discriminator for relation '${edge.name}'.`,
        contribution,
      );
  }
  analyze(root: RecordCommand): WriteOccurrence[] {
    const writes: WriteOccurrence[] = [];
    this.analyzeInto(root, writes);
    return writes;
  }
  private analyzeInto(
    root: RecordCommand,
    writes: WriteOccurrence[],
  ): void {
    if (root.suppression) this.context.requireSuppression();
    const readMembership = (
      lookup: Selection,
      owner: RecordCommand,
      membership = lookup.membership(),
    ) => {
      if (!lookup.origin || !membership || membership.edge.kind !== "reference")
        return;
      const edge = membership.edge;
      const carrier = edge.owner === "source" ? edge.source : edge.target;
      const observed =
        edge.owner === "source" ? owner.located?.facts : lookup.facts;
      for (const write of writes) {
        if (write.kind !== "record" || write.model !== carrier) continue;
        for (const assignment of write.fields.contributions().values()) {
          const contribution = assignment.membership;
          if (
            !contribution ||
            contribution.scope.edge !== edge.scope.edge ||
            (contribution.scope.member !== undefined &&
              contribution.scope.member !== edge.scope.member) ||
            !writes.some((occurrence) => occurrence === contribution.owner)
          )
            continue;
          const disjoint =
            observed &&
            [...observed.equals].some(
              ([key, value]) =>
                !write.fields.writesField(key) &&
                write.located?.facts.equals.has(key) &&
                !Object.is(write.located.facts.equals.get(key), value),
            );
          if (disjoint) continue;
          const relation = lookup.origin.slot ?? lookup.origin.relation;
          const operation = lookup.origin.operation;
          const earlier = contribution.origin.operation;
          owner.refusal ??= new NestedWriteError(
            `Nested operation '${operation}' on relation '${relation}' depends on an earlier '${earlier}' membership write in the same nested write. Split these operations into separate queries.`,
            relation,
            { meta: { operation, conflictsWith: earlier, relation } },
          );
          return;
        }
      }
    };
    const read = (lookup: Selection, owner: RecordCommand) => {
      if (
        !lookup.origin ||
        lookup.membershipOnly ||
        lookup.source.kind === "producer"
      )
        return;
      const scopes = [
        {
          model: lookup.model,
          path: [],
          fields: lookup.facts.fields,
          equals: lookup.facts.equals,
          exact: lookup.facts.exact,
        },
        ...lookup.facts.reads,
      ];
      for (const scope of scopes) {
        for (const write of writes) {
          if (write.kind === "choose" || write.kind === "lookup") continue;
          if (write.kind === "link" || write.kind === "remove") {
            const observed = scope.path.at(-1);
            if (!observed || observed.scope.edge !== write.edge.scope.edge)
              continue;
            const origin = lookup.origin;
            owner.refusal ??= new NestedWriteError(
              `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier membership write in the same nested write. Split these operations into separate queries.`,
              origin.relation,
              {
                meta: {
                  operation: origin.operation,
                  conflictsWith:
                    write.kind === "link" ? "connect" : "disconnect",
                  dependency: "membership",
                  overlap: "unknown",
                },
              },
            );
            return;
          }
          const model =
            write.kind === "delete" ? write.located.model : write.model;
          if (model !== scope.model) continue;
          if (
            write.kind === "record" &&
            write.fields.operation !== "create" &&
            !write.located?.membership()?.edge.many &&
            !write.fields
              .writtenFields()
              .some((field) => scope.fields.has(field))
          )
            continue;
          let matched = 0;
          let disjoint = false;
          for (const [field, expected] of scope.equals) {
            const value =
              write.kind === "record" && write.fields.operation === "create"
                ? write.fields.known(field)
                : undefined;
            const selected =
              write.located?.facts.exact &&
              !(write.kind === "record" && write.fields.writesField(field))
                ? write.located
                : undefined;
            const known =
              value?.kind === "literal"
                ? value.value
                : selected?.facts.equals.get(field);
            const hasKnown =
              value?.kind === "literal" || selected?.facts.equals.has(field);
            if (!hasKnown || !scope.exact) continue;
            if (!Object.is(known, expected)) {
              disjoint = true;
              break;
            }
            matched++;
          }
          if (disjoint) continue;
          const origin = lookup.origin;
          const operation =
            write.origin?.operation ??
            (write.kind === "delete" ? "delete" : write.fields.operation);
          owner.refusal ??= new NestedWriteError(
            `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier '${operation}' target write in the same nested write. Split these operations into separate queries.`,
            origin.relation,
            {
              meta: {
                operation: origin.operation,
                conflictsWith: operation,
                dependency: "targetExistence",
                overlap:
                  scope.exact && matched > 0 && matched === scope.fields.size
                    ? "equal"
                    : "unknown",
              },
            },
          );
          return;
        }
      }
    };
    if (
      root.fields.operation === "create" ||
      root.fields.writtenFields().length
    )
      writes.push(root);
    const origin = (command: Command) =>
      command.kind === "choose"
        ? command.lookup.origin
        : command.kind === "captureSeries" ||
            (command.kind === "series" && "series" in command)
          ? command.series.selection.origin
          : command.kind === "record" ||
              command.kind === "delete" ||
              command.kind === "lookup"
            ? command.origin
            : undefined;
    // Logical mutation order differs from physical placement (a replaced parent FK
    // must be written before deleting its captured outgoing target).
    const children = [...root.before, ...root.after].sort(
      (left, right) =>
        (origin(left)?.order ?? -1) - (origin(right)?.order ?? -1),
    );
    for (const command of children) {
      if (command.kind === "choose") {
        readMembership(
          command.lookup,
          root,
          command.foundRequirement?.membership,
        );
        read(command.lookup, root);
        if (command.foundRecord && command.missing) {
          const commonLength = writes.length;
          this.analyzeInto(command.foundRecord, writes);
          const found = writes.splice(commonLength);
          this.analyzeInto(command.missing, writes);
          const missing = writes.splice(commonLength);
          for (const occurrence of found) writes.push(occurrence);
          for (const occurrence of missing) writes.push(occurrence);
        } else if (command.foundRecord) {
          this.analyzeInto(command.foundRecord, writes);
          root.refusal ??= command.foundRecord.refusal;
        } else if (command.missing)
          this.analyzeInto(command.missing, writes);
        writes.push(command);
      } else if (command.kind === "record") {
        this.analyzeInto(command, writes);
        root.refusal ??= command.refusal;
      } else if (command.kind === "delete") {
        read(command.located, root);
        writes.push(command);
      } else if (command.kind === "lookup") {
        writes.push(command);
      } else if (command.kind === "link" || command.kind === "remove") {
        writes.push(command);
      } else if (command.kind === "series" && "records" in command) {
        for (const record of command.records) {
          this.analyzeInto(record, writes);
          root.refusal ??= record.refusal;
        }
      } else if (command.kind === "series") {
        read(command.series.selection, root);
        const analysis = command.series.analysis;
        if (analysis.kind === "record") {
          this.analyzeInto(analysis, writes);
          root.refusal ??= analysis.refusal;
        } else {
          writes.push(analysis);
        }
      }
    }
  }
  lookup(
    model: AnyModel,
    source: SelectionSource,
    required?: Error,
    facts?: SelectorFacts,
  ): Selection {
    return new Selection(this.execution, model, source, required, facts);
  }
  capture(selection: Selection, row: Input): Selection {
    return this.lookup(
      selection.model,
      {
        kind: "query",
        selector: this.context.queries.identitySelector(
          selection.model,
          this.context.schema.identity(selection.model, row),
        ),
      },
      selection.required,
    );
  }
  async execute(
    model: AnyModel,
    args: Arguments,
    raw: Arguments,
  ): Promise<unknown> {
    const ctx = this.context;
    if (ctx.operation === "createMany") {
      if (args.omit) {
        throw new UnsupportedOperationError(
          "Raptor 3 G3P-03 createMany omit returning is not implemented.",
        );
      }
      const rows = entries(args.data);
      const relationBearing = rows.some((row) =>
        model["~"].relationNames.some((name) => row[name] !== undefined),
      );
      if (!relationBearing && args.skipDuplicates) {
        throw new UnsupportedOperationError(
          "Raptor 3 G3P-04 scalar createMany skipDuplicates is not implemented.",
        );
      }
      if (relationBearing) {
        const rawRows = entries(raw.data);
        const records = rows.map((row, index) => {
          const record = this.create(model, row, rawRows[index]!);
          if (args.skipDuplicates)
            record.suppression = { kind: "skipDuplicate" };
          return record;
        });
        for (const record of records) {
          for (const field of ctx.schema.keys(model))
            record.fields.field(field);
          this.analyze(record);
        }
        const series: RecordSeriesCommand = {
          kind: "series",
          records,
          select: args.select,
        };
        return this.execution.records(series.records, series.select, series);
      }
      return ctx.createMany(
        model,
        rows.map((row) => ctx.schema.scalars(model, row)),
        args.select,
      );
    }
    if (ctx.operation === "deleteMany") {
      if (args.limit !== undefined || args.select || args.omit) {
        throw new UnsupportedOperationError(
          "Raptor 3 G3P-03 deleteMany limit and returning are not implemented.",
        );
      }
      return ctx.deleteMany(model, args.where);
    }
    if (ctx.operation === "upsert") {
      const missing = this.create(model, args.create!, raw.create!);
      missing.operation = "upsert";
      const lookup = this.lookup(model, { kind: "query", where: args.where });
      const queries = this.context.queries;
      const probes: Condition[] = [];
      for (const field of ["targetWhere", "setWhere"] as const) {
        const where = args[field];
        if (!where) continue;
        const conditionSelector = queries.prepareSelector(model, where);
        const failure = (match: boolean) =>
          new TransactionError(
            `query-engine-v2 top-level upsert ${field} ${match ? "match" : "skip"} premise changed before the atomic batch.`,
            { meta: { model: model["~"].names.ts!, operation: "upsert" } },
          );
        const skip = failure(false);
        skip.meta.raceable = true;
        probes.push({
          lookup: this.lookup(model, {
            kind: "query",
            selector: queries.andSelectors(model, [
              lookup.selector,
              conditionSelector,
            ]),
          }),
          match: failure(true),
          skip,
        });
      }
      const choice: Choose = {
        kind: "choose",
        model,
        lookup,
        operation: "upsert",
        missing,
        conditions: {
          probes,
          missingRow: new NotFoundError(model["~"].names.ts!, "upsert"),
        },
        fields: new Assignments(model, "select", {}, {}, undefined, [
          missing.fields,
        ]),
        foundRecord: this.update(lookup, args.update!, raw.update!, true),
      };
      choice.foundRecord!.operation = "upsert";
      choice.fields.forward(choice.foundRecord!.fields);
      this.analyze(missing);
      this.analyze(choice.foundRecord!);
      for (const field of ctx.schema.keys(model)) choice.fields.field(field);
      return this.execution.complete(choice, args);
    }
    if (ctx.operation === "create" || ctx.operation === "update") {
      const root =
        ctx.operation === "create"
          ? this.create(model, args.data, raw.data)
          : this.update(
              this.lookup(
                model,
                { kind: "query", where: args.where! },
                new NotFoundError(model["~"].names.ts!, "update"),
              ),
              args.data,
              raw.data,
            );
      for (const field of ctx.schema.keys(model)) root.fields.field(field);
      this.analyze(root);
      return this.execution.complete(root, args);
    }
    const updateData = args.data;
    if (args.limit !== undefined || args.select || args.omit) {
      throw new UnsupportedOperationError(
        "Raptor 3 G3P-03 updateMany limit and returning are not implemented.",
      );
    }
    const relationBearing = model["~"].relationNames.some(
      (name) => updateData[name] !== undefined,
    );
    if (!relationBearing) {
      return ctx.updateMany(
        model,
        args.where,
        ctx.schema.scalars(model, updateData),
      );
    }
    const selection = this.lookup(
      model,
      { kind: "query", where: args.where },
      new NotFoundError(model["~"].names.ts!, "update"),
    );
    const analysis = this.update(selection, updateData, raw.data, true);
    const count = await this.execution.series({
      selection,
      analysis,
      mutation: { kind: "update", raw: raw.data },
    });
    await ctx.finish();
    return { count };
  }
}
