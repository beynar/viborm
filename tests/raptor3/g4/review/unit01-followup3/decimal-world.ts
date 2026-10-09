import { sqliteDecimalCheck } from "@adapters/databases/sqlite/storage/decimal";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { createIdentifierQuoter } from "@src/sql/identifiers";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import Database from "better-sqlite3";

/**
 * Third-review world for the decimal field-reference domain refusal (r5
 * finding J). Same public arguments asked of the SHIPPED client and of the
 * candidate over identical data, so any difference is observable.
 *
 * The domains are chosen to separate the two halves of the rule: `micros`
 * differs from `cents` in SCALE only, `wideCents` in PRECISION only.
 */
export const led = s
  .model({
    id: s.int().id(),
    cents: s.decimal({ precision: 12, scale: 2 }),
    alsoCents: s.decimal({ precision: 12, scale: 2 }).map("also_cents"),
    micros: s.decimal({ precision: 12, scale: 4 }),
    wideCents: s.decimal({ precision: 10, scale: 2 }).map("wide_cents"),
    maybeCents: s
      .decimal({ precision: 12, scale: 2 })
      .nullable()
      .map("maybe_cents"),
    count: s.int(),
    tag: s.string(),
    lines: s.toMany(() => line).name("ledLines"),
  })
  .map("fu3_led");

export const line = s
  .model({
    id: s.int().id(),
    ledId: s.int().nullable().map("led_id"),
    fee: s.decimal({ precision: 8, scale: 2 }),
    feeMicros: s.decimal({ precision: 8, scale: 3 }).map("fee_micros"),
    led: s
      .toOne(() => led)
      .fields("ledId")
      .references("id")
      .name("ledLines"),
  })
  .map("fu3_line");

export const schema = { led, line };

export const ledRefs = createModelFieldRefs("led", led) as Record<
  string,
  unknown
>;
export const lineRefs = createModelFieldRefs("line", line) as Record<
  string,
  unknown
>;

const SEED = `
  CREATE TABLE fu3_led(
    id INTEGER PRIMARY KEY,
    cents INTEGER NOT NULL ${sqliteDecimalCheck({ name: "cents", nullable: false }, { precision: 12, scale: 2 }, "scalar", createIdentifierQuoter('"'))},
    also_cents INTEGER NOT NULL ${sqliteDecimalCheck({ name: "also_cents", nullable: false }, { precision: 12, scale: 2 }, "scalar", createIdentifierQuoter('"'))},
    micros INTEGER NOT NULL ${sqliteDecimalCheck({ name: "micros", nullable: false }, { precision: 12, scale: 4 }, "scalar", createIdentifierQuoter('"'))},
    wide_cents INTEGER NOT NULL ${sqliteDecimalCheck({ name: "wide_cents", nullable: false }, { precision: 10, scale: 2 }, "scalar", createIdentifierQuoter('"'))},
    maybe_cents INTEGER ${sqliteDecimalCheck({ name: "maybe_cents", nullable: true }, { precision: 12, scale: 2 }, "scalar", createIdentifierQuoter('"'))},
    count INTEGER NOT NULL,
    tag TEXT NOT NULL
  );
  CREATE TABLE fu3_line(
    id INTEGER PRIMARY KEY,
    led_id INTEGER,
    fee INTEGER NOT NULL ${sqliteDecimalCheck({ name: "fee", nullable: false }, { precision: 8, scale: 2 }, "scalar", createIdentifierQuoter('"'))},
    fee_micros INTEGER NOT NULL ${sqliteDecimalCheck({ name: "fee_micros", nullable: false }, { precision: 8, scale: 3 }, "scalar", createIdentifierQuoter('"'))}
  );
  INSERT INTO fu3_led VALUES
    (1,120,120,12000,120,120,1,'x'),
    (2,200,300,90000,700,NULL,2,'y');
  INSERT INTO fu3_line VALUES (1,1,120,1200),(2,2,400,5000);
`;

function build(): { db: Database.Database; driver: SQLite3Driver } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SEED);
  return { db, driver: new SQLite3Driver({ client: db }) };
}

/** Both answers, each captured as a value or as its thrown message. */
export async function bothOutcomes(
  model: "led" | "line",
  operation: string,
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const left = build();
  const right = build();
  const capture = async (run: () => unknown): Promise<unknown> => {
    try {
      return { ok: await run() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  try {
    const client = createClient({
      schema,
      driver: left.driver,
    }) as unknown as Record<
      string,
      Record<string, (input: unknown) => unknown>
    >;
    const engine = createTestCommandEngine({ schema, driver: right.driver });
    return {
      shipped: await capture(() => client[model]![operation]!(args)),
      candidate: await capture(() =>
        engine.execute(
          model,
          operation as Parameters<typeof engine.execute>[1],
          args
        )
      ),
    };
  } finally {
    await left.driver.disconnect();
    left.db.close();
    await right.driver.disconnect();
    right.db.close();
  }
}
