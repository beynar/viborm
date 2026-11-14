/**
 * `groupBy` by a time step, as data: one invoice set placed on the edges a
 * period can get wrong — Montreal's two DST changes of 2026, a month, a
 * quarter and a year that begin at a different instant in Montreal, Kolkata
 * and UTC, a Sunday next to its Monday — and an oracle that computes every
 * expected group in JavaScript (`Intl`, never the database).
 *
 * Runner-agnostic: the Vitest behavior (`groupby-time-step-behavior.ts`) and
 * the Bun probe read the same cases, so every PostgreSQL driver answers the
 * same questions.
 */

import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";

export const STEPS = ["day", "week", "month", "quarter", "year"] as const;
export type Step = (typeof STEPS)[number];
/** `undefined` is the default, UTC. */
export const ZONES = [undefined, "America/Montreal", "Asia/Kolkata"] as const;
type Zone = (typeof ZONES)[number];

/** The columns a step groups: an instant, a nullable one, a naive one, a date. */
export const STEPPED = ["date", "dueAt", "wall", "jour"] as const;
type Stepped = (typeof STEPPED)[number];

export const groupByTimeStepSchema = (table: string) => {
  const facture = s
    .model({
      id: s.int().id(),
      orgId: s.string(),
      statut: s.string(),
      montant: s.int(),
      date: s.dateTime(),
      dueAt: s.dateTime().nullable(),
      wall: s.dateTime().withoutTimezone(),
      jour: s.date(),
      deletedAt: s.dateTime().nullable(),
    })
    .map(table);
  /** The same rows, on a model no permission rule names. */
  const depense = s
    .model({
      id: s.int().id(),
      orgId: s.string(),
      montant: s.int(),
      date: s.dateTime(),
    })
    .map(`${table}_d`);
  return { facture, depense };
};

const INSTANTS = [
  "2026-01-01T03:00:00.000Z", // 2025-12-31 22:00 in Montreal
  "2026-01-01T05:30:00.000Z", // 2026-01-01 00:30 in Montreal
  "2026-02-01T04:30:00.000Z", // 2026-01-31 23:30 in Montreal
  "2026-02-01T05:00:00.000Z", // 2026-02-01 00:00 in Montreal, exactly
  "2026-03-08T04:30:00.000Z", // Sat 03-07 23:30 EST
  "2026-03-08T06:30:00.000Z", // Sun 03-08 01:30 EST
  "2026-03-08T07:30:00.000Z", // Sun 03-08 03:30 EDT (02:00 never happened)
  "2026-03-09T03:30:00.000Z", // Sun 03-08 23:30 EDT
  "2026-03-09T04:30:00.000Z", // Mon 03-09 00:30 EDT
  "2026-04-01T03:00:00.000Z", // 03-31 23:00 EDT: Q1 in Montreal, Q2 in UTC
  "2026-04-01T04:00:00.000Z", // 04-01 00:00 EDT
  "2026-06-30T23:59:59.000Z",
  "2026-11-01T05:30:00.000Z", // 11-01 01:30 EDT, the first one
  "2026-11-01T06:30:00.000Z", // 11-01 01:30 EST, the second one
  "2026-12-31T18:45:00.000Z", // 2027-01-01 00:15 in Kolkata
  "2027-01-01T04:59:59.999Z", // 2026-12-31 23:59:59.999 in Montreal
];
const STATUTS = ["payee", "envoyee", "brouillon"];
const DAY = 86_400_000;

export interface Facture {
  id: number;
  orgId: string;
  statut: string;
  montant: number;
  date: string;
  dueAt: string | null;
  /** A naive date and time: stored as written, read as its UTC components. */
  wall: string;
  jour: string;
  deletedAt: string | null;
}

export const FACTURES: readonly Facture[] = INSTANTS.map((date, index) => {
  const at = Date.parse(date);
  return {
    id: index + 1,
    orgId: index % 4 === 3 ? "autre" : "pyxel",
    statut: STATUTS[index % 3]!,
    montant: 10 * (index + 1),
    date,
    dueAt: index % 2 === 0 ? new Date(at + 30 * DAY).toISOString() : null,
    wall: new Date(at - 5 * 3_600_000).toISOString(),
    jour: new Date(at - 2 * DAY).toISOString().slice(0, 10),
    deletedAt: index === 5 ? "2026-05-01T00:00:00.000Z" : null,
  };
});

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>();
/** The calendar day an instant falls on in `zone`. */
const dayIn = (iso: string, zone: string): [number, number, number] => {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formats.set(zone, format);
  }
  const part = (type: string) =>
    Number(
      format!.formatToParts(new Date(iso)).find((p) => p.type === type)!.value
    );
  return [part("year"), part("month"), part("day")];
};
const spelled = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);

