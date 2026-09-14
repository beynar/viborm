import {
  NestedWriteError,
  NotFoundError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import type { AnyModel } from "@schema/model";
import type { OperationContext } from "../shared/operation-context";
import type { SelectorFacts } from "../shared/query";
import { type Arguments, entries, type Input, record } from "../shared/schema";
import { type Membership, physicalField } from "../shared/storage";
import {
  Assignments,
  type FieldValue,
  type MembershipContribution,
  type Origin,
} from "./assignments";
import { CommandExecution } from "./execution";
import { RelationBody } from "./relation-body";
import {
  type BoundMembership,
  Selection,
  type SelectionSource,
} from "./selection";

export { Selection } from "./selection";

type Reference = Extract<Membership, { kind: "reference" }>;
type Junction = Extract<Membership, { kind: "junction" }>;

export interface RecordCommand {
  kind: "record";
  model: AnyModel;
  fields: Assignments;
  body: CommandOccurrence[];
  transitions: Reference[];
  located?: Selection;
  requirement?: MembershipRequirement;
  operation?: string;
  origin?: Origin;
  suppression?: { readonly kind: "skipDuplicate" };
}
export interface RecordSeriesCommand {
  readonly kind: "series";
  readonly records: CommandOccurrence<RecordCommand>[];
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
  missing?: CommandOccurrence<RecordCommand>;
  found?: CommandOccurrence<RecordCommand>;
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
  readonly limit?: number;
  readonly mutation:
    | { readonly kind: "update"; readonly raw: Input }
    | { readonly kind: "delete" };
}
export type SelectedSeriesMember = RecordCommand | Deletion;
export interface SeriesOccurrence {
  readonly kind: "selectedSeries";
  readonly series: SelectedSeries;
  readonly template: CommandOccurrence<RecordCommand | Deletion>;
}
export interface SeriesCapture {
  readonly kind: "captureSeries";
  readonly target: CommandOccurrence<SeriesOccurrence>;
}
export interface MembershipMutation {
  readonly kind: "membership";
}
export type Placement = "root" | "before" | "capture" | "after";
export interface CommandOccurrence<C extends Command = Command> {
  readonly kind: "occurrence";
  readonly command: C;
  readonly placement: Placement;
  children: CommandOccurrence[];
  role?: "found" | "missing" | "template" | "member";
  captureTarget?: CommandOccurrence<SeriesOccurrence>;
  parent?: CommandOccurrence;
  dependencyRead?: DependencyRead;
  refusal?: Error;
}
export interface MembershipPublication {
  readonly carrier: Assignments;
  readonly identity?: SelectorFacts;
  readonly contribution: MembershipContribution;
}
export interface DependencyRead {
  readonly occurrence: CommandOccurrence;
  readonly lookup: Selection;
  readonly owner: CommandOccurrence<RecordCommand>;
  readonly membership?: BoundMembership;
  readonly target: boolean;
}
interface DependencyWrite {
  readonly occurrence: CommandOccurrence;
  readonly command?: RecordCommand | Deletion | Link | Removal;
  readonly membership?: MembershipPublication;
}
interface BranchPath {
  readonly parent?: BranchPath;
  readonly choice: CommandOccurrence;
  readonly arm: "found" | "missing";
}
interface ReadVisit {
  readonly read: DependencyRead;
  readonly branch?: BranchPath;
}
interface WriteVisit {
  readonly write: DependencyWrite;
  readonly branch?: BranchPath;
}
interface SeriesRefusal {
  readonly error: Error;
  readonly member: SelectedSeriesMember;
}
export type Command = (
  | RecordCommand
  | Selection
  | JunctionCapture
  | AbsenceRequirement
  | Choose
  | Link
  | Removal
  | Deletion
  | RecordSeriesCommand
  | SeriesCapture
  | SeriesOccurrence
  | MembershipMutation
) & { membershipPublications?: MembershipPublication[] };

export function isRecordOccurrence(
  occurrence: CommandOccurrence
): occurrence is CommandOccurrence<RecordCommand> {
  return occurrence.command.kind === "record";
}
export function isSeriesOccurrence(
  occurrence: CommandOccurrence
): occurrence is CommandOccurrence<SeriesOccurrence> {
  return occurrence.command.kind === "selectedSeries";
}

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
    deferred = false
  ): RecordCommand {
    const command: RecordCommand = {
      kind: "record",
      model,
      operation,
      body: [],
      transitions: [],
      fields: new Assignments(
        model,
        "create",
        this.context.schema.scalars(model, admitted),
        raw,
        undefined,
        [],
        deferred
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
    deferred = false
  ): RecordCommand {
    const model = located.model;
    const command: RecordCommand = {
      kind: "record",
      model,
      located,
      body: [],
      transitions: [],
      fields: new Assignments(
        model,
        "update",
        this.context.schema.scalars(model, admitted),
        raw,
        located.fields,
        undefined,
        deferred
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
        record(raw[name])
      ).expand();
    }
  }
  createOrigin(relation: string, operation: string, slot = relation): Origin {
    return { relation, operation, slot, order: this.nextMutation++ };
  }
  occurrence<C extends Command>(
    command: C,
    placement: Placement = "root"
  ): CommandOccurrence<C> {
    const occurrence: CommandOccurrence<C> = {
      kind: "occurrence",
      command,
      placement,
      children: [],
    };
    return occurrence;
  }
  place<C extends Command>(
    parent: RecordCommand,
    command: C,
    placement: Exclude<Placement, "root">,
    origin = this.origin(command)
  ): CommandOccurrence<C> {
    const occurrence = this.occurrence(command, placement);
    const semanticOrder = origin?.order ?? -1;
    const placementOrder = (value: Placement) =>
      value === "before" ? 0 : value === "capture" ? 1 : 2;
    const following = parent.body.findIndex((candidate) => {
      const candidateOrder = this.origin(candidate.command)?.order ?? -1;
      return (
        candidateOrder > semanticOrder ||
        (candidateOrder === semanticOrder &&
          placementOrder(candidate.placement) > placementOrder(placement))
      );
    });
    parent.body.splice(
      following < 0 ? parent.body.length : following,
      0,
      occurrence
    );
    return occurrence;
  }
  private recipeChildren(command: Command): readonly CommandOccurrence[] {
    if (command.kind === "record") return command.body;
    if (command.kind === "choose")
      return [command.found, command.missing].filter(
        (arm): arm is CommandOccurrence<RecordCommand> => arm !== undefined
      );
    if (command.kind === "series") return command.records;
    if (command.kind === "selectedSeries") return [command.template];
    return [];
  }
  private materializePlacement(occurrence: CommandOccurrence): void {
    const role = (
      parent: Command,
      child: CommandOccurrence
    ): CommandOccurrence["role"] => {
      if (parent.kind === "choose")
        return child === parent.found ? "found" : "missing";
      if (parent.kind === "selectedSeries") return "template";
      return undefined;
    };
    const sources = this.recipeChildren(occurrence.command);
    const replacements = new Map<CommandOccurrence, CommandOccurrence>();
    occurrence.children = sources.map((source) => {
      const replacement = this.occurrence(source.command, source.placement);
      replacement.role = role(occurrence.command, source);
      replacements.set(source, replacement);
      return replacement;
    });
    for (const [source, replacement] of replacements) {
      if (source.command.kind === "captureSeries") {
        const resolved = replacements.get(source.command.target);
        if (!(resolved && isSeriesOccurrence(resolved)))
          throw new Error("Series capture target lost its occurrence kind");
        replacement.captureTarget = resolved;
      }
    }
    for (const child of occurrence.children) this.materializePlacement(child);
  }
  private origin(command: Command): Origin | undefined {
    if (command.kind === "choose") return command.lookup.origin;
    if (command.kind === "captureSeries")
      return command.target.command.series.selection.origin;
    if (command.kind === "selectedSeries")
      return command.series.selection.origin;
    if (command.kind === "junction") return command.address.origin;
    if (
      command.kind === "record" ||
      command.kind === "delete" ||
      command.kind === "lookup"
    )
      return command.origin;
    return undefined;
  }
  assignMembership(
    edge: Reference,
    destination: Assignments,
    producer: Assignments,
    contribution?: MembershipContribution
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
          referenced
        ).scalar["~"].state;
        if (!scalar.autoGenerate)
          destination.reject(
            new UnsupportedOperationError(
              `query-engine-v2 create cannot resolve the parent id for relation '${edge.name}': referenced field '${referenced}' is neither this record's primary key nor a knowable value in its own create data.`
            )
          );
      }
      destination.contribute(
        field,
        producer.field(referenced),
        `query-engine-v2 ${destination.operation} has conflicting final assignments for column '${this.context.queries.columnName(destination.model, field)}' on relation '${edge.name}'.`,
        contribution
      );
    }
    if (edge.discriminator)
      destination.contribute(
        edge.discriminator.field,
        { kind: "literal", value: edge.discriminator.value },
        `Conflicting stored discriminator for relation '${edge.name}'.`,
        contribution
      );
  }
  publishMembership(
    owner: CommandOccurrence,
    carrier: Assignments,
    contribution: MembershipContribution
  ): void {
    (owner.command.membershipPublications ??= []).push({
      carrier,
      identity: contribution.identity,
      contribution,
    });
  }
  analyze(root: RecordCommand): CommandOccurrence<RecordCommand> {
    const occurrence = this.occurrence(root);
    this.materializePlacement(occurrence);
    this.bindTree(occurrence);
    this.analyzeOccurrence(occurrence);
    return occurrence;
  }
  analyzeSeries(series: SelectedSeries): CommandOccurrence<SeriesOccurrence> {
    const occurrence = this.occurrence(this.selectedSeries(series));
    this.materializePlacement(occurrence);
    this.bindTree(occurrence);
    this.analyzeOccurrence(occurrence);
    return occurrence;
  }
  selectedSeries(series: SelectedSeries): SeriesOccurrence {
    return {
      kind: "selectedSeries",
      series,
      template: this.occurrence(series.analysis),
    };
  }
  childrenOf(occurrence: CommandOccurrence): readonly CommandOccurrence[] {
    return occurrence.children;
  }
  membershipPublications(
    occurrence: CommandOccurrence
  ): readonly MembershipPublication[] {
    return occurrence.command.membershipPublications ?? [];
  }
  choiceArm(
    occurrence: CommandOccurrence,
    arm: "found" | "missing"
  ): CommandOccurrence<RecordCommand> | undefined {
    if (occurrence.command.kind !== "choose") return undefined;
    const child = occurrence.children.find(
      (candidate) => candidate.role === arm
    );
    return child && isRecordOccurrence(child) ? child : undefined;
  }
  seriesMembers(
    occurrence: CommandOccurrence<SeriesOccurrence>
  ): CommandOccurrence<RecordCommand | Deletion>[] {
    return occurrence.children.filter(
      (child): child is CommandOccurrence<RecordCommand | Deletion> =>
        child.role === "member" &&
        (child.command.kind === "record" || child.command.kind === "delete")
    );
  }
  seriesCaptureTarget(
    occurrence: CommandOccurrence
  ): CommandOccurrence<SeriesOccurrence> {
    if (occurrence.command.kind !== "captureSeries")
      throw new Error("Command occurrence is not a series capture");
    const target = occurrence.captureTarget;
    if (!target) throw new Error("Series capture has no occurrence target");
    return target;
  }
  private readMembership(write: DependencyWrite, read: DependencyRead): void {
    const { lookup, owner } = read;
    const membership = read.membership ?? lookup.membership();
    if (!(lookup.origin && membership) || membership.edge.kind !== "reference")
      return;
    const edge = membership.edge;
    const carrier = edge.owner === "source" ? edge.source : edge.target;
    const observed =
      edge.owner === "source" ? owner.command.located?.facts : lookup.facts;
    const publication = write.membership;
    if (!publication || publication.carrier.model !== carrier) return;
    const contribution = publication.contribution;
    const ownerDiffers = write.occurrence.command !== lookup;
    if (!ownerDiffers) return;
    const sameEdge = contribution.scope.edge === edge.scope.edge;
    if (!sameEdge) return;
    const sameMember =
      contribution.scope.member === undefined ||
      contribution.scope.member === edge.scope.member;
    if (!sameMember) return;
    const identity = publication.identity;
    let disjoint = false;
    if (observed && identity)
      for (const [key, value] of observed.equals) {
        const conflicts =
          !publication.carrier.writesField(key) &&
          identity.equals.has(key) &&
          !Object.is(identity.equals.get(key), value);
        if (conflicts) {
          disjoint = true;
          break;
        }
      }
    if (disjoint) return;
    const relation = lookup.origin.slot ?? lookup.origin.relation;
    const operation = lookup.origin.operation;
    const earlier = contribution.origin.operation;
    owner.refusal ??= new NestedWriteError(
      `Nested operation '${operation}' on relation '${relation}' depends on an earlier '${earlier}' membership write in the same nested write. Split these operations into separate queries.`,
      relation,
      { meta: { operation, conflictsWith: earlier, relation } }
    );
  }
  private readTarget(write: DependencyWrite, read: DependencyRead): void {
    const { lookup, owner } = read;
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
    const mutation = write.command;
    if (!mutation) return;
    for (const scope of scopes) {
      if (mutation.kind === "link" || mutation.kind === "remove") {
        const observed = scope.path.at(-1);
        const sameEdge =
          observed !== undefined &&
          observed.scope.edge === mutation.edge.scope.edge;
        if (!sameEdge) continue;
        const origin = lookup.origin;
        owner.refusal ??= new NestedWriteError(
          `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier membership write in the same nested write. Split these operations into separate queries.`,
          origin.relation,
          {
            meta: {
              operation: origin.operation,
              conflictsWith:
                mutation.kind === "link" ? "connect" : "disconnect",
              dependency: "membership",
              overlap: "unknown",
            },
          }
        );
        return;
      }
      const model =
        mutation.kind === "delete" ? mutation.located.model : mutation.model;
      if (model !== scope.model) continue;
      if (
        mutation.kind === "record" &&
        mutation.fields.operation !== "create" &&
        !mutation.located?.membership()?.edge.many
      ) {
        let hasWrittenOverlap = false;
        for (const field of mutation.fields.writtenFields()) {
          hasWrittenOverlap = scope.fields.has(field);
          if (hasWrittenOverlap) break;
        }
        if (!hasWrittenOverlap) continue;
      }
      let matched = 0;
      let disjoint = false;
      for (const [field, expected] of scope.equals) {
        const value =
          mutation.kind === "record" && mutation.fields.operation === "create"
            ? mutation.fields.known(field)
            : undefined;
        const selected =
          mutation.located?.facts.exact &&
          !(mutation.kind === "record" && mutation.fields.writesField(field))
            ? mutation.located
            : undefined;
        const known =
          value?.kind === "literal"
            ? value.value
            : selected?.facts.equals.get(field);
        const hasKnown =
          value?.kind === "literal" || selected?.facts.equals.has(field);
        if (!(hasKnown && scope.exact)) continue;
        const equal = Object.is(known, expected);
        if (!equal) {
          disjoint = true;
          break;
        }
        matched++;
      }
      if (disjoint) continue;
      const origin = lookup.origin;
      const operation =
        mutation.origin?.operation ??
        (mutation.kind === "delete" ? "delete" : mutation.fields.operation);
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
        }
      );
      return;
    }
  }
  private bindTree(
    occurrence: CommandOccurrence,
    parent?: CommandOccurrence
  ): void {
    occurrence.parent = parent;
    occurrence.dependencyRead ??= this.dependencyRead(occurrence);
    for (const child of occurrence.children) this.bindTree(child, occurrence);
  }
  private dependencyRead(
    occurrence: CommandOccurrence
  ): DependencyRead | undefined {
    const command = occurrence.command;
    const owner = isSeriesOccurrence(occurrence)
      ? this.seriesOwner(occurrence)
      : this.recordOwner(occurrence);
    if (!owner) return undefined;
    if (command.kind === "choose")
      return {
        occurrence,
        lookup: command.lookup,
        owner,
        membership: command.foundRequirement?.membership,
        target: true,
      };
    if (command.kind === "delete")
      return {
        occurrence,
        lookup: command.located,
        owner,
        target: true,
      };
    if (command.kind === "selectedSeries")
      return {
        occurrence,
        lookup: command.series.selection,
        owner,
        target: true,
      };
    return undefined;
  }
  private recordOwner(
    occurrence: CommandOccurrence
  ): CommandOccurrence<RecordCommand> | undefined {
    let candidate = occurrence.parent;
    while (candidate) {
      if (isRecordOccurrence(candidate)) return candidate;
      candidate = candidate.parent;
    }
    return undefined;
  }
  private seriesOwner(
    occurrence: CommandOccurrence<SeriesOccurrence>
  ): CommandOccurrence<RecordCommand> | undefined {
    const owner = this.recordOwner(occurrence);
    if (owner) return owner;
    const template = occurrence.children.find(
      (child) => child.role === "template"
    );
    return template && isRecordOccurrence(template) ? template : undefined;
  }
  private compatible(left?: BranchPath, right?: BranchPath): boolean {
    for (let a = left; a; a = a.parent)
      for (let b = right; b; b = b.parent)
        if (a.choice === b.choice && a.arm !== b.arm) return false;
    return true;
  }
  private visitDirectWrites(
    occurrence: CommandOccurrence,
    visit: (write: WriteVisit) => void,
    branch?: BranchPath
  ): void {
    const command = occurrence.command;
    if (
      (command.kind === "record" &&
        (command.fields.operation === "create" ||
          command.fields.writtenFields().length)) ||
      command.kind === "delete" ||
      command.kind === "link" ||
      command.kind === "remove"
    ) {
      const write = { occurrence, command };
      visit({ write, branch });
    }
    for (const membership of this.membershipPublications(occurrence)) {
      const write = { occurrence, membership };
      visit({ write, branch });
    }
  }
  private visitWrites(
    occurrence: CommandOccurrence,
    visit: (write: WriteVisit) => void,
    branch: BranchPath | undefined
  ): void {
    this.visitDirectWrites(occurrence, visit, branch);
    for (const child of occurrence.children) {
      const childBranch: BranchPath | undefined =
        occurrence.command.kind === "choose"
          ? {
              parent: branch,
              choice: occurrence,
              arm: child.role === "found" ? "found" : "missing",
            }
          : branch;
      this.visitWrites(child, visit, childBranch);
    }
  }
  private visitReads(
    occurrence: CommandOccurrence,
    visit: (read: ReadVisit) => "stop" | void,
    branch: BranchPath | undefined
  ): boolean {
    const read = occurrence.dependencyRead;
    if (read) {
      const readVisit = { read, branch };
      if (visit(readVisit) === "stop") return true;
    }
    for (const child of occurrence.children) {
      const childBranch: BranchPath | undefined =
        occurrence.command.kind === "choose"
          ? {
              parent: branch,
              choice: occurrence,
              arm: child.role === "found" ? "found" : "missing",
            }
          : branch;
      if (this.visitReads(child, visit, childBranch)) return true;
    }
    return false;
  }
  private visitPrecedingWrites(
    target: CommandOccurrence,
    visit: (write: WriteVisit) => void,
    branch: BranchPath | undefined
  ): void {
    const parent = target.parent;
    if (!parent) return;
    const parentBranch =
      parent.command.kind === "choose" ? branch?.parent : branch;
    this.visitPrecedingWrites(parent, visit, parentBranch);
    this.visitDirectWrites(parent, visit, parentBranch);
    if (parent.command.kind === "choose") return;
    if (this.isSeriesMember(parent, target)) return;
    for (const sibling of parent.children) {
      if (sibling === target) return;
      this.visitWrites(sibling, visit, parentBranch);
    }
    throw new Error("Command occurrence is missing from its parent");
  }
  private analyzeRead(occurrence: CommandOccurrence): void {
    const read = occurrence.dependencyRead;
    if (!read) return;
    const branch = this.branchOf(occurrence);
    const readVisit = { read, branch };
    let publishedParent: CommandOccurrence<RecordCommand> | undefined;
    for (
      let child: CommandOccurrence | undefined = occurrence;
      child?.parent;
      child = child.parent
    ) {
      const parent = child.parent;
      if (!isSeriesOccurrence(parent) || child.role !== "member") continue;
      if (parent.command.series.selection.membership())
        publishedParent = this.seriesOwner(parent);
      break;
    }
    this.visitPrecedingWrites(
      occurrence,
      (write) => {
        if (write.write.occurrence === publishedParent) return;
        this.checkPair(write, readVisit);
      },
      branch
    );
  }
  private checkPair(write: WriteVisit, read: ReadVisit): void {
    if (!this.compatible(write.branch, read.branch)) return;
    this.readMembership(write.write, read.read);
    if (read.read.target) this.readTarget(write.write, read.read);
  }
  private activeRefusal(read: ReadVisit): Error | undefined {
    for (let branch = read.branch; branch; branch = branch.parent) {
      if (branch.arm === "missing") return undefined;
      const choice = branch.choice.command;
      if (
        choice.kind !== "choose" ||
        !this.execution.attempt.rows.has(choice.lookup)
      )
        return undefined;
    }
    return read.read.owner.refusal;
  }
  private analyzeOccurrence(occurrence: CommandOccurrence): void {
    this.analyzeRead(occurrence);
    const command = occurrence.command;
    if (command.kind === "record") {
      if (command.suppression) this.context.requireSuppression();
      for (const child of occurrence.children) this.analyzeOccurrence(child);
      for (const child of occurrence.children) {
        const childCommand = child.command;
        if (childCommand.kind === "record")
          occurrence.refusal ??= child.refusal;
        else if (childCommand.kind === "choose") {
          const found = this.choiceArm(child, "found");
          const missing = this.choiceArm(child, "missing");
          if (found && !missing) occurrence.refusal ??= found.refusal;
        } else if (childCommand.kind === "series")
          for (const record of child.children)
            occurrence.refusal ??= record.refusal;
        else if (childCommand.kind === "selectedSeries") {
          const template = child.children.find(
            (candidate) => candidate.role === "template"
          );
          if (template && isRecordOccurrence(template))
            occurrence.refusal ??= template.refusal;
        }
      }
      return;
    }
    if (command.kind === "choose") {
      for (const child of occurrence.children) this.analyzeOccurrence(child);
      return;
    }
    if (command.kind === "series") {
      for (const record of occurrence.children) this.analyzeOccurrence(record);
      return;
    }
    if (command.kind === "selectedSeries") {
      const template = occurrence.children.find(
        (child) => child.role === "template"
      );
      if (template) this.analyzeOccurrence(template);
    }
  }
  private branchOf(occurrence: CommandOccurrence): BranchPath | undefined {
    const parent = occurrence.parent;
    if (!parent) return undefined;
    const branch = this.branchOf(parent);
    if (parent.command.kind !== "choose") return branch;
    return {
      parent: branch,
      choice: parent,
      arm: occurrence.role === "found" ? "found" : "missing",
    };
  }
  private isSeriesMember(
    parent: CommandOccurrence,
    child: CommandOccurrence
  ): boolean {
    return (
      parent.command.kind === "series" ||
      (isSeriesOccurrence(parent) && child.role === "member")
    );
  }
  private visitFollowingReads(
    target: CommandOccurrence,
    visit: (read: ReadVisit) => "stop" | void,
    branch: BranchPath | undefined
  ): boolean {
    let current = target;
    while (current.parent) {
      const parent = current.parent;
      const parentBranch =
        parent.command.kind === "choose" ? branch?.parent : branch;
      let follows = false;
      if (!this.isSeriesMember(parent, current)) {
        for (const sibling of parent.children) {
          if (follows) {
            const siblingBranch: BranchPath | undefined =
              parent.command.kind === "choose"
                ? {
                    parent: parentBranch,
                    choice: parent,
                    arm: sibling.role === "found" ? "found" : "missing",
                  }
                : parentBranch;
            const stopped = this.visitReads(sibling, visit, siblingBranch);
            if (stopped) return true;
          } else if (sibling === current) follows = true;
        }
      }
      current = parent;
      branch = parentBranch;
    }
    return false;
  }
  expandSeries(
    occurrence: CommandOccurrence<SeriesOccurrence>,
    members: readonly SelectedSeriesMember[]
  ): SeriesRefusal | undefined {
    const owner = this.seriesOwner(occurrence);
    if (!owner) throw new Error("Selected series has no enclosing analysis");
    if (this.seriesMembers(occurrence).length)
      throw new Error("Selected series occurrence was already expanded");
    occurrence.children = members.map((member) => {
      const child = this.occurrence(member);
      child.role = "member";
      this.materializePlacement(child);
      return child;
    });
    const memberOccurrences = this.seriesMembers(occurrence);
    const seriesBranch = this.branchOf(occurrence);
    for (const member of memberOccurrences) this.bindTree(member, occurrence);
    for (const member of memberOccurrences) {
      this.analyzeOccurrence(member);
    }
    for (const [index, occurrenceMember] of memberOccurrences.entries()) {
      const member = members[index];
      if (!member) continue;
      if (occurrenceMember.command.kind === "record") {
        const refusal = occurrenceMember.refusal;
        if (refusal) return { error: refusal, member };
      }
      let refusal: Error | undefined;
      this.visitWrites(
        occurrenceMember,
        (write) => {
          if (
            this.visitFollowingReads(
              occurrence,
              (read) => {
                this.checkPair(write, read);
                refusal ??= this.activeRefusal(read);
                return refusal ? "stop" : undefined;
              },
              seriesBranch
            )
          )
            return;
        },
        seriesBranch
      );
      if (refusal) return { error: refusal, member };
    }
    return undefined;
  }
  lookup(
    model: AnyModel,
    source: SelectionSource,
    required?: Error,
    facts?: SelectorFacts
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
          this.context.schema.identity(selection.model, row)
        ),
      },
      selection.required
    );
  }
  async execute(
    model: AnyModel,
    args: Arguments,
    raw: Arguments
  ): Promise<unknown> {
    const ctx = this.context;
    if (ctx.operation === "createMany") {
      const rows = entries(args.data);
      const relationBearing = rows.some((row) =>
        model["~"].relationNames.some((name) => row[name] !== undefined)
      );
      if (relationBearing) {
        const rawRows = entries(raw.data);
        const records = rows.map((row, index) => {
          const record = this.create(model, row, rawRows[index]!);
          if (args.skipDuplicates)
            record.suppression = { kind: "skipDuplicate" };
          return record;
        });
        const occurrences = records.map((record) => {
          for (const field of ctx.schema.keys(model))
            record.fields.field(field);
          return this.analyze(record);
        });
        const series: RecordSeriesCommand = {
          kind: "series",
          records: occurrences,
          select: args.select,
        };
        return this.execution.records(series.records, series.select, series);
      }
      return ctx.createMany(
        model,
        rows.map((row) => ctx.schema.scalars(model, row)),
        args.select,
        args.skipDuplicates
      );
    }
    if (ctx.operation === "deleteMany") {
      if (args.limit === 0) return ctx.emptyBulkResult(args.select);
      return ctx.deleteMany(
        model,
        ctx.queries.prepareSelector(model, args.where),
        args.limit,
        args.select
      );
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
            { meta: { model: model["~"].names.ts!, operation: "upsert" } }
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
      const found = this.occurrence(
        this.update(lookup, args.update!, raw.update!, true)
      );
      const choice: Choose = {
        kind: "choose",
        model,
        lookup,
        operation: "upsert",
        missing: this.occurrence(missing),
        conditions: {
          probes,
          missingRow: new NotFoundError(model["~"].names.ts!, "upsert"),
        },
        fields: new Assignments(model, "select", {}, {}, undefined, [
          missing.fields,
        ]),
        found,
      };
      found.command.operation = "upsert";
      choice.fields.forward(found.command.fields);
      for (const field of ctx.schema.keys(model)) choice.fields.field(field);
      const occurrence = this.occurrence(choice);
      this.materializePlacement(occurrence);
      this.bindTree(occurrence);
      this.analyzeOccurrence(occurrence);
      return this.execution.complete(occurrence, args);
    }
    if (ctx.operation === "create" || ctx.operation === "update") {
      const root =
        ctx.operation === "create"
          ? this.create(model, args.data, raw.data)
          : this.update(
              this.lookup(
                model,
                { kind: "query", where: args.where! },
                new NotFoundError(model["~"].names.ts!, "update")
              ),
              args.data,
              raw.data
            );
      for (const field of ctx.schema.keys(model)) root.fields.field(field);
      return this.execution.complete(this.analyze(root), args);
    }
    const updateData = args.data;
    const relationBearing = model["~"].relationNames.some(
      (name) => updateData[name] !== undefined
    );
    if (args.limit === 0) return ctx.emptyBulkResult(args.select);
    if (!relationBearing) {
      return ctx.updateMany(
        model,
        ctx.queries.prepareSelector(model, args.where),
        ctx.schema.scalars(model, updateData),
        args.limit,
        args.select
      );
    }
    const selection = this.lookup(
      model,
      { kind: "query", where: args.where },
      new NotFoundError(model["~"].names.ts!, "update")
    );
    const analysis = this.update(selection, updateData, raw.data, true);
    const series: SelectedSeries = {
      selection,
      analysis,
      limit: args.limit,
      mutation: { kind: "update", raw: raw.data },
    };
    const occurrence = this.analyzeSeries(series);
    if (args.select)
      return this.execution.series(occurrence, series.selection, args.select);
    const count = await this.execution.series(occurrence);
    return { count };
  }
}
