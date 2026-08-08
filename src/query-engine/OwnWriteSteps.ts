// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { Model } from "@schema/model";
import type {
  BoundRelation,
  ParentHeldToOne,
} from "./builders/relation-data-builder";
import type { RelationMutationEntry } from "./builders/relation-mutation-parser";
import type { OwnWriteFootprint, OwnWriteLedger } from "./OwnWriteLedger";
import type { OwnWriteRelation } from "./OwnWriteRelation";
import {
  classifyRelationKeyScalarUpdate,
  classifyTargetConstraintOverlap,
  getCreatedWhereUniqueTarget,
  getFilterPredicateFields,
  getFilterTargetConstraint,
  getTargetIdentityFields,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
  selectorConstraint,
  type TargetConstraint,
  unknownConstraint,
  updateResultConstraints,
} from "./TargetConstraint";
import { QueryEngineError } from "./types";

export class OwnWriteSteps {
  private readonly relation: OwnWriteRelation;

  constructor(relation: OwnWriteRelation) {
    this.relation = relation;
  }

  processTree(entry: RelationMutationEntry): void {
    if (entry.kind === "create") {
      for (const createData of entry.items) {
        const insertSummary = this.relation.getInsertSummary(
          "create",
          createData
        );
        this.relation.analyzeCreate(createData, "create", insertSummary);
        if (!insertSummary) {
          this.relation.appendCreateSummary("create", createData, {
            appendTarget: false,
          });
        }
      }
      return;
    }

    if (entry.kind === "update") {
      this.processNestedUpdate(entry);
      return;
    }

    if (processOwnWriteBranchEntry(this.relation, entry)) return;
    this.process(entry);
  }

  process(entry: RelationMutationEntry): void {
    switch (entry.kind) {
      case "create":
        for (const data of entry.items) {
          this.relation.appendCreateSummary("create", data);
        }
        return;
      case "createMany":
        for (const data of entry.rows) {
          this.relation.appendCreateSummary("createMany", data);
        }
        return;
      case "connect":
        this.processConnect(entry);
        return;
      case "connectOrCreate": {
        const entryLedger = this.relation.ledger.fork();
        const priorItems: ConnectOrCreateAnalysis[] = [];
        for (const {
          input,
          target,
          repeatedSelector,
        } of prepareConnectOrCreateItems(this.relation, entry.items)) {
          const selector = assertConnectOrCreateDecision(
            this.relation,
            entryLedger,
            priorItems,
            input,
            target,
            repeatedSelector
          );
          const checkpoint = this.relation.ledger.checkpoint();
          this.relation.appendCreateSummary("connectOrCreate", input.create);
          this.relation.appendMembership("connectOrCreate", selector);
          priorItems.push({
            target,
            writes: this.relation.ledger.deltaSince(checkpoint),
          });
        }
        return;
      }
      case "disconnect":
        this.processDisconnect(entry);
        return;
      case "delete":
        this.processDelete(entry);
        return;
      case "set":
        this.processSet(entry);
        return;
      case "update":
        this.processUpdate(entry);
        return;
      case "upsert":
        for (const input of entry.items) {
          const decision = this.relation.assertUpsertDecision(
            input.target.kind === "unique" ? input.target.where : undefined
          );
          this.relation.appendUpsertUpdateSummary(input, decision);
          this.relation.appendCreateSummary("upsert", input.create);
          this.relation.appendMembership("upsert", decision);
        }
        return;
      case "updateMany": {
        const unknown = unknownConstraint(this.relation.target);
        this.relation.appendTarget("updateMany", unknown);
        this.relation.appendMembership("updateMany", unknown);
        return;
      }
      case "deleteMany":
        this.processDeleteMany(entry);
        return;
      default: {
        const exhaustive: never = entry;
        throw new TypeError(
          `Unsupported own-write step: ${String(exhaustive)}`
        );
      }
    }
  }

  private processNestedUpdate(
    entry: Extract<RelationMutationEntry, { kind: "update" }>
  ): void {
    this.process(entry);
    for (const input of entry.items) {
      this.relation.analyzeUpdate(
        input.data,
        input.target.kind === "unique" ? input.target.where : undefined
      );
    }
  }

  private processConnect(
    entry: Extract<RelationMutationEntry, { kind: "connect" }>
  ): void {
    for (const where of entry.targets) {
      const selector = selectorConstraint(this.relation.target, where);
      if (
        this.relation.family.kind === "update" &&
        this.relation.boundRelation.kind === "parentHeldToOne"
      ) {
        this.relation.ledger.assertTargetRead(
          this.relation.relationName,
          "connect",
          selector
        );
      }
      this.relation.appendMembership("connect", selector);
    }
  }

