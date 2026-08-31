/**
 * The decimal-list container is written by the RUNTIME and read by the
 * MIGRATION layer, and the two have to agree byte for byte.
 *
 * They are separate owners of one physical fact. The query engine writes the
 * container through the codec (`encodeDecimalListContainer`, spelled by the
 * adapter's array parameter); the migration layer validates it with a CHECK, a
 * marker or a typmod, and rewrites its members inside SQL when the descriptor
 * moves. Neither can see the other's spelling, so an agreement that holds only
 * by construction is one refactor away from a container that stores fine and
 * converts to the sentinel.
 *
 * Core coverage owns the deterministic MySQL marker agreement. Live SQLite
 * and PostgreSQL storage agreement lives in
 * `decimal-list-storage-agreement.test.ts`.
 *
 * Three claims, one per provider family:
 *
 *  - SQLite — a container written by the CLIENT satisfies the reserved CHECK,
 *    the conversion expression rewrites the very bytes the client wrote, and
 *    what the conversion writes back is byte-identical to what the client would
 *    have written for the new domain;
 *  - MySQL — the deterministic column-comment marker recovers exactly the
 *    descriptor the runtime encodes against, and only that marker does; and
 *  - PostgreSQL — the array typmod is the descriptor, so the runtime's members
 *    are the column's own values with no container in between.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { s } from "@schema";
import {
  mysqlDecimalListMarker,
  readMysqlDecimalListMarker,
} from "@src/migrations/decimal";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { ddlContext } from "@tests/unit/migrations/_estate";
import {
  encodeDecimalListContainer,
} from "@validation/primitives/decimal-codec";
import { describe, expect, it } from "vitest";

const TABLE = "dec_list_agreement";

const listLedger = (precision: number, scale: number) => ({
  ledger: s
    .model({
      id: s.string().id(),
      samples: s.decimal({ precision, scale }).array(),
    })
    .map(TABLE),
});

/** The logical members every leg below round-trips. */
const MEMBERS = ["1.2", "-0.03", "90071992547409.93"];

async function storedContainer(driver: {
  _executeRaw: <T>(sql: string) => Promise<{ rows: T[] }>;
}): Promise<unknown> {
  const rows = await driver._executeRaw<{ samples: unknown }>(
    `SELECT "samples" FROM "${TABLE}" WHERE "id" = 'a'`
  );
  return rows.rows[0]?.samples;
}

/**
 * The members the CONVERSION leg uses.
 *
 * Smaller than {@link MEMBERS} for a reason SQLite states itself: a scale
 * increase multiplies every coefficient, and `precision + scale <= 18` has to
 * hold on BOTH sides of the change, so a member whose coefficient already needs
 * sixteen digits has no wider domain to move into on this provider.
 */
const CONVERTIBLE = ["1.2", "-0.03"];

describe("MySQL: the marker recovers the descriptor the runtime encodes against", () => {
  it("emits the marker for a decimal list and only for one", () => {
    const ddl = mysqlMigrationDriver.generateDDL(
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "samples",
        from: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
        to: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: 16, scale: 2 },
        },
      },
      ddlContext("artifact")
    );

    expect(ddl).toContain(
      `COMMENT '${mysqlDecimalListMarker({ precision: 16, scale: 2 })}'`
    );
    expect(
      readMysqlDecimalListMarker(
        mysqlDecimalListMarker({ precision: 16, scale: 2 })
      )
    ).toEqual({ precision: 16, scale: 2 });
  });

  it("recovers a domain the runtime encodes the same container at", () => {
    // The whole point of the marker: introspection has nothing else to read a
    // JSON column's scale from, and the scale is what turns `"120"` into 1.2.
    const recovered = readMysqlDecimalListMarker(
      mysqlDecimalListMarker({ precision: 18, scale: 4 })
    );
    expect(recovered).toBeDefined();
    expect(encodeDecimalListContainer(MEMBERS, recovered?.scale ?? 0)).toBe(
      encodeDecimalListContainer(MEMBERS, 4)
    );
  });

  it("reads nothing from a comment that is not the exact marker", () => {
    const real = mysqlDecimalListMarker({ precision: 16, scale: 2 });
    for (const impostor of [
      "",
      "viborm",
      `${real} `,
      ` ${real}`,
      real.replace("16", "17").slice(0, -1),
      real.toUpperCase(),
    ]) {
      expect(readMysqlDecimalListMarker(impostor)).toBeUndefined();
    }
  });

  it("declares the coefficient vocabulary its marker implies", () => {
    // A JSON column cannot hold an exact decimal, so the runtime spells the
    // members as coefficients — and the marker is what says at which scale.
    expect(new MySQLAdapter().result.decimalListRepresentation).toBe(
      "coefficient"
    );
  });
});