/** The first day of `step`'s period holding the calendar day `y-m-d`. */
export const periodStart = (
  [y, m, d]: [number, number, number],
  step: Step
): string => {
  switch (step) {
    case "day":
      return spelled(Date.UTC(y, m - 1, d));
    case "week": {
      // Monday: getUTCDay() is 0 on Sunday.
      const back = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      return spelled(Date.UTC(y, m - 1, d - back));
    }
    case "month":
      return spelled(Date.UTC(y, m - 1, 1));
    case "quarter":
      return spelled(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1));
    default:
      return spelled(Date.UTC(y, 0, 1));
  }
};

/** The period a row falls in, as the contract says each column is read. */
export const periodOf = (
  row: Facture,
  column: Stepped,
  step: Step,
  zone: Zone
): string | null => {
  const value = row[column];
  if (value === null) return null;
  const day =
    column === "jour"
      ? (value.split("-").map(Number) as [number, number, number])
      : // A naive column is read as written: its UTC components.
        dayIn(value, column === "wall" ? "UTC" : (zone ?? "UTC"));
  return periodStart(day, step);
};

type Group = Record<string, unknown>;

/**
 * The groups of `rows` by `keys`, each with `_count` and `_sum.montant`,
 * ordered by the keys ascending, NULL last: the default order PostgreSQL
 * gives an ascending key.
 */
