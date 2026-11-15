/**
 * `viborm/schema/introspect` — a schema document from an existing database.
 *
 * ```ts
 * import { introspectSchema } from "viborm/schema/introspect";
 * import { parseSchema } from "viborm/schema/json";
 *
 * const { document, skipped, warnings } = await introspectSchema({ url });
 * const db = createClient({ schema: parseSchema(document), databaseUrl: url });
 * ```
 *
 * The document is the canonical form of `viborm/schema/json`: there is no
 * second format, and a TypeScript schema generator can be written from it
 * later without reading the database again. What the document does not carry
 * is listed in `skipped`, what it states with less certainty than the database
 * proves is an `approximated` warning, what a table carries that the document
 * has no spelling for (a collation, `STRICT`, a trigger: the dialect's
 * `adoptionHazards`) is an `unstated` warning, and every place where a `push`
 * of it would change the database is a `drift` warning, found by running
 * push's own serializer and differ against the snapshot the database was read
 * into. `light: true` writes only what a client reads (`lighten`).
 *
 * This entry is tooling: it registers every migration driver and imports the
 * driver a URL names on demand. An application never imports it, so the
 * application bundle carries none of it.
 */

import type { AnyDriver } from "../../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { parseSchema, serializeSchema } from "../../schema/json";
import type { SchemaDocument } from "../../schema/json/document";
import { registerEveryMigrationDriver } from "../dialects/every";
import type { SchemaSnapshot } from "../types";
import { openDriver } from "./connect";
import { readCatalog } from "./read";
import { translateSnapshot } from "./translate";
import type {
  IntrospectionDialect,
  IntrospectionWarning,
  IntrospectSchemaResult,
  SkippedObject,
} from "./types";
import { verifyDocument } from "./verify";

registerEveryMigrationDriver();

export type {
  IntrospectionDialect,
  IntrospectionWarning,
  IntrospectSchemaResult,
  SkippedKind,
  SkippedObject,
} from "./types";

interface IntrospectScope {
  /** Only these tables (exact physical names). */
  readonly tables?: readonly string[];
  /**
   * A light document: only what a client reads (models, fields with their
   * type, nullability, list-ness, keys, uniques, defaults and generators,
   * native types, relations, names), without the indexes only migrations
   * read. It is marked `"light": true`, and every migration path refuses it.
   * `skipped` and `warnings` then keep only what changes what a client sees:
   * no index or CHECK constraint, no `unstated` or `drift` warning.
   */
  readonly light?: boolean;
}

export type IntrospectSchemaOptions =
  | (IntrospectScope & {
      /**
       * The database: `postgres://` / `postgresql://`, `mysql://`, `file:` / `sqlite:` or a
       * `.db` / `.sqlite` path (opened read-only), or `libsql://`. The
       * connection is opened for this call and always closed.
       */
      readonly url: string;
      readonly driver?: never;
    })
  | (IntrospectScope & {
      /**
       * A driver you constructed (a D1 binding, a custom pool, a PostgreSQL
       * `namespace`). It is yours: it is not closed.
       */
      readonly driver: AnyDriver;
      readonly url?: never;
    });

const DIALECTS: readonly IntrospectionDialect[] = [
  "postgresql",
  "sqlite",
  "mysql",
  "snowflake",
];

/**
 * Snowflake is read, never pushed to: a drift against it has no push to
 * describe, and what the document cannot promise is that its keys hold.
 */
const SNOWFLAKE_KEYS: IntrospectionWarning = {
  kind: "approximated",
  message:
    "Snowflake enforces no primary, unique or foreign key: the document's keys, uniques and relations are the ones the catalog declares, and a row may break them",
};

function isIntrospectionDialect(
  dialect: string
): dialect is IntrospectionDialect {
  return DIALECTS.some((item) => item === dialect);
}

/** The live tables the document declares, and the enums their columns use. */
function declaredSnapshot(
  snapshot: SchemaSnapshot,
  tables: ReadonlySet<string>
): SchemaSnapshot {
  const kept = snapshot.tables.filter((table) => tables.has(table.name));
  const used = new Set(
    kept.flatMap((table) =>
      table.columns.map((column) =>
        column.type.endsWith("[]") ? column.type.slice(0, -2) : column.type
      )
    )
  );
  const enums = snapshot.enums?.filter((item) => used.has(item.name));
  return {
    tables: kept,
    ...(enums && enums.length > 0 ? { enums } : {}),
  };
}

