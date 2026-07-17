// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child RelationUpserts.
import { getTableName } from "./context";
import {
  assertCreateOwnWriteSafety,
  assertUpdateOwnWriteSafety,
} from "./OwnWriteAnalyzer";
import {
  createOperationProgram,
  createReadStep,
  type GuardStep,
  type OperationProgram,
  type OperationStatement,
  type OperationStep,
  operationSelection,
  type ProgramFailure,
} from "./operation-program";
import type { CapturedRow } from "./RelationCaptures";
import type { RelationMutations } from "./RelationMutations";
import {
  primaryKeyFilter,
  primaryKeyWhere,
  relationStatement,
  requireRecord,
} from "./RelationProgramValues";
import type { QueryScope } from "./types";
import { NestedWriteError } from "./types";
import { uniqueConflictTarget } from "./WritePrograms";

/** Compiles root upsert selection, pinned branches, and terminal deep reads. */
export class RelationUpserts<T> {
  private readonly relations: RelationMutations<T>;

  constructor(relations: RelationMutations<T>) {
    this.relations = relations;
  }

  compile(ctx: QueryScope, args: Record<string, unknown>): OperationProgram {
    const steps: OperationStep[] = [];
    const updates = this.relations.updates;
    return updates.withSteps(steps, () => {
      const where = requireRecord(args.where, "upsert", "where");
      const create = requireRecord(args.create, "upsert", "create");
      const update = requireRecord(args.update, "upsert", "update");
      const decision = updates.branches.decision(
        ctx,
        relationStatement(ctx, "findMany", {
          whereUnique: where,
          take: 1,
          lock: "transaction",
        })
      );
      const resultId = updates.stepId("read");
      const whenTrue = this.compileBranch(ctx, () => {
        assertUpdateOwnWriteSafety(ctx, update, where);
        this.compileExisting(ctx, args, update, decision, resultId);
      });
      let createStep = "";
      const whenFalse = this.compileBranch(ctx, () => {
        assertCreateOwnWriteSafety(ctx, create);
        const outcome = this.relations.appendUpsertCreateOutcome(
          ctx,
          create,
          {},
          updates.steps
        );
        createStep = outcome.write.id;
        updates.steps.push(
          createReadStep(
            resultId,
            relationStatement(ctx, "findUnique", {
              where: primaryKeyWhere(ctx, outcome.identity),
              ...operationSelection(args),
            }),
            { expectedRows: { kind: "exact", count: 1 } }
          )
        );
      });
      steps.push({
        id: updates.stepId("branch"),
        kind: "branch",
        premise: { step: decision.step.id, test: "hasRows" },
        pin: {
          whenTrue: {
            id: updates.stepId("guard"),
            kind: "guard",
            premise: {
              kind: "exists",
              statement: relationStatement(ctx, "findMany", {
                whereUnique: where,
                filter: primaryKeyFilter(ctx, decision.identity),
                take: 1,
                lock: "transaction",
              }),
            },
            failure: replacementFailure(ctx),
          },
          whenFalse: {
            ...(createStep
              ? {
                  kind: "uniqueConflict" as const,
                  step: createStep,
                  where,
                  create,
                  target: uniqueConflictTarget(ctx, where),
                }
              : { kind: "none" as const }),
          },
        },
        whenTrue,
        whenFalse,
      });
      return createOperationProgram(
        "operation",
        steps,
        "upsert",
        args,
        {
          kind: "rows",
          results: [{ step: resultId, result: `${resultId}:result` }],
        },
        this.relations.writes.resultShape("upsert", args),
        !ctx.adapter.capabilities.supportsReturning
      );
    });
  }

  private compileExisting(
    ctx: QueryScope,
    args: Record<string, unknown>,
    update: Record<string, unknown>,
    decision: CapturedRow,
    resultId: string
  ): void {
    const filters = [args.targetWhere, args.setWhere].filter(hasKeys);
    const [firstFilter] = filters;
    if (!firstFilter) {
      this.compileUpdate(ctx, args, update, decision, resultId);
      return;
    }
    const filter = filters.length === 1 ? firstFilter : { AND: filters };
    const updates = this.relations.updates;
    const probe = createReadStep(
      updates.stepId("read"),
      relationStatement(ctx, "findMany", {
        whereUnique: primaryKeyWhere(ctx, decision.identity),
        filter,
        take: 1,
      })
    );
    updates.steps.push(probe);
    const failure: ProgramFailure = {
      kind: "nestedWrite",
      message: `Upsert precondition failed for model '${getTableName(ctx.model)}'.`,
      relation: getTableName(ctx.model),
      raceable: false,
    };
    const predicate = relationStatement(ctx, "findMany", {
      whereUnique: primaryKeyWhere(ctx, decision.identity),
      filter,
      take: 1,
      lock: "transaction",
    });
    const whenTrue = updates.collectSteps(() => {
      this.compileUpdate(ctx, args, update, decision, resultId);
    });
    const whenFalse = updates.collectSteps(() => {
      updates.steps.push(
        createReadStep(
          resultId,
          relationStatement(ctx, "findUnique", {
            where: primaryKeyWhere(ctx, decision.identity),
            ...operationSelection(args),
          }),
          { expectedRows: { kind: "exact", count: 1 } }
        )
      );
    });
    updates.steps.push({
      id: updates.stepId("branch"),
      kind: "branch",
      premise: { step: probe.id, test: "hasRows" },
      pin: {
        whenTrue: branchGuard(
          updates.stepId("guard"),
          "exists",
          predicate,
          failure
        ),
        whenFalse: branchGuard(
          updates.stepId("guard"),
          "notExists",
          predicate,
          failure
        ),
      },
      whenTrue,
      whenFalse,
    });
  }

  private compileBranch(
    ctx: QueryScope,
    compile: () => void
  ): readonly OperationStep[] {
    const updates = this.relations.updates;
    return updates.collectSteps(() => {
      try {
        compile();
      } catch (error) {
        if (!(error instanceof NestedWriteError)) throw error;
        const relation = error.meta.relation;
        updates.steps.length = 0;
        updates.steps.push({
          id: updates.stepId("failure"),
          kind: "failure",
          failure: {
            kind: "nestedWrite",
            message: error.message,
            relation:
              typeof relation === "string" ? relation : getTableName(ctx.model),
            raceable: false,
          },
        });
      }
    });
  }

  private compileUpdate(
    ctx: QueryScope,
    args: Record<string, unknown>,
    update: Record<string, unknown>,
    decision: CapturedRow,
    resultId: string
  ): void {
    const updates = this.relations.updates;
    const finalRow = updates.compileLocatedUpdate(ctx, decision, update);
    updates.steps.push(
      createReadStep(
        resultId,
        relationStatement(ctx, "findUnique", {
          where: primaryKeyWhere(ctx, finalRow.identity),
          ...operationSelection(args),
        }),
        { expectedRows: { kind: "exact", count: 1 } }
      )
    );
  }
}

function replacementFailure(ctx: QueryScope): ProgramFailure {
  return {
    kind: "nestedWrite",
    message: "Record was replaced by another transaction during upsert",
    relation: getTableName(ctx.model),
    raceable: false,
  };
}

function hasKeys(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function branchGuard(
  id: string,
  kind: "exists" | "notExists",
  statement: OperationStatement,
  failure: ProgramFailure
): GuardStep {
  return { id, kind: "guard", premise: { kind, statement }, failure };
}
