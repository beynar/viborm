import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
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
    maybeCents: s.decimal({ precision: 12, scale: 2 }).nullable().map("maybe_cents"),
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

export const ledRefs = createModelFieldRefs("led", led) as Record<string, unknown>;
export const lineRefs = createModelFieldRefs("line", line) as Record<string, unknown>;

const SEED = `
  CREATE TABLE fu3_led(
    id INTEGER PRIMARY KEY,
    cents TEXT NOT NULL,
    also_cents TEXT NOT NULL,
    micros TEXT NOT NULL,
    wide_cents TEXT NOT NULL,
    maybe_cents TEXT,
    count INTEGER NOT NULL,
    tag TEXT NOT NULL
  );
  CREATE TABLE fu3_line(
    id INTEGER PRIMARY KEY,
    led_id INTEGER,
    fee TEXT NOT NULL,
    fee_micros TEXT NOT NULL
  );
  INSERT INTO fu3_led VALUES
    (1,'1.20','1.20','1.2000','1.20','1.20',1,'x'),
    (2,'2.00','3.00','9.0000','7.00',NULL,2,'y');
  INSERT INTO fu3_line VALUES (1,1,'1.20','1.200'),(2,2,'4.00','5.000');
`;

function build(): { db: Database.Database; driver: SQLite3Driver } {
  const db = new Database(":memory:");
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
    const engine = createCommandEngine({ schema, driver: right.driver });
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
