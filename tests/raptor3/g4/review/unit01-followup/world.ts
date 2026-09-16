import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";

/**
 * Follow-up review world. Same public arguments answered twice — once by the
 * SHIPPED client and once by the candidate — over identical data, so any
 * difference is an observable public-contract change of the repair pass.
 */
export const team = s
  .model({
    id: s.int().id(),
    label: s.string().map("team_label"),
    members: s.toMany(() => member).name("teamMembers"),
  })
  .map("fu_teams");

export const member = s
  .model({
    id: s.int().id(),
    teamId: s.int().nullable().map("team_id"),
    name: s.string().map("member_name"),
    rank: s.int(),
    weight: s.int().nullable(),
    bucket: s.string(),
    avatar: s.blob().nullable(),
    active: s.boolean(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id")
      .name("teamMembers"),
  })
  .map("fu_members");

export const schema = { team, member };

export interface Pair {
  readonly shipped: Record<string, Record<string, (input: unknown) => unknown>>;
  readonly candidate: ReturnType<typeof createCommandEngine>;
  close(): Promise<void>;
}

function build(sql: string): {
  db: Database.Database;
  driver: SQLite3Driver;
} {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE fu_teams(id INTEGER PRIMARY KEY, team_label TEXT NOT NULL);
    CREATE TABLE fu_members(
      id INTEGER PRIMARY KEY,
      team_id INTEGER,
      member_name TEXT NOT NULL,
      rank INTEGER NOT NULL,
      weight INTEGER,
      bucket TEXT NOT NULL,
      avatar BLOB,
      active INTEGER NOT NULL
    );
  `);
  db.exec(sql);
  return { db, driver: new SQLite3Driver({ client: db }) };
}

export function pair(seed: string): Pair {
  const left = build(seed);
  const right = build(seed);
  return {
    shipped: createClient({
      schema,
      driver: left.driver,
    }) as unknown as Record<
      string,
      Record<string, (input: unknown) => unknown>
    >,
    candidate: createCommandEngine({ schema, driver: right.driver }),
    async close() {
      await left.driver.disconnect();
      left.db.close();
      await right.driver.disconnect();
      right.db.close();
    },
  };
}

/** The same call on both engines; returns both answers for comparison. */
export async function both(
  seed: string,
  model: "team" | "member",
  operation: string,
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const world = pair(seed);
  try {
    const shipped = await world.shipped[model]![operation]!(args);
    const candidate = await world.candidate.execute(
      model,
      operation as Parameters<typeof world.candidate.execute>[1],
      args
    );
    return { shipped, candidate };
  } finally {
    await world.close();
  }
}

/** Both answers, each captured as a value or as its thrown message. */
export async function bothOutcomes(
  seed: string,
  model: "team" | "member",
  operation: string,
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const world = pair(seed);
  const capture = async (run: () => unknown): Promise<unknown> => {
    try {
      return { ok: await run() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  try {
    return {
      shipped: await capture(() => world.shipped[model]![operation]!(args)),
      candidate: await capture(() =>
        world.candidate.execute(
          model,
          operation as Parameters<typeof world.candidate.execute>[1],
          args
        )
      ),
    };
  } finally {
    await world.close();
  }
}
