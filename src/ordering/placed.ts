/**
 * One list's new keys, as respacing's statement computes them on SQL, for a database
 * that reads the rows and writes them itself.
 */

import { keysBetween } from "./keys";

/** One row placed, with what it may do there. */
export interface PlannedMember {
  readonly key: unknown;
  /** The row's key, field by field, which breaks ties in its own order. */
  readonly identity: readonly unknown[];
  readonly order: readonly unknown[];
  readonly movable: boolean;
}

const DIGIT_KEY = /^[0-9]{2,}$/;

const compareValues = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  // A missing value counts as the largest, as PostgreSQL places it.
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
};

/**
 * One list's new keys, as the respacing statement computes them: in the list's
 * current order, a movable member takes a short key between the fixed keys around
 * its place, or `10`, `11`, … where the list has none. With an order, the movable
 * members take those places in it.
 */
export function placed(
  members: readonly PlannedMember[],
  ways: readonly ("asc" | "desc")[]
): readonly (string | null)[] {
  const current = members
    .map((member, at) => ({ member, at }))
    .sort(
      ({ member: a }, { member: b }) =>
        compareValues(a.key, b.key) ||
        // Two identities, field by field: the first field that differs decides.
        a.identity.reduce<number>(
          (decided, value, index) =>
            decided || compareValues(value, b.identity[index]),
          0
        )
    );
  const bound = ({ member }: (typeof current)[number]) =>
    !member.movable &&
    typeof member.key === "string" &&
    DIGIT_KEY.test(member.key);
  const anyBound = current.some(bound);
  const places: (string | null)[] = [];
  let lower: string | null = null;
  let count = 0;
  const close = (upper: string | null) => {
    if (count === 0) return;
    try {
      places.push(...keysBetween(lower, upper, count));
    } catch {
      places.push(...new Array<null>(count).fill(null));
    }
  };
  for (const entry of current) {
    if (bound(entry)) {
      close(entry.member.key as string);
      count = 0;
      lower = entry.member.key as string;
    } else if (entry.member.movable) {
      count += 1;
      if (!anyBound)
        places.push(`${String(places.length).length}${places.length}`);
    }
  }
  if (anyBound) close(null);
  // A stable sort: members equal in the order keep their places.
  const picked = current
    .filter((entry) => entry.member.movable)
    .sort((a, b) => {
      for (const [index, way] of ways.entries()) {
        const compared = compareValues(
          a.member.order[index],
          b.member.order[index]
        );
        if (compared !== 0) return way === "desc" ? -compared : compared;
      }
      return 0;
    });
  const keys: (string | null)[] = members.map(() => null);
  for (const [slot, entry] of picked.entries())
    keys[entry.at] = places[slot] ?? null;
  return keys;
}
