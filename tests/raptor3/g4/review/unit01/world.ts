import { sqliteDecimalCheck } from "@adapters/databases/sqlite/storage/decimal";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { createIdentifierQuoter } from "@src/sql/identifiers";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import Database from "better-sqlite3";

/** An independent review world: same shapes, different seeds and columns. */
export const person = s
  .model({
    id: s.int().id(),
    name: s.string().map("person_name"),
    tier: s.enum(["basic", "pro"]).nullable(),
    score: s.number().nullable(),
    balance: s.decimal({ precision: 12, scale: 2 }),
    joinedAt: s.dateTime().map("joined_at"),
    birthday: s.date().nullable(),
    avatar: s.blob().nullable(),
    profile: s.json().nullable(),
    visits: s.bigInt(),
    tags: s.string().array(),
    active: s.boolean(),
    notes: s.toMany(() => note).name("personNotes"),
  })
  .map("rv_people");

export const note = s
  .model({
    id: s.int().id(),
    personId: s.int().nullable().map("person_id"),
    title: s.string(),
    rank: s.int(),
    weight: s.int().nullable(),
    category: s.string(),
    published: s.boolean(),
    person: s
      .toOne(() => person)
      .fields("personId")
      .references("id")
      .name("personNotes"),
  })
  .map("rv_notes");

export const schema = { person, note };

class RecordingDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ) {
    this.statements.push(statement);
    return await super.execute<T>(client, statement, parameters);
  }
}

export interface World {
  readonly database: Database.Database;
  readonly driver: RecordingDriver;
  readonly engine: ReturnType<typeof createTestCommandEngine>;
  readonly statements: string[];
}

export function createWorld(): World {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE rv_people(
      id INTEGER PRIMARY KEY,
      person_name TEXT NOT NULL,
      tier TEXT,
      score REAL,
      balance INTEGER NOT NULL ${sqliteDecimalCheck({ name: "balance", nullable: false }, { precision: 12, scale: 2 }, "scalar", createIdentifierQuoter('"'))},
      joined_at TEXT NOT NULL,
      birthday TEXT,
      avatar BLOB,
      profile TEXT,
      visits INTEGER NOT NULL,
      tags TEXT NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE rv_notes(
      id INTEGER PRIMARY KEY,
      person_id INTEGER,
      title TEXT NOT NULL,
      rank INTEGER NOT NULL,
      weight INTEGER,
      category TEXT NOT NULL,
      published INTEGER NOT NULL
    );
  `);
  const driver = new RecordingDriver({ client: database });
  return {
    database,
    driver,
    engine: createTestCommandEngine({ schema, driver }),
    statements: driver.statements,
  };
}

export async function closeWorld(world: World): Promise<void> {
  await world.driver.disconnect();
  world.database.close();
}

const PERSON_DEFAULTS: Record<string, unknown> = {
  id: 1,
  person_name: "person",
  tier: null,
  score: null,
  balance: 0n,
  joined_at: "2024-01-01T00:00:00.000Z",
  birthday: null,
  avatar: null,
  profile: null,
  visits: 1n,
  tags: "[]",
  active: 0,
};
const PERSON_COLUMNS = Object.keys(PERSON_DEFAULTS);

export function seedPerson(world: World, row: Record<string, unknown>): void {
  const values = { ...PERSON_DEFAULTS, ...row };
  world.database
    .prepare(
      `INSERT INTO rv_people(${PERSON_COLUMNS.join(", ")}) VALUES (${PERSON_COLUMNS.map(
        () => "?"
      ).join(", ")})`
    )
    .run(...PERSON_COLUMNS.map((column) => values[column]));
}

const NOTE_DEFAULTS: Record<string, unknown> = {
  id: 1,
  person_id: null,
  title: "note",
  rank: 0,
  weight: null,
  category: "alpha",
  published: 0,
};
const NOTE_COLUMNS = Object.keys(NOTE_DEFAULTS);

export function seedNote(world: World, row: Record<string, unknown>): void {
  const values = { ...NOTE_DEFAULTS, ...row };
  world.database
    .prepare(
      `INSERT INTO rv_notes(${NOTE_COLUMNS.join(", ")}) VALUES (${NOTE_COLUMNS.map(
        () => "?"
      ).join(", ")})`
    )
    .run(...NOTE_COLUMNS.map((column) => values[column]));
}