  private processDisconnect(
    entry: Extract<RelationMutationEntry, { kind: "disconnect" }>
  ): void {
    const constraints = (
      entry.target.kind === "selectors" ? entry.target.targets : []
    ).map((where) => selectorConstraint(this.relation.target, where));

    if (this.relation.boundRelation.kind !== "junction") {
      for (const constraint of constraints) {
        this.relation.assertTargetAndMembershipRead("disconnect", constraint);
      }
    }

    if (entry.target.kind === "current") {
      this.relation.appendMembership(
        "disconnect",
        unknownConstraint(this.relation.target)
      );
      return;
    }
    for (const constraint of constraints) {
      this.relation.appendMembership("disconnect", constraint);
    }
  }

  private processDelete(
    entry: Extract<RelationMutationEntry, { kind: "delete" }>
  ): void {
    if (entry.target.kind === "current") {
      const unknown = unknownConstraint(this.relation.target);
      this.relation.appendMembership("delete", unknown);
      this.relation.appendTarget("delete", unknown);
      return;
    }

    const constraints = entry.target.targets.map((where) =>
      selectorConstraint(this.relation.target, where)
    );
    if (this.relation.boundRelation.kind === "junction") {
      for (const constraint of constraints) {
        this.relation.ledger.assertTargetRead(
          this.relation.relationName,
          "delete",
          constraint
        );
        this.relation.appendMembership("delete", constraint);
        this.relation.appendTarget("delete", constraint);
      }
      return;
    }

    for (const constraint of constraints) {
      this.relation.assertTargetAndMembershipRead("delete", constraint);
    }
    for (const constraint of constraints) {
      this.relation.appendMembership("delete", constraint);
      this.relation.appendTarget("delete", constraint);
    }
  }

  private processSet(
    entry: Extract<RelationMutationEntry, { kind: "set" }>
  ): void {
    for (const where of entry.targets) {
      const constraint = selectorConstraint(this.relation.target, where);
      this.relation.ledger.assertTargetRead(
        this.relation.relationName,
        "set",
        constraint
      );
      if (this.relation.boundRelation.kind !== "junction") {
        this.relation.assertMembershipRead("set", constraint);
      }
    }
    this.relation.appendMembership(
      "set",
      unknownConstraint(this.relation.target)
    );
  }

  private processUpdate(
    entry: Extract<RelationMutationEntry, { kind: "update" }>
  ): void {
    if (
      this.relation.boundRelation.kind === "parentHeldToOne" ||
      this.relation.boundRelation.kind === "childHeldToOne"
    ) {
      const [input] = entry.items;
      if (!input) return;
      const footprint = buildToOneUpdateFootprint(
        this.relation.boundRelation,
        input.data,
        this.relation.family.kind === "update"
          ? this.relation.family.scalarData
          : undefined
      );
      if (input.target.kind === "correlated" && input.target.filter) {
        const filterConstraint = getFilterTargetConstraint(
          this.relation.target,
          input.target.filter
        );
        this.relation.assertTargetAndMembershipRead(
          "update",
          filterConstraint,
          getFilterPredicateFields(this.relation.target, input.target.filter)
        );
      } else {
        this.relation.assertMembershipRead("update", footprint.readConstraint);
      }
      for (const constraint of footprint.resultConstraints) {
        this.relation.ledger.appendTarget(
          "update",
          "targetPredicate",
          constraint,
          footprint.changedFields
        );
      }
      if (footprint.writesMembership) {
        this.relation.appendMembership("update", footprint.readConstraint);
      }
      return;
    }

    for (const input of entry.items) {
      if (input.target.kind !== "unique") continue;
      const selector = selectorConstraint(
        this.relation.target,
        input.target.where
      );
      this.relation.assertTargetAndMembershipRead("update", selector);
      const resultConstraints = updateResultConstraints(
        this.relation.target,
        selector,
        input.data,
        input.target.where
      );
      if (resultConstraints.length === 0) {
        this.relation.ledger.appendRelationTarget("update", selector);
      }
      for (const constraint of resultConstraints) {
        this.relation.appendTarget("update", constraint);
      }
    }
  }

  private processDeleteMany(
    entry: Extract<RelationMutationEntry, { kind: "deleteMany" }>
  ): void {
    const unknown = unknownConstraint(this.relation.target);
    if (this.relation.boundRelation.kind === "junction") {
      for (const filter of entry.filters) {
        const constraint = getFilterTargetConstraint(
          this.relation.target,
          filter
        );
        this.relation.assertTargetAndMembershipRead(
          "deleteMany",
          constraint,
          getFilterPredicateFields(this.relation.target, filter)
        );
        this.relation.appendTarget("deleteMany", constraint);
        this.relation.appendMembership("deleteMany", constraint);
      }
      return;
    }
    this.relation.appendTarget("deleteMany", unknown);
    this.relation.appendMembership("deleteMany", unknown);
  }
}

