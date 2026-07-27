// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import type { Model } from "@schema/model";
import {
  getFkDirection,
  type RelationMutation,
} from "./builders/relation-data-builder";
import type { OwnWriteFootprint } from "./OwnWriteLedger";
import type { OwnWriteRelation } from "./OwnWriteRelation";
import {
  normalizeRecordArray,
  type RelationMutationStep,
} from "./RelationMutationPlan";
import {
  classifyRelationKeyScalarUpdate,
  getFilterPredicateFields,
  getFilterTargetConstraint,
  getTargetIdentityFields,
  normalizeTargetConstraint,
  selectorConstraint,
  type TargetConstraint,
  unknownConstraint,
  updateResultConstraints,
} from "./TargetConstraint";
import type { QueryScope } from "./types";

export class OwnWriteSteps {
  private readonly relation: OwnWriteRelation;

  constructor(relation: OwnWriteRelation) {
    this.relation = relation;
  }

  processTree(step: RelationMutationStep): void {
    if (!this.relation.propagateMembership) {
      this.process(step);
      return;
    }

    if (step.kind === "create") {
      for (const createData of step.inputs) {
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

    if (step.kind === "update") {
      this.processNestedUpdate(step);
      return;
    }

    if (processOwnWriteBranchStep(this.relation, step)) return;
    this.process(step);
  }

  process(step: RelationMutationStep): void {
    switch (step.kind) {
      case "create":
        for (const data of step.inputs) {
          this.relation.appendCreateSummary("create", data);
        }
        return;
      case "createMany":
        for (const data of step.input.data) {
          this.relation.appendCreateSummary("createMany", data);
        }
        return;
      case "connect":
        this.processConnect(step);
        return;
      case "connectOrCreate":
        for (const input of step.inputs) {
          const selector = this.relation.assertConnectOrCreateDecision(
            input.where
          );
          this.relation.appendCreateSummary("connectOrCreate", input.create);
          this.relation.appendMembership("connectOrCreate", selector);
        }
        return;
      case "disconnect":
        this.processDisconnect(step);
        return;
      case "delete":
        this.processDelete(step);
        return;
      case "set":
        this.processSet(step);
        return;
      case "update":
        this.processUpdate(step);
        return;
      case "upsert":
        for (const input of step.inputs) {
          const decision = this.relation.assertUpsertDecision(input.where);
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
        this.processDeleteMany(step);
        return;
      default: {
        const exhaustive: never = step;
        throw new TypeError(
          `Unsupported own-write step: ${String(exhaustive)}`
        );
      }
    }
  }

  private processNestedUpdate(
    step: Extract<RelationMutationStep, { kind: "update" }>
  ): void {
    this.process(step);
    for (const input of step.inputs) {
      this.relation.analyzeUpdate(input.data, input.selector);
    }
  }

  private processConnect(
    step: Extract<RelationMutationStep, { kind: "connect" }>
  ): void {
    for (const where of step.inputs) {
      const selector = selectorConstraint(this.relation.target, where);
      if (
        this.relation.family.kind === "update" &&
        step.context.relationInfo.type !== "manyToMany" &&
        getFkDirection(this.relation.ctx, step.context.relationInfo).holdsFK
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
    step: Extract<RelationMutationStep, { kind: "disconnect" }>
  ): void {
    if (step.input === false) return;
    const explicit =
      step.input === true ? [] : normalizeRecordArray(step.input);
    const constraints = explicit.map((where) =>
      selectorConstraint(this.relation.target, where)
    );

    if (step.context.relationInfo.type !== "manyToMany") {
      for (const constraint of constraints) {
        this.relation.assertTargetAndMembershipRead("disconnect", constraint);
      }
    }

    if (step.input === true) {
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
    step: Extract<RelationMutationStep, { kind: "delete" }>
  ): void {
    if (step.input === false) return;
    if (step.input === true) {
      const unknown = unknownConstraint(this.relation.target);
      this.relation.appendMembership("delete", unknown);
      this.relation.appendTarget("delete", unknown);
      return;
    }

    const constraints = normalizeRecordArray(step.input).map((where) =>
      selectorConstraint(this.relation.target, where)
    );
    if (step.context.relationInfo.type === "manyToMany") {
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
    step: Extract<RelationMutationStep, { kind: "set" }>
  ): void {
    for (const where of step.input) {
      const constraint = selectorConstraint(this.relation.target, where);
      this.relation.ledger.assertTargetRead(
        this.relation.relationName,
        "set",
        constraint
      );
      if (step.context.relationInfo.type !== "manyToMany") {
        this.relation.assertMembershipRead("set", constraint);
      }
    }
    this.relation.appendMembership(
      "set",
      unknownConstraint(this.relation.target)
    );
  }

  private processUpdate(
    step: Extract<RelationMutationStep, { kind: "update" }>
  ): void {
    if (step.context.relationInfo.isToOne) {
      const [input] = step.inputs;
      if (!input) return;
      const footprint = buildToOneUpdateFootprint(
        this.relation.ctx,
        { relationInfo: step.context.relationInfo },
        input.data,
        this.relation.family.kind === "update"
          ? this.relation.family.scalarData
          : undefined
      );
      this.relation.assertMembershipRead("update", footprint.readConstraint);
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

    for (const input of step.inputs) {
      if (!input.selector) continue;
      const selector = selectorConstraint(this.relation.target, input.selector);
      this.relation.assertTargetAndMembershipRead("update", selector);
      const resultConstraints = updateResultConstraints(
        this.relation.target,
        selector,
        input.data,
        input.selector
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
    step: Extract<RelationMutationStep, { kind: "deleteMany" }>
  ): void {
    const unknown = unknownConstraint(this.relation.target);
    if (step.context.relationInfo.type === "manyToMany") {
      for (const filter of step.inputs) {
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

function processOwnWriteBranchStep(
  relation: OwnWriteRelation,
  step: RelationMutationStep
): boolean {
  if (step.kind === "connectOrCreate") {
    processConnectOrCreateBranches(relation, step);
    return true;
  }
  if (step.kind === "upsert") {
    processUpsertBranches(relation, step);
    return true;
  }
  return false;
}

function processConnectOrCreateBranches(
  relation: OwnWriteRelation,
  step: Extract<RelationMutationStep, { kind: "connectOrCreate" }>
): void {
  for (const input of step.inputs) {
    const selector = relation.assertConnectOrCreateDecision(input.where);
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
  }
}

function processUpsertBranches(
  relation: OwnWriteRelation,
  step: Extract<RelationMutationStep, { kind: "upsert" }>
): void {
  for (const input of step.inputs) {
    const decision = relation.assertUpsertDecision(input.where);
    analyzeAlternativeBranches(relation, [
      (updateBranch) => {
        updateBranch.analyzeUpdate(input.update, input.where, "upsert");
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
  ctx: QueryScope,
  // The footprint reads the relation's METADATA only — the caller synthesizes this
  // from a step's context, not from a parsed payload, so it asks for exactly that.
  mutation: Pick<RelationMutation, "relationInfo">,
  updateData: Readonly<Record<string, unknown>>,
  rootScalarData: Readonly<Record<string, unknown>> | undefined
): ToOneUpdateFootprint {
  const target = mutation.relationInfo.targetModel;
  const direction = getFkDirection(ctx, mutation.relationInfo);
  const scalarData = getScalarData(target, updateData);
  const changedFields = new Set(Object.keys(scalarData));
  const readConstraint =
    direction.holdsFK && rootScalarData
      ? buildReboundTargetConstraint(target, direction, rootScalarData)
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
    direction.holdsFK ? direction.pkFields : direction.fkFields
  );
  if (direction.fkHolder === target && direction.referenced === target) {
    for (const field of [...direction.fkFields, ...direction.pkFields]) {
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

function buildReboundTargetConstraint(
  target: Model<any>,
  direction: ReturnType<typeof getFkDirection>,
  rootScalarData: Readonly<Record<string, unknown>>
): TargetConstraint {
  const values: Record<string, unknown> = {};
  for (const [index, fkField] of direction.fkFields.entries()) {
    const referencedField = direction.pkFields[index];
    if (!(referencedField && Object.hasOwn(rootScalarData, fkField))) continue;
    const update = classifyRelationKeyScalarUpdate(rootScalarData[fkField]);
    if (update.resolved && update.value !== null) {
      values[referencedField] = update.value;
    }
  }
  return normalizeTargetConstraint(target, direction.pkFields, values);
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
