import { NestedWriteError, QueryEngineError } from "@errors";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import { resolvePolymorphicMutationIntent } from "../builders/polymorphic-mutation";
import { partitionModelData } from "../builders/relation-mutation-parser";
import { buildWhereUnique } from "../builders/where-unique-builder";
import { createQueryScope } from "../context/query-scope";
import { buildFind } from "../operations";
import type { QueryEngine } from "../query-engine";
import {
  classifyTargetConstraintOverlap,
  exactTargetConstraintKey,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
  type TargetConstraint,
} from "../TargetConstraint";
import {
  isPolymorphicToOneRelationInfo,
  type QueryScope,
  type ResolvedPolymorphicEdge,
} from "../types";
import { nestedWriteFailure, presenceGuard } from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import type { GuardStep, ReadStep } from "./OperationFragment";
import { planningKey } from "./Part";
import type { StepScope } from "./StepScope";
import { capturedSelectorWhere, getStepModelName, isRecord } from "./shared";

interface BulkTarget {
  readonly rowIndex: number;
  readonly edge: ResolvedPolymorphicEdge;
  readonly where: Record<string, unknown>;
  readonly constraint: TargetConstraint;
  readonly constraintKey: string | undefined;
  readonly guardId: string;
}

interface BulkProbe {
  readonly targets: readonly BulkTarget[];
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
  const polymorphicNames = [...parent.polymorphicRelations.keys()];
  if (polymorphicNames.length === 0) {
    return emptyBulkPolymorphicConnects(rows);
  }
  const scalarRows: Record<string, unknown>[] = [];
  const groupedTargets = new Map<string, BulkTarget[]>();

  for (const [rowIndex, row] of rows.entries()) {
    if (!polymorphicNames.some((name) => Object.hasOwn(row, name))) {
      scalarRows.push(row);
      continue;
    }
    const parsed = partitionModelData(parent, row);
    scalarRows.push(parsed.scalarData);
    for (const { relation, payload } of Object.values(
      parsed.polymorphicPayloads
    )) {
      // THE NARROWING, and since Package E the SOLE closer of the silent-drop
      // hazard (plan §9.6 states the prohibition normatively: "Do not extend the
      // current direct-`toOne` connect-only grouped shortcut to junction work").
      // Package D widened the partition to carry both storage arms, and this
      // shortcut is the one consumer that cannot follow: it stores PRIVATE OWNER
      // COLUMNS on the bulk row, which a collection has no analogue of. Without
      // the narrowing a collection payload would reach the to-one-only intent
      // resolver and be read as a row-held connect.
      //
      // The ROW-context grammar no longer refuses a collection key — E mounts the
      // full collection `create` family there — and `routing.ts` sends any such
      // row to the record series before this file is reached. So on the CLIENT
      // path this is unreachable; it stays because a directly-built scope can
      // reach `buildBulkPolymorphicConnects` without passing routing, and a
      // narrowing that only holds "when the caller came the usual way" is not a
      // narrowing.
      if (!isPolymorphicToOneRelationInfo(relation)) {
        throw new QueryEngineError(
          `createMany polymorphic relation '${relation.name}' is a collection; its membership lives in per-variant member junction tables and cannot be written from a bulk row.`
        );
      }
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
      const constraint = normalizeWhereUniqueTargetConstraint(
        intent.edge.targetModel,
        intent.payload
      );
      const target: BulkTarget = {
        rowIndex,
        edge: intent.edge,
        where: intent.payload,
        constraint,
        constraintKey: exactTargetConstraintKey(constraint),
        guardId: scope.allocate(`${targetName}.guard.exists`),
      };
      const key = `${relation.name}\u0000${intent.edge.publicType}`;
      const group = groupedTargets.get(key);
      if (group) group.push(target);
      else groupedTargets.set(key, [target]);
    }
  }

  if (groupedTargets.size === 0) {
    return emptyBulkPolymorphicConnects(scalarRows);
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
    const uniqueTargets = uniqueBulkTargets(targets);
    const id = scope.allocate(
      `${getStepModelName(edge.targetModel, edge.relationInfo.name)}.find`
    );
    return {
      targets,
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
        const rowIndexes = new Map<
          string,
          ReadonlyMap<string, Record<string, unknown>>
        >();
        for (const target of probe.targets) {
          const found = findBulkTarget(rows, target, rowIndexes);
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
            const guardScope = createQueryScope(
              engine.adapter,
              target.edge.targetModel
            );
            guards.push(
              presenceGuard(
                target.guardId,
                buildFind(
                  guardScope,
                  {
                    where: capturedSelectorWhere(guardScope, target.where, {
                      [target.edge.referencedField]:
                        found[target.edge.referencedField],
                    }),
                    select: { [target.edge.referencedField]: true },
                  },
                  { limit: 1 }
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

function emptyBulkPolymorphicConnects(
  rows: readonly Record<string, unknown>[]
): PreparedBulkPolymorphicConnects {
  return {
    scalarRows: rows,
    probes: [],
    resolve: () => ({
      storageByRow: rows.map(() => []),
      guards: [],
    }),
  };
}

function uniqueBulkTargets(targets: readonly BulkTarget[]): BulkTarget[] {
  const unique: BulkTarget[] = [];
  const exact = new Set<string>();
  for (const target of targets) {
    if (target.constraintKey) {
      if (exact.has(target.constraintKey)) continue;
      exact.add(target.constraintKey);
    } else if (
      unique.some(
        (candidate) =>
          classifyTargetConstraintOverlap(
            target.constraint,
            candidate.constraint
          ) === "equal"
      )
    ) {
      continue;
    }
    unique.push(target);
  }
  return unique;
}

function findBulkTarget(
  rows: readonly unknown[],
  target: BulkTarget,
  indexes: Map<string, ReadonlyMap<string, Record<string, unknown>>>
): Record<string, unknown> | undefined {
  const fields = [...target.constraint.fields.keys()];
  if (target.constraintKey) {
    const fieldKey = fields.join("\u0000");
    let index = indexes.get(fieldKey);
    if (!index) {
      const built = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const key = exactTargetConstraintKey(
          normalizeTargetConstraint(target.edge.targetModel, fields, row)
        );
        if (key) built.set(key, row);
      }
      index = built;
      indexes.set(fieldKey, index);
    }
    return index.get(target.constraintKey);
  }
  return rows.find(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      classifyTargetConstraintOverlap(
        target.constraint,
        normalizeTargetConstraint(target.edge.targetModel, fields, row)
      ) === "equal"
  );
}
