/**
 * The scalar-rich world behind the G4 C12 codec witnesses and the codec-bearing
 * filter rows (Q-W05, Q-W06, Q-W07).
 *
 * Oracle note. Unlike the relation world, this world is *written* by the
 * shipped client rather than seeded with raw SQL: the physical spelling of a
 * DateTime, a decimal, a blob or a JSON list is exactly what SC-01…SL-10 are
 * about, and hand-writing that spelling would make the witness assert this
 * stream's guess instead of the shipped contract. The hand value is therefore
 * the *public* value written; the physical row is pinned separately with raw
 * SQL so the storage shape stays visible; and both engines must read the hand
 * value back.
 */
import { s } from "@schema";

export const SPECIMEN_TABLE = "g4_codec_specimens";
export const PLACE_TABLE = "g4_codec_places";
export const VECTOR_TABLE = "g4_codec_vectors";

export const SPECIMEN_STATUSES = ["ACTIVE", "PAUSED", "DONE"] as const;
export const SPECIMEN_MONEY = { precision: 12, scale: 3 } as const;

export function codecWorldSchema() {
  const specimen = s
    .model({
      id: s.int().id(),
      label: s.string().map("label_value"),
      flag: s.boolean().map("flag_value"),
      count: s.int().map("count_value"),
      ratio: s.number().map("ratio_value"),
      big: s.bigInt().map("big_value"),
      amount: s.decimal(SPECIMEN_MONEY).map("amount_value"),
      moment: s.dateTime().map("moment_value"),
      day: s.date().map("day_value"),
      clock: s.time().map("clock_value"),
      status: s.enum([...SPECIMEN_STATUSES]).map("status_value"),
      document: s.json().nullable().map("document_value"),
      payload: s.blob().map("payload_value"),
      labels: s.string().array().map("label_list"),
      flags: s.boolean().array().map("flag_list"),
      counts: s.int().array().map("count_list"),
      ratios: s.number().array().map("ratio_list"),
      bigs: s.bigInt().array().map("big_list"),
      amounts: s.decimal(SPECIMEN_MONEY).array().map("amount_list"),
      moments: s.dateTime().array().map("moment_list"),
      days: s.date().array().map("day_list"),
      clocks: s.time().array().map("clock_list"),
      statuses: s.enum([...SPECIMEN_STATUSES]).array().map("status_list"),
    })
    .map(SPECIMEN_TABLE);
  return { specimen };
}

/** Kept separate so a provider without a spatial tier blocks only these rows. */
export function spatialWorldSchema() {
  const place = s
    .model({
      id: s.int().id(),
      name: s.string().map("place_name"),
      location: s.point().map("place_location"),
    })
    .map(PLACE_TABLE);
  return { place };
}

/**
 * Vector is its own world: the SQLite adapter declares no vector tier, so this
 * schema witnesses the capability REFUSAL locally and the round trip only on a
 * capable native provider (`tests/raptor3/g4/native/`).
 */
export function vectorWorldSchema() {
  const embedded = s
    .model({
      id: s.int().id(),
      name: s.string().map("embedded_name"),
      embedding: s.vector().dimension(3).map("embedded_vector"),
    })
    .map(VECTOR_TABLE);
  return { embedded };
}

export interface SpecimenValues {
  readonly id: number;
  readonly label: string;
  readonly flag: boolean;
  readonly count: number;
  readonly ratio: number;
  readonly big: bigint;
  readonly amount: string;
  readonly moment: Date;
  readonly day: Date;
  readonly clock: string;
  readonly status: (typeof SPECIMEN_STATUSES)[number];
  readonly document: unknown;
  readonly payload: Uint8Array;
  readonly labels: readonly string[];
  readonly flags: readonly boolean[];
  readonly counts: readonly number[];
  readonly ratios: readonly number[];
  readonly bigs: readonly bigint[];
  readonly amounts: readonly string[];
  readonly moments: readonly Date[];
  readonly days: readonly Date[];
  readonly clocks: readonly string[];
  readonly statuses: readonly (typeof SPECIMEN_STATUSES)[number][];
}