/**
 * The light form of a canonical document: every index left out, and the
 * report narrowed to what a client sees. An `approximated` warning naming an
 * index (a unique constraint written as a unique index) goes with it.
 */
function lighten(result: IntrospectSchemaResult): IntrospectSchemaResult {
  const dropped = new Set<string>();
  const models: SchemaDocument["models"] = {};
  for (const [key, { indexes, ...model }] of Object.entries(
    result.document.models
  )) {
    for (const index of indexes ?? [])
      dropped.add(`${model.table ?? key}\0${index.name}`);
    models[key] = model;
  }
  return {
    ...result,
    document: serializeSchema(
      parseSchema({ ...result.document, light: true, models })
    ),
    skipped: result.skipped.filter(
      (item) => item.kind !== "index" && item.kind !== "check"
    ),
    warnings: result.warnings.filter(
      (warning) =>
        warning.kind === "approximated" &&
        !dropped.has(`${warning.table}\0${warning.name}`)
    ),
  };
}

async function introspectDriver(
  driver: AnyDriver,
  tables: readonly string[] | undefined
): Promise<IntrospectSchemaResult> {
  const introspectionDialect = driver.dialect;
  if (!isIntrospectionDialect(introspectionDialect))
    throw new MigrationError(
      `introspectSchema does not translate ${introspectionDialect} yet; PostgreSQL, SQLite, MySQL and Snowflake are supported.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { dialect: introspectionDialect, feature: "introspect-schema" } }
    );
  const catalog = await readCatalog(driver, introspectionDialect, tables);

  // A pure join table is first written as the generated junction of its pair;
  // where that junction is not exactly this table, it becomes a junction model
  // and the document is translated again.
  const junctionModels = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const translation = translateSnapshot({
      snapshot: catalog.snapshot,
      dialect: introspectionDialect,
      migrationDriver: catalog.migrationDriver,
      identityColumns: catalog.identityColumns,
      junctionModels,
    });
    const verification =
      introspectionDialect === "snowflake"
        ? { warnings: [SNOWFLAKE_KEYS], drifted: new Set<string>() }
        : await verifyDocument(
            translation.document,
            declaredSnapshot(catalog.snapshot, translation.tables),
            catalog.migrationDriver
          );
    const demote = [...translation.generatedJunctions].filter((table) =>
      verification.drifted.has(table)
    );
    if (demote.length > 0 && attempt === 0) {
      for (const table of demote) junctionModels.add(table);
      continue;
    }
    const document: SchemaDocument = serializeSchema(
      parseSchema(translation.document)
    );
    const skipped: SkippedObject[] = [
      ...catalog.skipped,
      ...translation.skipped,
    ];
    const warnings: IntrospectionWarning[] = [
      ...translation.warnings,
      // Each CHECK constraint is already in `skipped`, with its definition.
      ...catalog.hazards
        .filter(
          ({ table, feature }) =>
            translation.tables.has(table) && !feature.startsWith("CHECK")
        )
        .map(({ table, feature }) => ({
          kind: "unstated" as const,
          table,
          message: `the document cannot carry ${feature}: the database keeps it and a push of the document plans nothing for it, but a push that recreates the table or the column cannot keep it`,
        })),
      ...verification.warnings,
    ];
    return { document, skipped, warnings, dialect: introspectionDialect };
  }
}

/**
 * Read an existing database into a schema document.
 *
 * Never invents: a fact the catalog does not prove is not in the document, and
 * what is lost or approximated is said in `skipped` and `warnings`.
 */
export async function introspectSchema(
  options: IntrospectSchemaOptions
): Promise<IntrospectSchemaResult> {
  const read = async (driver: AnyDriver) => {
    const result = await introspectDriver(driver, options.tables);
    return options.light ? lighten(result) : result;
  };
  if (options.driver !== undefined) return await read(options.driver);
  const { driver } = await openDriver(options.url);
  try {
    return await read(driver);
  } finally {
    await driver.disconnect();
  }
}
