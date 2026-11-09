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
 * proves is an `approximated` warning, and every place where a `push` of it
 * would change the database is a `drift` warning, found by running push's own
 * serializer and differ against the snapshot the database was read into.
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

export type IntrospectSchemaOptions =
  | {
      /**
       * The database: `postgres://` / `postgresql://`, `mysql://`, `file:` / `sqlite:` or a
       * `.db` / `.sqlite` path (opened read-only), or `libsql://`. The
       * connection is opened for this call and always closed.
       */
      readonly url: string;
      readonly driver?: never;
      /** Only these tables (exact physical names). */
      readonly tables?: readonly string[];
    }
  | {
      /**
       * A driver you constructed (a D1 binding, a custom pool, a PostgreSQL
       * `namespace`). It is yours: it is not closed.
       */
      readonly driver: AnyDriver;
      readonly url?: never;
      readonly tables?: readonly string[];
    };

const DIALECTS = new Set<string>(["postgresql", "sqlite", "mysql"]);

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

async function introspectDriver(
  driver: AnyDriver,
  tables: readonly string[] | undefined
): Promise<IntrospectSchemaResult> {
  const dialect = driver.dialect;
  if (!DIALECTS.has(dialect))
    throw new MigrationError(
      `introspectSchema does not translate ${dialect} yet; PostgreSQL, SQLite and MySQL are supported.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { dialect, feature: "introspect-schema" } }
    );
  const introspectionDialect = dialect as IntrospectionDialect;
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
    const verification = await verifyDocument(
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
  if (options.driver !== undefined)
    return await introspectDriver(options.driver, options.tables);
  const { driver } = await openDriver(options.url);
  try {
    return await introspectDriver(driver, options.tables);
  } finally {
    await driver.disconnect();
  }
}
