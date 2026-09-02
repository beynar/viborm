/**
 * Greedy, deterministic shrinking of a failing payload (unit B).
 *
 * Given a value and a predicate that holds on it (`fails`), remove one thing
 * at a time — object-valued keys first (a relation bag, a nested where, a
 * projection), then array items, then primitive keys — and keep the removal
 * whenever the predicate still holds. Every accepted step strictly reduces the
 * node count, so the loop terminates; sites are visited in a fixed order
 * (category, then reverse discovery order), so the result is a function of the
 * input and the predicate alone.
 */
import type { GeneratedPayload } from "./generate";

export type ShrinkPredicate<T> = (candidate: T) => boolean;

export interface ShrinkResult<T> {
  readonly value: T;
  /** Accepted removals. */
  readonly steps: number;
  /** Predicate evaluations. */
  readonly attempts: number;
}

type PathSegment = string | number;

interface Site {
  readonly path: readonly PathSegment[];
  /** 0: object-valued key, 1: array item, 2: primitive key. */
  readonly category: 0 | 1 | 2;
  readonly depth: number;
  readonly order: number;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isContainer = (value: unknown): boolean =>
  Array.isArray(value) || isPlainRecord(value);

function collectSites(
  value: unknown,
  path: readonly PathSegment[],
  depth: number,
  out: Site[]
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const itemPath = [...path, index];
      out.push({ path: itemPath, category: 1, depth, order: out.length });
      collectSites(value[index], itemPath, depth + 1, out);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const key of Object.keys(value)) {
    const member = value[key];
    const memberPath = [...path, key];
    out.push({
      path: memberPath,
      category: isContainer(member) ? 0 : 2,
      depth,
      order: out.length,
    });
    collectSites(member, memberPath, depth + 1, out);
  }
}

/**
 * One pass tries every site of one category in REVERSE discovery order:
 * descendants before their ancestors, later array items before earlier ones.
 * A removal then never invalidates the path of a site still to be tried, so a
 * pass is a single sweep — no restart after an accepted step.
 */
const passOrder = (
  sites: readonly Site[],
  category: Site["category"]
): Site[] => sites.filter((site) => site.category === category).reverse();

const CATEGORIES: readonly Site["category"][] = [0, 1, 2];

/** A copy of `value` without the node at `path`; untouched subtrees are shared. */
function removeAt(value: unknown, path: readonly PathSegment[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(value)) {
    if (typeof head !== "number") return value;
    return rest.length === 0
      ? value.filter((_, index) => index !== head)
      : value.map((item, index) =>
          index === head ? removeAt(item, rest) : item
        );
  }
  if (!isPlainRecord(value) || typeof head !== "string") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === head) {
      if (rest.length > 0) out[key] = removeAt(value[key], rest);
      continue;
    }
    out[key] = value[key];
  }
  return out;
}

function removeFromRecord(
  value: Record<string, unknown>,
  path: readonly PathSegment[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const [head, ...rest] = path;
  for (const key of Object.keys(value)) {
    if (key === head) {
      if (rest.length > 0) out[key] = removeAt(value[key], rest);
      continue;
    }
    out[key] = value[key];
  }
  return out;
}

/**
 * `subject` is the tree the sites are enumerated on (the payload's `args`);
 * `remove` rebuilds the carrier without the node at a path. A step is accepted
 * only when the predicate holds AND the subject actually lost a node, so a
 * removal that missed (a stale path) can never count as progress.
 */
function shrinkLoop<T>(
  initial: T,
  subject: (value: T) => unknown,
  remove: (current: T, path: readonly PathSegment[]) => T,
  fails: ShrinkPredicate<T>,
  maxAttempts: number
): ShrinkResult<T> {
  let current = initial;
  let size = nodeCount(subject(current));
  let steps = 0;
  let attempts = 0;
  let progressed = true;
  // Rounds repeat while a sweep still removed something: a node refused early
  // in a round may be removable once its neighbours are gone. Every accepted
  // step removes at least one node, so the rounds are bounded by the size.
  while (progressed && attempts < maxAttempts) {
    progressed = false;
    for (const category of CATEGORIES) {
      const sites: Site[] = [];
      collectSites(subject(current), [], 0, sites);
      for (const site of passOrder(sites, category)) {
        if (attempts >= maxAttempts) break;
        attempts++;
        const candidate = remove(current, site.path);
        const candidateSize = nodeCount(subject(candidate));
        if (candidateSize < size && fails(candidate)) {
          current = candidate;
          size = candidateSize;
          steps++;
          progressed = true;
        }
      }
    }
  }
  return { value: current, steps, attempts };
}

/** Shrink any JSON-like value (plain objects, arrays, leaves of any type). */
export function shrinkValue(
  value: unknown,
  fails: ShrinkPredicate<unknown>,
  maxAttempts = 50_000
): ShrinkResult<unknown> {
  return shrinkLoop(value, (current) => current, removeAt, fails, maxAttempts);
}

/** Shrink a payload's `args`; model and operation are fixed. */
export function shrinkPayload(
  payload: GeneratedPayload,
  fails: ShrinkPredicate<GeneratedPayload>,
  maxAttempts = 50_000
): ShrinkResult<GeneratedPayload> {
  return shrinkLoop(
    payload,
    (current) => current.args,
    (current, path) => ({
      ...current,
      args: removeFromRecord(current.args, path),
    }),
    fails,
    maxAttempts
  );
}

/** Node count of a JSON-like value — the measure every accepted step reduces. */
export function nodeCount(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce<number>((sum, item) => sum + nodeCount(item), 0);
  }
  if (!isPlainRecord(value)) return 1;
  let sum = 1;
  for (const key of Object.keys(value)) sum += nodeCount(value[key]);
  return sum;
}
