/**
 * Seeded worlds for the G4 generated read campaign.
 *
 * Three schema families: a scalar-rich model carrying every codec and list
 * type this campaign exercises, a relation family with to-one, to-many,
 * junction, variant and self-relation edges, and a mapped compound-key family.
 *
 * Rows are produced deterministically from the recipe seed as PUBLIC values.
 * They are written through the shipped client, which owns the physical
 * spelling of a DateTime, a decimal or a JSON list; the campaign's oracle then
 * evaluates the very same public values in JavaScript, so nothing in the
 * expected answer comes from SQL or from the candidate's decoder.
 */
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { DbNull, s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";

export const G4_GENERATION_PROFILES = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
] as const;
export const G4_GENERATION_TRANSPORT_PROFILES = [
  "scripted-returning-weak",
  "scripted-returning-ack",
] as const;
export type G4GenerationProfile =
  | (typeof G4_GENERATION_PROFILES)[number]
  | (typeof G4_GENERATION_TRANSPORT_PROFILES)[number];

export const G4_FAMILIES = ["codec", "relation", "compound"] as const;
export type G4Family = (typeof G4_FAMILIES)[number];

const STATUSES = ["ACTIVE", "PAUSED", "DONE"] as const;

export function generationSchema() {
  const specimen = s
    .model({
      id: s.int().id(),
      label: s.string().map("label_value"),
      flag: s.boolean().map("flag_value"),
      count: s.int().map("count_value"),
      ratio: s.number().map("ratio_value"),
      big: s.bigInt().map("big_value"),
      amount: s.decimal({ precision: 12, scale: 3 }).map("amount_value"),
      moment: s.dateTime().map("moment_value"),
      status: s.enum([...STATUSES]).map("status_value"),
      document: s.json().nullable().map("document_value"),
      labels: s.string().array().map("label_list"),
      counts: s.int().array().map("count_list"),
      note: s.string().nullable().map("note_value"),
    })
    .map("g4_gen_specimens");

  const owner = s
    .model({
      id: s.int().id(),
      name: s.string().map("owner_name"),
      weight: s.int().map("owner_weight"),
      parentId: s.int().nullable().map("parent_id"),
      parent: s
        .toOne(() => owner)
        .fields("parentId")
        .references("id")
        .name("lineage"),
      children: s.toMany(() => owner).name("lineage"),
      items: s.toMany(() => item),
      marks: s.toMany(() => mark).through("g4_gen_owner_marks"),
    })
    .map("g4_gen_owners");

  const item = s
    .model({
      id: s.int().id(),
      title: s.string().map("item_title"),
      size: s.int().map("item_size"),
      ownerId: s.int().nullable().map("owner_id"),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("g4_gen_items");

  const mark = s
    .model({
      id: s.int().id(),
      tag: s.string().unique().map("mark_tag"),
      owners: s.toMany(() => owner),
    })
    .map("g4_gen_marks");

  const board = s
    .model({
      id: s.int().id(),
      title: s.string().map("board_title"),
      pins: s
        .toMany(
          { item: () => item, mark: () => mark },
          { values: { item: "pin.item.v1", mark: "pin.mark.v1" } }
        )
        .through({
          item: { table: "g4_gen_board_items", source: "board", target: "pin" },
          mark: { table: "g4_gen_board_marks", source: "board", target: "pin" },
        }),
    })
    .map("g4_gen_boards");

  const entry = s
    .model({
      region: s.string().map("region_key"),
      code: s.string().map("entry_code"),
      label: s.string().map("entry_label"),
      score: s.int().map("entry_score"),
    })
    .id(["region", "code"])
    .map("g4_gen_entries");

  return { specimen, owner, item, mark, board, entry };
}

/** xorshift32; the campaign's only source of variation. */
export function picker(seed: number) {
  let state = (seed ^ 0x5bf0_3635) >>> 0 || 0x9e37_79b9;
  return (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % limit;
  };
}

export interface SpecimenRow {
  readonly id: number;
  readonly label: string;
  readonly flag: boolean;
  readonly count: number;
  readonly ratio: number;
  readonly big: bigint;
  readonly amount: string;
  readonly moment: Date;
  readonly status: (typeof STATUSES)[number];
  readonly document: unknown;
  readonly labels: readonly string[];
  readonly counts: readonly number[];
  readonly note: string | null;
}

export interface OwnerRow {
  readonly id: number;
  readonly name: string;
  readonly weight: number;
  readonly parentId: number | null;
}

export interface ItemRow {
  readonly id: number;
  readonly title: string;
  readonly size: number;
  readonly ownerId: number | null;
}

export interface EntryRow {
  readonly region: string;
  readonly code: string;
  readonly label: string;
  readonly score: number;
}

export interface GeneratedRows {
  readonly specimens: readonly SpecimenRow[];
  readonly owners: readonly OwnerRow[];
  readonly items: readonly ItemRow[];
  readonly entries: readonly EntryRow[];
}

const WORDS = ["alpha", "beta", "gamma", "delta", "omega"] as const;
const REGIONS = ["eu", "us", "ap"] as const;

/** Every value here is a public value; nothing is a physical spelling. */
export function generateRows(seed: number, rowCount: number): GeneratedRows {
  const pick = picker(seed);
  const specimens: SpecimenRow[] = [];
  for (let index = 0; index < rowCount; index++) {
    const word = WORDS[pick(WORDS.length)] ?? "alpha";
    const count = pick(40) - 10;
    specimens.push({
      id: index + 1,
      label: `${word}-${index}`,
      flag: pick(2) === 0,
      count,
      ratio: pick(9) / 4,
      big: BigInt(9_007_199_254_740_990 + pick(9)),
      amount: `${count}.${String(pick(1000)).padStart(3, "0")}`,
      moment: new Date(Date.UTC(2024, pick(12), 1 + pick(27), pick(24))),
      status: STATUSES[pick(STATUSES.length)] ?? "ACTIVE",
      document: pick(4) === 0 ? null : { word, level: pick(5) },
      labels: Array.from(
        { length: pick(3) },
        (_, member) => `${WORDS[(index + member) % WORDS.length]}`
      ),
      counts: Array.from({ length: pick(3) }, (_, member) => member + pick(4)),
      note: pick(3) === 0 ? null : `${word} note ${index}`,
    });
  }
  const owners: OwnerRow[] = [];
  for (let index = 0; index < rowCount; index++) {
    owners.push({
      id: index + 1,
      name: `${WORDS[pick(WORDS.length)] ?? "alpha"}-owner-${index}`,
      weight: pick(20),
      parentId: index === 0 || pick(3) === 0 ? null : pick(index) + 1,
    });
  }
  const items: ItemRow[] = [];
  for (let index = 0; index < rowCount * 2; index++) {
    const owned = pick(5) !== 0;
    items.push({
      id: index + 1,
      title: `item-${WORDS[pick(WORDS.length)] ?? "alpha"}-${index}`,
      size: pick(30),
      ownerId: owned ? pick(rowCount) + 1 : null,
    });
  }
  const entries: EntryRow[] = [];
  const used = new Set<string>();
  for (let index = 0; index < rowCount; index++) {
    const region = REGIONS[pick(REGIONS.length)] ?? "eu";
    const code = `c${index}`;
    const key = `${region}/${code}`;
    if (used.has(key)) continue;
    used.add(key);
    entries.push({
      region,
      code,
      label: `${WORDS[pick(WORDS.length)] ?? "alpha"} ${index}`,
      score: pick(50),
    });
  }
  return { specimens, owners, items, entries };
}

/**
 * The observed transport model of one profile.
 *
 * These are READ-transport models. `supportsBatch`, `supportsTransactions` and
 * `supportsOrderedCommittedSegments` — the declarations that separate
 * `sqlite-interactive` from `sqlite-atomic-batch` and `scripted-returning-weak`
 * from `scripted-returning-ack` in `tests/raptor3/profiles.ts` — are consumed
 * only by the write engine and by migration planning; a read never reads one.
 * Each profile therefore has to differ in what the transport actually DOES to
 * a read, and the campaign records that observation per cell so a profile
 * that quietly collapses into another is a receipt failure, not a silent
 * doubling of cost.
 *
 * The expectation `profile → model` is NOT stated here. It lives once, in
 * `scripts/raptor3-manifest.mjs` (`G4_TRANSPORT_MODELS`), where the receipt
 * assertion reads it; this file only reports what the transport did. Two
 * independent producers, one comparison.
 */
export type G4TransportModel =
  | "interactive-session"
  | "atomic-submission"
  | "detached-returning"
  | "acknowledged-returning";

/**
 * The four campaign profiles, all executing real SQLite, each a distinct
 * observable read transport:
 *
 * - `sqlite-interactive` — an interactive session: one statement submitted on
 *   the live connection, rows borrowed from the provider.
 * - `sqlite-atomic-batch` — no interactive session: every read is its own
 *   atomic submission, physically `BEGIN`/`COMMIT` around the statement (real
 *   control statements on the same connection, visible in the stream).
 * - `scripted-returning-weak` — a weak returning envelope: detached row copies
 *   the caller owns, and no row-count acknowledgement (`rowCount: 0`).
 * - `scripted-returning-ack` — an acknowledging returning envelope: it declares
 *   `supportsOrderedCommittedSegments` (the G3 `ScriptedTransport` spelling)
 *   and, because no read consults that declaration, it also performs the step
 *   the declaration describes: the transport acknowledges the returning
 *   statement in its own awaited turn BEFORE the rows are handed over for
 *   decoding, and reports their exact count.
 *
 * `statements` is the physical SQL stream (control statements included);
 * `envelopes` is what the transport handed back per returning statement. The
 * four profiles are pairwise distinct in that pair of observations, which
 * `harness.selftest.test.ts` requires cell by cell.
 *
 * The transport model applies once the world is SEALED, i.e. after seeding.
 * Seeding is the shipped client's write path and is not this campaign's
 * subject; wrapping it would model nothing and would collide with the write
 * engine's own transactions.
 */
export interface G4ReturnedEnvelope {
  readonly rowCount: number;
  readonly rows: number;
  readonly detached: boolean;
  readonly acknowledged: boolean;
}

class ProfileDriver extends SQLite3Driver {
  override readonly supportsOrderedCommittedSegments: boolean;

  constructor(
    client: Database.Database,
    private readonly profile: G4GenerationProfile
  ) {
    super({ client });
    this.supportsOrderedCommittedSegments =
      profile === "scripted-returning-ack";
  }

  readonly statements: string[] = [];
  readonly envelopes: G4ReturnedEnvelope[] = [];
  private sealed = false;
  private readonly observed = new Set<G4TransportModel>();

  /** Seeding is over; every later statement runs under the transport model. */
  seal(): void {
    this.sealed = true;
  }

  /** What the transport actually did since the seal, not what it is named. */
  observedTransport(): G4TransportModel | "none" {
    if (this.observed.size === 1) return [...this.observed][0] as G4TransportModel;
    return "none";
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (!this.sealed) {
      this.statements.push(statement);
      return super.execute<T>(client, statement, parameters);
    }
    if (this.profile === "sqlite-atomic-batch") {
      // A transport without an interactive session submits each statement as
      // its own atomic unit. `inTransaction` guards the case where something
      // above already opened one: SQLite refuses a nested BEGIN.
      const own = !client.inTransaction;
      if (own) {
        client.exec("BEGIN");
        this.statements.push("BEGIN");
      }
      this.statements.push(statement);
      try {
        const response = await super.execute<T>(client, statement, parameters);
        if (own) {
          client.exec("COMMIT");
          this.statements.push("COMMIT");
        }
        this.observed.add("atomic-submission");
        return this.returned(response, {
          detached: false,
          acknowledged: false,
        });
      } catch (failure) {
        if (own) {
          client.exec("ROLLBACK");
          this.statements.push("ROLLBACK");
        }
        throw failure;
      }
    }
    this.statements.push(statement);
    const response = await super.execute<T>(client, statement, parameters);
    if (this.profile === "scripted-returning-weak") {
      this.observed.add("detached-returning");
      // A weak returning transport hands back detached row copies the caller
      // owns and makes no row-count assertion about a returning statement. The
      // copies are frozen: a decoder that wrote back into the provider's row
      // works by accident on a borrowed transport and must not here.
      return this.returned(
        {
          ...response,
          rowCount: 0,
          rows: response.rows.map((row) =>
            Object.freeze({ ...(row as object) })
          ) as T[],
        },
        { detached: true, acknowledged: false }
      );
    }
    if (this.profile === "scripted-returning-ack") {
      // The acknowledgement is a real awaited turn that completes before the
      // rows are handed over, which is what the declaration above describes.
      await Promise.resolve();
      this.observed.add("acknowledged-returning");
      return this.returned(
        { ...response, rowCount: response.rows.length },
        { detached: false, acknowledged: true }
      );
    }
    this.observed.add("interactive-session");
    return this.returned(response, { detached: false, acknowledged: false });
  }

  private returned<T>(
    response: QueryResult<T>,
    shape: { detached: boolean; acknowledged: boolean }
  ): QueryResult<T> {
    this.envelopes.push({
      rowCount: response.rowCount,
      rows: response.rows.length,
      ...shape,
    });
    return response;
  }
}

export interface GeneratedWorld {
  readonly database: Database.Database;
  readonly driver: ProfileDriver;
  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;
  readonly rows: GeneratedRows;
  close(): Promise<void>;
}

export async function createGeneratedWorld(
  seed: number,
  rowCount: number,
  profile: G4GenerationProfile
): Promise<GeneratedWorld> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = OFF");
  const driver = new ProfileDriver(database, profile);
  const schema = generationSchema();
  const client = createClient({ schema, driver });
  await syncLiveSchema(client);
  const rows = generateRows(seed, rowCount);
  const writer = client as unknown as Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;
  for (const specimen of rows.specimens) {
    await writer.specimen?.create?.({
      data: {
        ...specimen,
        labels: [...specimen.labels],
        counts: [...specimen.counts],
        document: specimen.document ?? DbNull,
      },
    });
  }
  for (const owner of rows.owners) {
    await writer.owner?.create?.({
      data: { id: owner.id, name: owner.name, weight: owner.weight },
    });
  }
  for (const owner of rows.owners) {
    if (owner.parentId === null) continue;
    await writer.owner?.update?.({
      where: { id: owner.id },
      data: { parentId: owner.parentId },
    });
  }
  for (const item of rows.items) {
    await writer.item?.create?.({ data: { ...item } });
  }
  for (const entry of rows.entries) {
    await writer.entry?.create?.({ data: { ...entry } });
  }
  driver.seal();
  return {
    database,
    driver,
    client: writer,
    rows,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}
