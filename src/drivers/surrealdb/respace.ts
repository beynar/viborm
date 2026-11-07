/**
 * One list's new keys, as respacing's statement computes them on SQL, for a database
 * that reads the rows and writes them itself.
 */

import { keysBetween } from "../../ordering/keys";

/** One row placed, with what it may do there. */
export interface PlannedMember {
  readonly key: unknown;
  readonly identity: string;
  readonly order: readonly unknown[];
  readonly movable: boolean;
}

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
      (a, b) =>
        compareValues(a.member.key, b.member.key) ||
        compareValues(a.member.identity, b.member.identity)
    );
  const bound = ({ member }: (typeof current)[number]) =>
    !member.movable && isDigits(member.key);
  const anyBound = current.some(bound);
  const places: (string | null)[] = [];
  let run: number | undefined;
  let lower: string | null = null;
  const close = (upper: string | null, count: number) => {
    if (count === 0) return;
    let keys: readonly (string | null)[];
    try {
      keys = keysBetween(lower, upper, count);
    } catch {
      keys = Array.from({ length: count }, () => null);
    }
    places.push(...keys);
  };
  let count = 0;
  for (const entry of current) {
    if (bound(entry)) {
      close(entry.member.key as string, count);
      count = 0;
      lower = entry.member.key as string;
    } else if (entry.member.movable) {
      count += 1;
      run = (run ?? -1) + 1;
      if (!anyBound) places.push(`${String(run).length}${run}`);
    }
  }
  if (anyBound) close(null, count);
  const movable = current.filter((entry) => entry.member.movable);
  // A stable sort: members equal in the order keep their places.
  const picked = [...movable].sort((a, b) => {
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

const isDigits = (key: unknown): key is string =>
  typeof key === "string" && DIGIT_KEY.test(key);
const DIGIT_KEY = /^[0-9]{2,}$/;