function processOwnWriteBranchEntry(
  relation: OwnWriteRelation,
  entry: RelationMutationEntry
): boolean {
  if (entry.kind === "connectOrCreate") {
    processConnectOrCreateBranches(relation, entry);
    return true;
  }
  if (entry.kind === "upsert") {
    processUpsertBranches(relation, entry);
    return true;
  }
  return false;
}

function processConnectOrCreateBranches(
  relation: OwnWriteRelation,
  entry: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>
): void {
  const entryLedger = relation.ledger.fork();
  const priorItems: ConnectOrCreateAnalysis[] = [];
  for (const {
    input,
    target,
    repeatedSelector,
  } of prepareConnectOrCreateItems(relation, entry.items)) {
    const selector = assertConnectOrCreateDecision(
      relation,
      entryLedger,
      priorItems,
      input,
      target,
      repeatedSelector
    );
    const checkpoint = relation.ledger.checkpoint();
    analyzeAlternativeBranches(relation, [
      (createBranch) => {
        const insertSummary = createBranch.getInsertSummary(
          "connectOrCreate",
          input.create
        );
        createBranch.analyzeCreate(
          input.create,
          "connectOrCreate",
          insertSummary
        );
        if (!insertSummary) {
          createBranch.appendCreateSummary("connectOrCreate", input.create, {
            appendTarget: false,
          });
        }
      },
      (foundBranch) => {
        foundBranch.appendMembership("connectOrCreate", selector);
      },
    ]);
    priorItems.push({
      target,
      writes: relation.ledger.deltaSince(checkpoint),
    });
  }
}

function processUpsertBranches(
  relation: OwnWriteRelation,
  entry: Extract<RelationMutationEntry, { kind: "upsert" }>
): void {
  for (const input of entry.items) {
    const selector =
      input.target.kind === "unique" ? input.target.where : undefined;
    const decision = relation.assertUpsertDecision(selector);
    analyzeAlternativeBranches(relation, [
      (updateBranch) => {
        updateBranch.analyzeUpdate(input.update, selector, "upsert");
      },
      (createBranch) => {
        const insertSummary = createBranch.getInsertSummary(
          "upsert",
          input.create
        );
        createBranch.analyzeCreate(input.create, "upsert", insertSummary);
        if (!insertSummary) {
          createBranch.appendCreateSummary("upsert", input.create, {
            appendTarget: false,
          });
        }
      },
    ]);
    relation.appendMembership("upsert", decision);
  }
}

function analyzeAlternativeBranches(
  relation: OwnWriteRelation,
  branches: readonly ((branch: OwnWriteRelation) => void)[]
): void {
  const checkpoint = relation.ledger.checkpoint();
  const membershipCheckpoint = relation.membershipLedger?.checkpoint();
  const deltas = branches.map((analyzeBranch) => {
    const branchLedger = relation.ledger.fork();
    const branchMembershipLedger = relation.membershipLedger?.fork();
    analyzeBranch(relation.fork(branchLedger, branchMembershipLedger));
    return {
      memberships: getMembershipDelta(
        branchMembershipLedger,
        membershipCheckpoint
      ),
      writes: branchLedger.deltaSince(checkpoint),
    };
  });

  relation.ledger.mergeDeltas(...deltas.map((delta) => delta.writes));
  relation.membershipLedger?.mergeDeltas(
    ...deltas.map((delta) => delta.memberships)
  );
}

function getMembershipDelta(
  ledger: OwnWriteRelation["membershipLedger"],
  checkpoint: number | undefined
): OwnWriteFootprint[] {
  if (!ledger || checkpoint === undefined) return [];
  return ledger.deltaSince(checkpoint);
}

interface ToOneUpdateFootprint {
  readonly readConstraint: TargetConstraint;
  readonly changedFields: ReadonlySet<string>;
  readonly resultConstraints: readonly TargetConstraint[];
  readonly writesMembership: boolean;
}

