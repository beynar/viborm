/** The wall-clock value shared by temporal `now` and `updatedAt` generators. */
export type TemporalKind = "datetime" | "date" | "time";

/**
 * Read the host wall clock once and spell it in one temporal scalar's logical
 * input language.
 */
export function currentTemporalValue(kind: TemporalKind): string {
  const timestamp = new Date().toISOString();
  if (kind === "date") return timestamp.slice(0, 10);
  if (kind === "time") return timestamp.slice(11, 19);
  return timestamp;
}
