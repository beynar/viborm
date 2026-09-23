import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";

export const author = s
  .model({
    id: s.int().id(),
    name: s.string().map("author_name"),
    tier: s.enum(["basic", "pro"]).nullable(),
    rating: s.number().nullable(),
    balance: s.decimal({ precision: 12, scale: 2 }),
    joinedAt: s.dateTime().map("joined_at"),
    birthday: s.date().nullable(),
    shiftStart: s.time().nullable().map("shift_start"),
    tags: s.string().array(),
    avatar: s.blob().nullable(),
    profile: s.json().nullable(),
    visits: s.bigInt(),
    active: s.boolean(),
    posts: s.toMany(() => post).name("authorPosts"),
  })
  .map("g4_authors");

export const post = s
  .model({
    id: s.int().id(),
    authorId: s.int().nullable().map("author_id"),
    title: s.string(),
    rank: s.int(),
    category: s.string(),
    published: s.boolean(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id")
      .name("authorPosts"),
  })
  .map("g4_posts");

export const schema = { author, post };

class RecordingDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  lastFailure?: { statement: string; parameters: unknown[]; message: string };
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ) {
    this.statements.push(statement);
    try {
      return await super.execute<T>(client, statement, parameters);
    } catch (error) {
      this.lastFailure = {
        statement,
        parameters,
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }
}

export interface World {
  readonly database: Database.Database;
  readonly driver: RecordingDriver;
  readonly engine: ReturnType<typeof createCommandEngine>;
  readonly statements: string[];
}

export function createWorld(): World {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE g4_authors(
      id INTEGER PRIMARY KEY,
      author_name TEXT NOT NULL,
      tier TEXT,
      rating REAL,
      balance INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      birthday TEXT,
      shift_start TEXT,
      tags TEXT NOT NULL,
      avatar BLOB,
      profile TEXT,
      visits INTEGER NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE g4_posts(
      id INTEGER PRIMARY KEY,
      author_id INTEGER,
      title TEXT NOT NULL,
      rank INTEGER NOT NULL,
      category TEXT NOT NULL,
      published INTEGER NOT NULL,
      FOREIGN KEY(author_id) REFERENCES g4_authors(id)
    );
  `);
  const driver = new RecordingDriver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema, driver }),
    statements: driver.statements,
  };
}

export async function closeWorld(world: World): Promise<void> {
  await world.driver.disconnect();
  world.database.close();
}

const AUTHOR_DEFAULTS: Record<string, unknown> = {
  id: 1,
  author_name: "author",
  tier: null,
  rating: null,
  balance: 0n,
  joined_at: "2024-01-01T00:00:00.000Z",
  birthday: null,
  shift_start: null,
  tags: "[]",
  avatar: null,
  profile: null,
  visits: 1n,
  active: 0,
};

const AUTHOR_COLUMNS = Object.keys(AUTHOR_DEFAULTS);

/** Physical rows written by hand: the read side decodes what a provider holds. */
export function seedAuthor(world: World, row: Record<string, unknown>): void {
  const values = { ...AUTHOR_DEFAULTS, ...row };
  world.database
    .prepare(
      `INSERT INTO g4_authors(${AUTHOR_COLUMNS.join(", ")}) VALUES (${AUTHOR_COLUMNS.map(
        () => "?"
      ).join(", ")})`
    )
    .run(...AUTHOR_COLUMNS.map((column) => values[column]));
}

export function seedPost(world: World, row: Record<string, unknown>): void {
  const defaults: Record<string, unknown> = {
    id: 1,
    author_id: null,
    title: "post",
    rank: 0,
    category: "alpha",
    published: 0,
  };
  const values = { ...defaults, ...row };
  const columns = Object.keys(defaults);
  world.database
    .prepare(
      `INSERT INTO g4_posts(${columns.join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`
    )
    .run(...columns.map((column) => values[column]));
}

/**
 * The same world, once for the shipped engine and once for the candidate: the
 * candidate may not answer an admitted input differently. One owner, used by
 * every differential witness in this unit.
 */
export async function differential(
  seed: (world: World) => void,
  model: string,
  operation: Parameters<World["engine"]["execute"]>[1],
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const shippedWorld = createWorld();
  const candidateWorld = createWorld();
  seed(shippedWorld);
  seed(candidateWorld);
  try {
    const client = createClient({
      schema,
      driver: shippedWorld.driver,
    }) as unknown as Record<string, Record<string, (input: unknown) => unknown>>;
    const shipped = await client[model]![operation]!(args);
    const candidate = await candidateWorld.engine.execute(
      model,
      operation,
      args
    );
    return { shipped, candidate };
  } finally {
    await closeWorld(shippedWorld);
    await closeWorld(candidateWorld);
  }
}
