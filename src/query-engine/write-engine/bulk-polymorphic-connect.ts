import { NestedWriteError, QueryEngineError } from "@errors";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import { resolvePolymorphicMutationIntent } from "../builders/polymorphic-mutation";
import { partitionModelData } from "../builders/relation-mutation-parser";
import { buildWhereUnique } from "../builders/where-unique-builder";
import { createQueryScope } from "../context/query-scope";
import { buildFind, buildFindUnique } from "../operations";
import type { QueryEngine } from "../query-engine";
import {
  classifyTargetConstraintOverlap,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
  type TargetConstraint,
} from "../TargetConstraint";
import type { QueryScope, ResolvedPolymorphicEdge } from "../types";
import { nestedWriteFailure, presenceGuard } from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import type { GuardStep, ReadStep } from "./OperationFragment";
import { planningKey } from "./Part";
import type { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";

interface BulkTarget {
  readonly rowIndex: number;
  readonly edge: ResolvedPolymorphicEdge;
  readonly where: Record<string, unknown>;
  readonly constraint: TargetConstraint;
  readonly guardId: string;
}

interface BulkProbe {
  readonly edge: ResolvedPolymorphicEdge;
  readonly targets: readonly BulkTarget[];
  readonly fields: readonly string[];
  readonly step: ReadStep;
}

export interface PreparedBulkPolymorphicConnects {
  readonly scalarRows: readonly Record<string, unknown>[];
  readonly probes: readonly ReadStep[];
  resolve(known: Readonly<Record<string, unknown>>): {
    readonly storageByRow: readonly (readonly PolymorphicStorageValue<unknown>[])[];
    readonly guards: readonly GuardStep[];
  };
}

/** Owns the one bulk-only relation shape: per-row connect payloads become
 * grouped target probes and private `(type, identity)` insert values. */
export function prepareBulkPolymorphicConnects(
  engine: QueryEngine,
  parent: QueryScope,
  rows: readonly Record<string, unknown>[],
  scope: StepScope,
  txMode: boolean
): PreparedBulkPolymorphicConnects {
  const scalarRows: Record<string, unknown>[] = [];
  const groupedTargets = new Map<string, BulkTarget[]>();

  for (const [rowIndex, row] of rows.entries()) {
    const parsed = partitionModelData(parent, row);
    scalarRows.push(parsed.scalarData);
    for (const { relation, payload } of Object.values(
      parsed.polymorphicPayloads
    )) {
      const intent = resolvePolymorphicMutationIntent(
        parent,
        relation,
        payload
      );
      if (!(intent.kind === "targeted" && intent.operation === "connect")) {
        throw new QueryEngineError(
          `createMany polymorphic relation '${relation.name}' requires connect.`
        );
      }
      if (!isRecord(intent.payload)) {
        throw new QueryEngineError(
          `createMany polymorphic relation '${relation.name}' produced an invalid selector.`
        );
      }
      const targetName = getStepModelName(
        intent.edge.targetModel,
        relation.name
      );
      const target: BulkTarget = {
        rowIndex,
        edge: intent.edge,
        where: intent.payload,
        constraint: normalizeWhereUniqueTargetConstraint(
          intent.edge.targetModel,
          intent.payload
        ),
        guardId: scope.allocate(`${targetName}.guard.exists`),
      };
      const key = `${relation.name}\u0000${intent.edge.publicType}`;
      const group = groupedTargets.get(key);
      if (group) group.push(target);
      else groupedTargets.set(key, [target]);
    }
  }

  const probes: BulkProbe[] = [...groupedTargets.values()].map((targets) => {
    const edge = targets[0]!.edge;
    const childScope = createQueryScope(engine.adapter, edge.targetModel);
    const fields = [
      ...new Set([
        edge.referencedField,
        ...targets.flatMap((target) => [...target.constraint.fields.keys()]),
      ]),
    ];
    const uniqueTargets = targets.filter(
      (target, index) =>
        targets.findIndex(
          (candidate) =>
            classifyTargetConstraintOverlap(
              target.constraint,
              candidate.constraint
            ) === "equal"
        ) === index
    );
    const id = scope.allocate(
      `${getStepModelName(edge.targetModel, edge.relationInfo.name)}.find`
    );
    return {
      edge,
      targets,
      fields,
      step: {
        id,
        kind: "read",
        statement: buildFind(
          childScope,
          {
            select: Object.fromEntries(fields.map((field) => [field, true])),
            forUpdate: txMode,
          },
          {
            predicate: engine.adapter.operators.or(
              ...uniqueTargets.map((target) =>
                buildWhereUnique(childScope, target.where, childScope.rootAlias)
              )
            ),
          }
        ),
        outputs: { rows: { kind: "rows" } },
      },
    };
  });

  return {
    scalarRows,
    probes: probes.map((probe) => probe.step),
    resolve(known) {
      const storageByRow: PolymorphicStorageValue<unknown>[][] = scalarRows.map(
        () => []
      );
      const guards: GuardStep[] = [];
      for (const probe of probes) {
        const rows = known[planningKey(probe.step.id, "rows")];
        if (!Array.isArray(rows)) {
          throw new QueryEngineError(
            `createMany polymorphic probe '${probe.step.id}' did not expose rows.`
          );
        }
        for (const target of probe.targets) {
          const found = rows.find(
            (row): row is Record<string, unknown> =>
              isRecord(row) &&
              classifyTargetConstraintOverlap(
                target.constraint,
                normalizeTargetConstraint(
                  target.edge.targetModel,
                  [...target.constraint.fields.keys()],
                  row
                )
              ) === "equal"
          );
          if (!found) {
            throw new NestedWriteError(
              relationTargetNotFound(target.edge.relationInfo, "connect"),
              target.edge.relationInfo.name
            );
          }
          storageByRow[target.rowIndex]!.push({
            kind: "linked",
            storage: target.edge.storage,
            storedType: target.edge.storedType,
            referencedField: target.edge.referencedField,
            id: found[target.edge.referencedField],
          });
          if (!txMode) {
            guards.push(
              presenceGuard(
                target.guardId,
                buildFindUnique(
                  createQueryScope(engine.adapter, target.edge.targetModel),
                  {
                    where: target.where,
                    select: { [target.edge.referencedField]: true },
                  }
                ),
                nestedWriteFailure(
                  relationTargetNotFound(target.edge.relationInfo, "connect"),
                  target.edge.relationInfo.name,
                  false
                )
              )
            );
          }
        }
      }
      return { storageByRow, guards };
    },
  };
}