export const oracle = (
  rows: readonly Facture[],
  keys: readonly ((row: Facture) => string | null)[],
  names: readonly string[]
): Group[] => {
  const groups = new Map<string, { key: (string | null)[]; rows: Facture[] }>();
  for (const row of rows) {
    const key = keys.map((read) => read(row));
    const id = JSON.stringify(key);
    const group = groups.get(id) ?? { key, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  const compare = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  return [...groups.values()]
    .sort((a, b) => {
      for (const [index, value] of a.key.entries()) {
        const order = compare(value, b.key[index]!);
        if (order !== 0) return order;
      }
      return 0;
    })
    .map(({ key, rows: members }) => ({
      ...Object.fromEntries(names.map((name, index) => [name, key[index]])),
      _count: members.length,
      _sum: { montant: members.reduce((sum, row) => sum + row.montant, 0) },
    }));
};

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

/** What a case calls: a model delegate's `groupBy`, typed loosely. */
type GroupBy = (args: Record<string, unknown>) => Promise<unknown>;
export interface Clients {
  /** The plain client: every row. */
  readonly base: {
    facture: { groupBy: GroupBy };
    depense: { groupBy: GroupBy };
  };
  /** `viborm/permissions` + soft delete, bound by `$as({ orgId: "pyxel" })`. */
  readonly pyxel: {
    facture: { groupBy: GroupBy };
    depense: { groupBy: GroupBy };
  };
  /**
   * A policy that reads `date` only on paid rows (the masked window), and
   * names no rule for `depense`.
   */
  readonly gated: {
    facture: { groupBy: GroupBy };
    depense: { groupBy: GroupBy };
  };
}

export interface Case {
  readonly name: string;
  readonly run: (
    clients: Clients
  ) => Promise<{ actual: unknown; expected: unknown }>;
}

const live = FACTURES.filter((row) => row.deletedAt === null);
const counted = { _count: true, _sum: { montant: true } } as const;

const matrix: Case[] = STEPPED.flatMap((column) =>
  STEPS.flatMap((step) =>
    ZONES.map(
      (zone): Case => ({
        name: `${column} by ${step} in ${zone ?? "UTC (default)"}`,
        run: async ({ base }) => ({
          actual: await base.facture.groupBy({
            by: [{ [column]: step }],
            ...(zone ? { timeZone: zone } : {}),
            ...counted,
            orderBy: { [column]: "asc" },
          }),
          expected: oracle(
            FACTURES,
            [(row) => periodOf(row, column, step, zone)],
            [column]
          ),
        }),
      })
    )
  )
);

const MONTREAL = "America/Montreal";
const month = (row: Facture) => periodOf(row, "date", "month", MONTREAL);

export const GROUPBY_TIME_STEP_CASES: readonly Case[] = [
  ...matrix,
  {
    name: "a plain column and a period, where bounds written with their offset",
    run: async ({ base }) => ({
      actual: await base.facture.groupBy({
        by: ["statut", { date: "month" }],
        where: { date: { gte: "2026-02-01T00:00:00-05:00" } },
        timeZone: MONTREAL,
        ...counted,
        orderBy: [{ statut: "asc" }, { date: "asc" }],
      }),
      expected: oracle(
        FACTURES.filter(
          (row) => Date.parse(row.date) >= Date.parse("2026-02-01T05:00:00Z")
        ),
        [(row) => row.statut, month],
        ["statut", "date"]
      ),
    }),
  },
  {
    name: "two periods: an instant by month, a date by year",
    run: async ({ base }) => ({
      actual: await base.facture.groupBy({
        by: [{ date: "month" }, { jour: "year" }],
        timeZone: MONTREAL,
        ...counted,
      }),
      expected: oracle(
        FACTURES,
        [month, (row) => periodOf(row, "jour", "year", undefined)],
        ["date", "jour"]
      ),
    }),
  },
  {
    name: "ordered by the period descending, NULL first, then take and skip",
    run: async ({ base }) => {
      const all = oracle(
        FACTURES,
        [(row) => periodOf(row, "dueAt", "month", MONTREAL)],
        ["dueAt"]
      ).reverse();
      const args = {
        by: [{ dueAt: "month" }],
        timeZone: MONTREAL,
        ...counted,
        orderBy: { dueAt: "desc" },
      };
      return {
        actual: [
          await base.facture.groupBy(args),
          await base.facture.groupBy({ ...args, take: 2 }),
          await base.facture.groupBy({ ...args, skip: 1, take: 3 }),
          await base.facture.groupBy({
            ...args,
            orderBy: { dueAt: { sort: "asc", nulls: "first" } },
          }),
        ],
        expected: [
          all,
          all.slice(0, 2),
          all.slice(1, 4),
          [all[0], ...all.slice(1).reverse()],
        ],
      };
    },
  },
  {
    name: "ordered by an aggregate, ties broken by the period; having on an aggregate",
    run: async ({ base }) => {
      const week = (row: Facture) => periodOf(row, "date", "week", MONTREAL);
      const groups = oracle(FACTURES, [week], ["date"]) as {
        date: string;
        _count: number;
        _sum: { montant: number };
      }[];
      const ordered = [...groups].sort(
        (a, b) => b._count - a._count || (a.date < b.date ? -1 : 1)
      );
      return {
        actual: [
          await base.facture.groupBy({
            by: [{ date: "week" }],
            timeZone: MONTREAL,
            ...counted,
            orderBy: [{ _count: { _all: "desc" } }, { date: "asc" }],
            take: 4,
          }),
          await base.facture.groupBy({
            by: [{ date: "week" }],
            timeZone: MONTREAL,
            ...counted,
            having: { montant: { _sum: { gt: 100 } } },
            orderBy: { date: "asc" },
          }),
        ],
        expected: [
          ordered.slice(0, 4),
          groups.filter((group) => group._sum.montant > 100),
        ],
      };
    },
  },
  {
    name: "$as with a read rule and soft delete: the actor's live rows only",
    run: async ({ pyxel }) => ({
      actual: await pyxel.facture.groupBy({
        by: [{ date: "quarter" }],
        timeZone: MONTREAL,
        ...counted,
      }),
      expected: oracle(
        live.filter((row) => row.orgId === "pyxel"),
        [(row) => periodOf(row, "date", "quarter", MONTREAL)],
        ["date"]
      ),
    }),
  },
  {
    name: "$as on a model whose read rule is `true`: every row",
    run: async ({ pyxel }) => ({
      actual: await pyxel.depense.groupBy({
        by: [{ date: "year" }],
        timeZone: MONTREAL,
        ...counted,
      }),
      expected: oracle(
        FACTURES,
        [(row) => periodOf(row, "date", "year", MONTREAL)],
        ["date"]
      ),
    }),
  },
  {
    name: "$as with a read-gated date: rows it may not read form the NULL period",
    run: async ({ gated }) => {
      const groups = oracle(
        FACTURES.filter(
          (row) => row.orgId === "pyxel" || row.statut === "payee"
        ),
        [
          (row) => row.orgId,
          (row) => (row.statut === "payee" ? month(row) : null),
        ],
        ["orgId", "date"]
      );
      const args = {
        by: ["orgId", { date: "month" }],
        timeZone: MONTREAL,
        ...counted,
      };
      return {
        actual: [
          await gated.facture.groupBy(args),
          // The gated period is nullable even where the column is not.
          await gated.facture.groupBy({
            ...args,
            orderBy: [
              { orgId: "asc" },
              { date: { sort: "asc", nulls: "first" } },
            ],
          }),
        ],
        expected: [
          groups,
          [...groups].sort(
            (a, b) =>
              (a.orgId as string).localeCompare(b.orgId as string) ||
              (a.date === null ? -1 : b.date === null ? 1 : 0)
          ),
        ],
      };
    },
  },
];

// ---------------------------------------------------------------------------
// The clients
// ---------------------------------------------------------------------------

/** The two policies the cases read through, over any base client. */
export const groupByTimeStepClients = (base: any): Clients => {
  const actor = v.object({ orgId: v.string() });
  const pyxel = base
    .$extends(softDelete({ models: { facture: { deletedAt: "deletedAt" } } }))
    .$extends(
      permissions({
        actor,
        models: {
          facture: { read: { orgId: { actor: "orgId" } } },
          depense: { read: true },
        },
      })
    )
    .$as({ orgId: "pyxel" });
  const gated = base
    .$extends(
      permissions({
        actor,
        models: {
          facture: {
            read: { orgId: { actor: "orgId" } },
            delete: { statut: "payee" },
            fields: { date: { read: "delete" } },
          },
        },
      })
    )
    .$as({ orgId: "pyxel" });
  return { base, pyxel, gated };
};

/** The rows, as the client writes them. */
export const groupByTimeStepRows = {
  facture: FACTURES,
  depense: FACTURES.map(({ id, orgId, montant, date }) => ({
    id,
    orgId,
    montant,
    date,
  })),
};