/**
 * Three specimens. The first carries the hard boundaries (a bigint past 2^53, a
 * decimal whose last fraction digit a double cannot hold, epoch DateTime, a
 * blob with a NUL and a high byte, a JSON document with a nested null); the
 * second competes on every list predicate; the third is the "must not match"
 * row for filters and carries the JSON database NULL.
 */
export const SPECIMENS: readonly SpecimenValues[] = [
  {
    id: 1,
    label: "alpha specimen",
    flag: true,
    count: 7,
    ratio: 1.5,
    big: 9_007_199_254_740_993n,
    amount: "123456.001",
    moment: new Date("1970-01-01T00:00:00.000Z"),
    day: new Date("2024-03-07T00:00:00.000Z"),
    clock: "13:45:30",
    status: "ACTIVE",
    document: { theme: "dark", level: 2, nested: { flag: null } },
    payload: new Uint8Array([0, 1, 2, 128, 253, 255]),
    labels: ["alpha", "beta"],
    flags: [true, false],
    counts: [1, 2, 3],
    ratios: [0.5, -0.25],
    bigs: [9_007_199_254_740_993n, 1n],
    amounts: ["1.2", "-0.003"],
    moments: [
      new Date("2024-01-02T03:04:05.000Z"),
      new Date("2024-02-03T04:05:06.000Z"),
    ],
    days: [new Date("2024-01-02T00:00:00.000Z")],
    clocks: ["00:00:00", "23:59:59"],
    statuses: ["ACTIVE", "DONE"],
  },
  {
    id: 2,
    label: "beta specimen",
    flag: false,
    count: 11,
    ratio: -2.25,
    big: -9_007_199_254_740_993n,
    amount: "-0.001",
    moment: new Date("2024-06-01T22:45:10.500Z"),
    day: new Date("1999-12-31T00:00:00.000Z"),
    clock: "00:00:01",
    status: "PAUSED",
    document: { theme: "light", level: 9 },
    payload: new Uint8Array([255, 0, 42]),
    labels: ["gamma"],
    flags: [false],
    counts: [4, 5],
    ratios: [2.5],
    bigs: [2n],
    amounts: ["9.999"],
    moments: [new Date("2024-03-04T05:06:07.000Z")],
    days: [new Date("2020-02-29T00:00:00.000Z")],
    clocks: ["12:00:00"],
    statuses: ["PAUSED"],
  },
  {
    id: 3,
    label: "gamma specimen",
    flag: false,
    count: 0,
    ratio: 0,
    big: 0n,
    amount: "0",
    moment: new Date("2030-12-31T23:59:59.999Z"),
    day: new Date("2030-12-31T00:00:00.000Z"),
    clock: "06:30:00",
    status: "DONE",
    document: null,
    payload: new Uint8Array([]),
    labels: [],
    flags: [],
    counts: [],
    ratios: [],
    bigs: [],
    amounts: [],
    moments: [],
    days: [],
    clocks: [],
    statuses: [],
  },
];

export interface PlaceValues {
  readonly id: number;
  readonly name: string;
  readonly location: { readonly longitude: number; readonly latitude: number };
}

export const PLACES: readonly PlaceValues[] = [
  {
    id: 1,
    name: "paris",
    location: { longitude: 2.3522, latitude: 48.8566 },
  },
  {
    id: 2,
    name: "london",
    location: { longitude: -0.1276, latitude: 51.5072 },
  },
  {
    id: 3,
    name: "antipode",
    location: { longitude: 180, latitude: 0 },
  },
];

export interface EmbeddedValues {
  readonly id: number;
  readonly name: string;
  readonly embedding: readonly number[];
}

export const EMBEDDINGS: readonly EmbeddedValues[] = [
  { id: 1, name: "unit-x", embedding: [1, 0, 0] },
  { id: 2, name: "unit-y", embedding: [0, 1, 0] },
  { id: 3, name: "unit-z", embedding: [0, 0, 1] },
];
