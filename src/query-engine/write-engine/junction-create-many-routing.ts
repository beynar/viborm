import { getModelKeyCatalog, type Model } from "@schema/model";
import {
  buildParsedRelationPrograms,
  type RecordMutationData,
} from "../builders/relation-mutation-parser";
import { relationWriteKeys } from "../relation-key-legality";
import type { QueryScope } from "../types";

export type JunctionCreateManyRowRoute =
  | {
      readonly kind: "leaf";
      readonly row: RecordMutationData;
      readonly withSkip: boolean;
      readonly joinWhenTargetExists: boolean;
    }
  | {
      readonly kind: "adopt";
      readonly row: RecordMutationData;
      readonly where: Record<string, unknown>;
      readonly relationBearing: boolean;
    }
  | {
      readonly kind: "series";
      readonly row: RecordMutationData;
      readonly withSkip: boolean;
      readonly droppingFlagHelps: boolean;
    };

/** Whether an already-validated mutation row contains any relation write. */
export function recordMutationCarriesRelations(
  scope: QueryScope,
  record: RecordMutationData
): boolean {
  return (
    relationWriteKeys(
      buildParsedRelationPrograms(scope, record.parsed, record.source)
    ).length > 0
  );
}

/** Route one junction createMany row without losing its declared position. */
export function routeJunctionCreateManyRow(
  childScope: QueryScope,
  targetFields: readonly string[],
  row: RecordMutationData,
  skipDuplicates: boolean
): JunctionCreateManyRowRoute {
  return routeJunctionCreateManyParsedRow(
    childScope,
    targetFields,
    row,
    row.parsed,
    skipDuplicates
  );
}

function routeJunctionCreateManyParsedRow(
  childScope: QueryScope,
  targetFields: readonly string[],
  row: RecordMutationData,
  scalarRow: Record<string, unknown>,
  skipDuplicates: boolean
): JunctionCreateManyRowRoute {
  const relationBearing = recordMutationCarriesRelations(childScope, row);
  const disposition = skipDuplicates
    ? junctionSkipDuplicatesDisposition(childScope, targetFields, scalarRow)
    : { kind: "leaf" as const, joinWhenTargetExists: false };
  if (disposition.kind === "adopt") {
    return {
      kind: "adopt",
      row,
      where: disposition.where,
      relationBearing,
    };
  }
  if (relationBearing || disposition.kind === "suppress") {
    return {
      kind: "series",
      row,
      withSkip: skipDuplicates && disposition.kind !== "vacuous",
      // Removing suppression makes even a relation-bearing series executable on
      // ordered committed segments; the series itself is not the limitation.
      droppingFlagHelps: skipDuplicates,
    };
  }
  return {
    kind: "leaf",
    row,
    withSkip: skipDuplicates && disposition.kind === "leaf",
    joinWhenTargetExists:
      disposition.kind === "leaf" && disposition.joinWhenTargetExists,
  };
}

function junctionSkipDuplicatesDisposition(
  childScope: QueryScope,
  targetFields: readonly string[],
  row: Record<string, unknown>
):
  | { readonly kind: "leaf"; readonly joinWhenTargetExists: boolean }
  | { readonly kind: "vacuous" }
  | { readonly kind: "suppress" }
  | { readonly kind: "adopt"; readonly where: Record<string, unknown> } {
  if (!hasOmittedGeneratedRowKey(childScope, targetFields, row)) {
    const { probeable, indexOnly } = conflictableUniques(childScope.model);
    return {
      kind: "leaf",
      joinWhenTargetExists: probeable.length > 0 || indexOnly > 0,
    };
  }
  const { probeable, indexOnly } = conflictableUniques(childScope.model);
  if (probeable.length === 0 && indexOnly === 0) {
    return { kind: "vacuous" };
  }
  // A raw unique index has no whereUnique selector, and a partial index carries
  // opaque provider SQL. No row-local predicate evaluator can prove it inert.
  if (indexOnly > 0) return { kind: "suppress" };
  const spelled = probeable.filter((unique) =>
    unique.fields.every((field) => {
      const value = row[field];
      return value !== undefined && value !== null;
    })
  );
  const [only] = spelled;
  if (spelled.length !== 1 || !only) return { kind: "suppress" };
  return {
    kind: "adopt",
    where:
      only.fields.length === 1 && only.fields[0] === only.selector
        ? { [only.selector]: row[only.selector] }
        : {
            [only.selector]: Object.fromEntries(
              only.fields.map((field) => [field, row[field]])
            ),
          },
  };
}

function hasOmittedGeneratedRowKey(
  scope: QueryScope,
  targetFields: readonly string[],
  row: Record<string, unknown>
): boolean {
  return targetFields.some(
    (field) =>
      scope.model["~"].state.scalars[field]?.["~"].state.autoGenerate
        ?.kind === "increment" && row[field] === undefined
  );
}

/** Split declared non-PK uniques by whether whereUnique can name them. */
function conflictableUniques(model: Model<any>): {
  probeable: { selector: string; fields: readonly string[] }[];
  indexOnly: number;
} {
  const probeable: { selector: string; fields: readonly string[] }[] = [];
  const catalog = getModelKeyCatalog(model);
  const rowKeyFields = catalog.rowKey?.fields ?? [];
  const canConflictWithDifferentRow = (fields: readonly string[]): boolean =>
    !rowKeyFields.every((field) => fields.includes(field));
  const addressable = catalog.addressableKeys;
  for (const key of addressable) {
    if (key.kind === "primary" || !canConflictWithDifferentRow(key.fields)) {
      continue;
    }
    if (key.name === undefined) {
      const field = key.fields[0] as string;
      probeable.push({ selector: field, fields: [field] });
    } else if (key.kind === "compoundUnique") {
      probeable.push({ selector: key.name, fields: key.fields });
    }
  }
  const addressableSets = new Set(
    addressable.map((key) => canonicalFieldSet(key.fields))
  );
  const indexOnly = model["~"].state.indexes.filter(
    (index) =>
      index.options.unique === true &&
      canConflictWithDifferentRow(index.fields) &&
      !addressableSets.has(canonicalFieldSet(index.fields))
  ).length;
  return { probeable, indexOnly };
}

function canonicalFieldSet(fields: readonly string[]): string {
  return [...fields].sort().join("\u0000");
}
