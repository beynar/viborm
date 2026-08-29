import { MigrationError, VibORMErrorCode } from "../../../errors";
import {
  GEO_LATITUDE_MAX,
  GEO_LATITUDE_MIN,
  GEO_LONGITUDE_MAX,
  GEO_LONGITUDE_MIN,
} from "../../../validation/primitives/geo-point-codec";
import type { ColumnDef } from "../../types";
import {
  sqliteConstraintClauses,
  sqliteTableDefinitions,
} from "./column-constraints";

/** TEXT-affinity spelling reserved for VibORM's canonical GeoPoint carrier. */
export const SQLITE_GEO_POINT_TYPE = "VIBORM_GEO_TEXT";

/** Fixed so a native column rename cannot stale the constraint identity. */
const SQLITE_GEO_POINT_CONSTRAINT = "viborm_geo";

/** The complete writer-owned column constraint for one GeoPoint carrier. */
export function sqliteGeoPointCheck(
  column: Pick<ColumnDef, "name" | "nullable">,
  escapeIdentifier: (name: string) => string
): string {
  const col = escapeIdentifier(column.name);
  const longitude = `json_extract(${col}, '$.longitude')`;
  const latitude = `json_extract(${col}, '$.latitude')`;
  const valid =
    `CASE WHEN typeof(${col}) = 'text' AND json_valid(${col}) THEN (` +
    `json_type(${col}) = 'object' AND ` +
    `json_type(${col}, '$.longitude') IN ('integer', 'real') AND ` +
    `json_type(${col}, '$.latitude') IN ('integer', 'real') AND ` +
    `${longitude} > ${GEO_LONGITUDE_MIN} AND ${longitude} <= ${GEO_LONGITUDE_MAX} AND ` +
    `${latitude} >= ${GEO_LATITUDE_MIN} AND ${latitude} <= ${GEO_LATITUDE_MAX} AND ` +
    `${col} = json_object('longitude', ${longitude}, 'latitude', ${latitude})` +
    ") ELSE 0 END";
  const body = column.nullable ? `${col} IS NULL OR (${valid})` : valid;
  return `CONSTRAINT ${escapeIdentifier(SQLITE_GEO_POINT_CONSTRAINT)} CHECK (${body})`;
}

/**
 * Proves that SQLite's reserved declared type is paired with the exact
 * writer-owned constraint. A reserved type without its proof is refused rather
 * than published as a GeoPoint or silently normalized into one.
 */
export function readSqliteGeoPointColumn(
  tableSql: string | null | undefined,
  column: Pick<ColumnDef, "name" | "type" | "nullable">,
  escapeIdentifier: (name: string) => string
): boolean {
  if (column.type.toUpperCase() !== SQLITE_GEO_POINT_TYPE) return false;
  const expected = sqliteGeoPointCheck(column, escapeIdentifier);
  let matching = 0;
  for (const definition of sqliteTableDefinitions(tableSql ?? "")) {
    if (definition.columnName !== column.name) continue;
    for (const clause of sqliteConstraintClauses(definition.text)) {
      if (clause.name !== SQLITE_GEO_POINT_CONSTRAINT) continue;
      if (!definition.text.startsWith(expected, clause.offset)) {
        refuseUnprovenGeoPoint(column);
      }
      matching++;
    }
  }
  if (matching !== 1) refuseUnprovenGeoPoint(column);
  return true;
}

function refuseUnprovenGeoPoint(
  column: Pick<ColumnDef, "name" | "type">
): never {
  throw new MigrationError(
    `SQLite column "${column.name}" uses VibORM's reserved GeoPoint type "${column.type}" without the exact canonical GeoPoint CHECK constraint. ` +
      "Migration introspection is refused rather than treating an unproven JSON carrier as a GeoPoint.",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    {
      meta: {
        dialect: "sqlite",
        column: column.name,
        type: column.type,
      },
    }
  );
}
