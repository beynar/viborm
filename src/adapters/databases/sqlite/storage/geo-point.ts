import { MigrationError, VibORMErrorCode } from "../../../../errors";
import {
  GEO_LATITUDE_MAX,
  GEO_LATITUDE_MIN,
  GEO_LONGITUDE_MAX,
  GEO_LONGITUDE_MIN,
} from "../../../../validation/primitives/geo-values";
import { sqliteBinary64JsonNumber } from "./json-number";

interface PhysicalColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

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
  column: Pick<PhysicalColumn, "name" | "nullable">,
  escapeIdentifier: (name: string) => string,
  encoding: "legacy" | "binary64" = "binary64"
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
    `${col} = ${sqliteGeoPointCarrier(col, encoding)}` +
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
  column: Pick<PhysicalColumn, "name" | "type" | "nullable">,
  escapeIdentifier: (name: string) => string
): "legacy" | "binary64" | undefined {
  if (column.type.toUpperCase() !== SQLITE_GEO_POINT_TYPE) return undefined;
  const expected = sqliteGeoPointCheck(column, escapeIdentifier);
  const legacy = sqliteGeoPointCheck(column, escapeIdentifier, "legacy");
  let encoding: "legacy" | "binary64" = "binary64";
  let matching = 0;
  for (const definition of sqliteTableDefinitions(tableSql ?? "")) {
    if (definition.columnName !== column.name) continue;
    for (const clause of sqliteConstraintClauses(definition.text)) {
      if (clause.name !== SQLITE_GEO_POINT_CONSTRAINT) continue;
      if (definition.text.startsWith(expected, clause.offset))
        encoding = "binary64";
      else if (definition.text.startsWith(legacy, clause.offset))
        encoding = "legacy";
      else refuseUnprovenGeoPoint(column);
      matching++;
    }
  }
  if (matching !== 1) refuseUnprovenGeoPoint(column);
  return encoding;
}

function refuseUnprovenGeoPoint(
  column: Pick<PhysicalColumn, "name" | "type">
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

/** Copying legacy storage preserves the double still present, not earlier lost digits. */
export function sqliteGeoPointCarrier(
  source: string,
  encoding: "legacy" | "binary64" = "binary64"
): string {
  const longitude = `json_extract(${source}, '$.longitude')`;
  const latitude = `json_extract(${source}, '$.latitude')`;
  return `json_object('longitude', ${encoding === "legacy" ? longitude : sqliteBinary64JsonNumber(longitude)}, 'latitude', ${encoding === "legacy" ? latitude : sqliteBinary64JsonNumber(latitude)})`;
}

/** Format-1 snapshots predating the precision annotation describe the legacy CHECK. */
export function sqliteGeoPointEncoding(column: {
  readonly type: string;
  readonly geoPointEncoding?: "legacy" | "binary64" | undefined;
}): "legacy" | "binary64" | undefined {
  return column.type.toUpperCase() === SQLITE_GEO_POINT_TYPE
    ? (column.geoPointEncoding ?? "legacy")
    : undefined;
}