function buildToOneUpdateFootprint(
  relation: BoundRelation,
  updateData: Readonly<Record<string, unknown>>,
  rootScalarData: Readonly<Record<string, unknown>> | undefined
): ToOneUpdateFootprint {
  const { relationInfo } = relation;
  const target = relationInfo.targetModel;
  const scalarData = getScalarData(target, updateData);
  const changedFields = new Set(Object.keys(scalarData));
  if (relation.kind === "junction") {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' is many-to-many and has no FK direction. ` +
        "Many-to-many writes must go through the junction table handlers."
    );
  }
  const readConstraint =
    relation.kind === "parentHeldToOne" && rootScalarData
      ? buildReboundTargetConstraint(target, relation, rootScalarData)
      : unknownConstraint(target);
  const resultConstraints: TargetConstraint[] = [];

  if (changedFields.size > 0) {
    resultConstraints.push(readConstraint);
    const identityFields = getTargetIdentityFields(target);
    if (identityFields.some((field) => changedFields.has(field))) {
      resultConstraints.push(
        normalizeTargetConstraint(target, identityFields, scalarData)
      );
    }
  }

  const membershipFields = new Set(
    relation.kind === "parentHeldToOne"
      ? relation.referencedFields
      : relation.foreignFields
  );
  if (
    relation.sourceModel === target &&
    relation.relationInfo.targetModel === target
  ) {
    for (const field of [
      ...relation.foreignFields,
      ...relation.referencedFields,
    ]) {
      membershipFields.add(field);
    }
  }
  return {
    readConstraint,
    changedFields,
    resultConstraints,
    writesMembership: [...membershipFields].some((field) =>
      changedFields.has(field)
    ),
  };
}

/**
 * A repeated connectOrCreate selector is suppressed only after an earlier
 * create is proven to satisfy it. Otherwise both planning decisions and both
 * create subtrees remain visible to OwnWrite analysis.
 */
function prepareConnectOrCreateItems(
  relation: OwnWriteRelation,
  items: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>["items"]
): readonly {
  readonly input: (typeof items)[number];
  readonly target: TargetConstraint;
  readonly repeatedSelector: boolean;
}[] {
  const uniqueItems: {
    readonly input: (typeof items)[number];
    readonly target: TargetConstraint;
    readonly repeatedSelector: boolean;
  }[] = [];
  const seenTargets: TargetConstraint[] = [];
  const createdTargets: TargetConstraint[] = [];
  for (const item of items) {
    const target = normalizeWhereUniqueTargetConstraint(
      relation.target,
      item.where
    );
    const isDuplicate = createdTargets.some(
      (createdTarget) =>
        classifyTargetConstraintOverlap(createdTarget, target) === "equal"
    );
    if (isDuplicate) continue;
    const repeatedSelector = seenTargets.some(
      (seenTarget) =>
        classifyTargetConstraintOverlap(seenTarget, target) === "equal"
    );
    uniqueItems.push({
      input: item,
      target,
      repeatedSelector,
    });
    seenTargets.push(target);
    const createdTarget = getCreatedWhereUniqueTarget(
      relation.target,
      item.where,
      item.create
    );
    if (createdTarget) createdTargets.push(createdTarget);
  }
  return uniqueItems;
}

interface ConnectOrCreateAnalysis {
  readonly target: TargetConstraint;
  readonly writes: OwnWriteFootprint[];
}

function assertConnectOrCreateDecision(
  relation: OwnWriteRelation,
  entryLedger: OwnWriteLedger,
  priorItems: readonly ConnectOrCreateAnalysis[],
  input: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>["items"][number],
  target: TargetConstraint,
  repeatedSelector: boolean
): TargetConstraint {
  if (!repeatedSelector) {
    return relation.assertConnectOrCreateDecision(input.where);
  }

  // A repeated probe shares the entry's pre-write premise with its exact
  // selector lineage. Keep every intervening alternate-selector write: those
  // may still create the row this probe names and must retain the refusal.
  const decisionLedger = entryLedger.fork();
  for (const prior of priorItems) {
    if (classifyTargetConstraintOverlap(prior.target, target) === "equal") {
      continue;
    }
    decisionLedger.mergeDeltas(prior.writes);
  }
  return relation
    .fork(decisionLedger, relation.membershipLedger?.fork())
    .assertConnectOrCreateDecision(input.where);
}

function buildReboundTargetConstraint(
  target: Model<any>,
  relation: ParentHeldToOne,
  rootScalarData: Readonly<Record<string, unknown>>
): TargetConstraint {
  const values: Record<string, unknown> = {};
  for (const [index, fkField] of relation.foreignFields.entries()) {
    const referencedField = relation.referencedFields[index];
    if (!(referencedField && Object.hasOwn(rootScalarData, fkField))) continue;
    const update = classifyRelationKeyScalarUpdate(rootScalarData[fkField]);
    if (update.resolved && update.value !== null) {
      values[referencedField] = update.value;
    }
  }
  return normalizeTargetConstraint(target, relation.referencedFields, values);
}

function getScalarData(
  model: Model<any>,
  data: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const scalars: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined && Object.hasOwn(model["~"].state.scalars, field)) {
      scalars[field] = value;
    }
  }
  return scalars;
}
