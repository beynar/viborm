// The time step of a `groupBy` column: its vocabulary, the one reading of a
// `by` member, and the time zone a call may name. A leaf module: the engine,
// the SurrealDB backend and the result-shape reader import it without the
// operation schemas.

import { FeatureNotSupportedError } from "@errors";

/** The periods a `date` or `dateTime` column can be grouped by. */
export const TIME_STEPS = ["day", "week", "month", "quarter", "year"] as const;

export type TimeStep = (typeof TIME_STEPS)[number];

/**
 * One admitted `by` member: a column, or `{ [column]: step }` for a column
 * grouped by a time step. Admission refuses every other spelling, so the
 * object always holds exactly one key.
 */
export type GroupByMember = string | Readonly<Record<string, TimeStep>>;

/** What a `by` member groups: the column, and its step when it has one. */
export interface GroupedColumn {
  readonly field: string;
  readonly step?: TimeStep;
}

/** The one reading of an admitted `by` member. */
export const groupedColumn = (member: GroupByMember): GroupedColumn => {
  if (typeof member === "string") return { field: member };
  const [field, step] = Object.entries(member)[0]!;
  return { field, step };
};

/**
 * `Area/Location` as the IANA database spells it. An offset (`+05:00`,
 * `UTC+5`) and an abbreviation (`EST`, `CET`) have no slash; `Etc/GMT+5` has
 * one and is refused by name below: like PostgreSQL's `UTC+5`, it means the
 * opposite sign of what it reads. `Etc/UTC` is plain UTC.
 */
const ZONE_NAME = /^[A-Z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+$/;
const INVERTED_OFFSET = /^Etc\/GMT[+-]/;
const known = new Set<string>(["UTC"]);

/**
 * Whether `name` is an IANA time zone this runtime knows: `UTC` or an
 * `Area/Location` name. Checked before any statement is sent, because the
 * server answers an unknown zone with an error and a POSIX offset with the
 * wrong instant.
 */
export const isTimeZoneName = (name: string): boolean => {
  if (known.has(name)) return true;
  if (!ZONE_NAME.test(name) || INVERTED_OFFSET.test(name)) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: name });
  } catch {
    return false;
  }
  known.add(name);
  return true;
};

/**
 * The refusal of an engine with no period vocabulary, raised while the call
 * is planned, before any statement is sent. One error for every such engine.
 */
export const timeStepUnsupported = (): FeatureNotSupportedError =>
  new FeatureNotSupportedError(
    "groupBy",
    "timeStep",
    "Grouping by a time step is supported on PostgreSQL only."
  );
