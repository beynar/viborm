/**
 * A rule entry's judging keys (`update`, `delete`, `create.check`,
 * `read.fields`, `read.select`, `acyclic`) as the `verbs` entry the rows host
 * reads, their predicates named: a temporary translation, brought by `rule`
 * with what judges rows.
 */
import type { RowsVerbs } from "./controls";
import { Judging } from "./judge-words";
import { hostValue, isPlain, type VerbsTranslation } from "./rows-translation";

type Where = Readonly<Record<string, unknown>>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** One entry's judging keys as a `verbs` entry, its predicates named. */
const verbsOf = (
  entry: Record<string, unknown>,
  scalars: readonly string[],
  lazy: boolean,
  refuse: (problem: string) => never
): RowsVerbs | undefined => {
  const read = isPlain(entry.read) ? entry.read : {};
  const create = isPlain(entry.create) ? entry.create : {};
  const update = isPlain(entry.update) ? entry.update : {};
  const remove = isPlain(entry.delete) ? entry.delete : {};
  const predicates: Record<string, Where> = { "~all": {} };
  const name = (key: string, where: unknown): string => {
    predicates[key] = hostValue(where) as Where;
    return key;
  };
  const judged = (word: unknown, key: string): string | undefined => {
    if (word === undefined) return undefined;
    if (!(word instanceof Judging && word.kind === "check"))
      refuse(`${key} is written check(where)`);
    return name(`~${key}`, word.value);
  };
  const verbs: Mutable<RowsVerbs> = {
    predicates,
    read: lazy && read.where !== undefined ? name("~read", read.where) : "~all",
    update: update.where === undefined ? "~all" : name("~update", update.where),
    delete: remove.where === undefined ? "~all" : name("~delete", remove.where),
  };
  let judges = verbs.update !== "~all" || verbs.delete !== "~all";
  const place = judged(create.check, "create.check");
  if (place !== undefined) verbs.place = place;
  const checked = judged(update.check, "update.check");
  const writes: Record<string, string> = {};
  const moves: Record<string, string> = {};
  if (checked !== undefined)
    for (const field of scalars) moves[field] = checked;
  for (const [field, slot] of Object.entries(
    isPlain(update.fields) ? update.fields : {}
  )) {
    if (!isPlain(slot)) refuse(`update.fields.${field} is { where?, check? }`);
    if (slot.where !== undefined)
      writes[field] = name(`~writes.${field}`, slot.where);
    const own = judged(slot.check, `update.fields.${field}.check`);
    if (own !== undefined)
      moves[field] =
        checked === undefined
          ? own
          : name(`~moves.${field}`, {
              AND: [predicates[checked], predicates[own]],
            });
  }
  if (Object.keys(writes).length > 0) verbs.writes = writes;
  if (Object.keys(moves).length > 0) verbs.moves = moves;
  const reads: Record<string, string> = {};
  for (const [field, word] of Object.entries(
    isPlain(read.fields) ? read.fields : {}
  )) {
    if (!(word instanceof Judging && word.kind === "gate"))
      refuse(`read.fields.${field} is written gate(where)`);
    reads[field] = name(`~gate.${field}`, word.value);
  }
  if (Object.keys(reads).length > 0) verbs.reads = reads;
  for (const [key, word] of Object.entries(
    isPlain(read.select) ? read.select : {}
  )) {
    if (!(word instanceof Judging && word.kind === "facts"))
      refuse(`read.select.${key} is written facts({ … })`);
    if (verbs.evidence !== undefined)
      refuse("read.select holds one projection key");
    const named = word.value as Readonly<Record<string, unknown>>;
    for (const [fact, where] of Object.entries(named)) name(fact, where);
    verbs.evidence = {
      as: key,
      names: Object.keys(named),
      ...(word.ordered && { ordered: true }),
    };
  }
  if (entry.acyclic !== undefined)
    verbs.acyclic = entry.acyclic as RowsVerbs["acyclic"];
  judges ||=
    verbs.place !== undefined ||
    verbs.writes !== undefined ||
    verbs.moves !== undefined ||
    verbs.reads !== undefined ||
    verbs.evidence !== undefined ||
    verbs.acyclic !== undefined ||
    verbs.read !== "~all";
  return judges ? verbs : undefined;
};

/** How `rule` translates an entry's judging keys, eager or given as a function. */
export const verbsTranslation: VerbsTranslation = {
  entry: (entry, scalars, refuse) => verbsOf(entry, scalars, false, refuse),
  lazy: (entry, scalars, refuse) => {
    let resolved: RowsVerbs | undefined;
    return () => {
      if (resolved !== undefined) return resolved;
      const own: unknown = entry();
      if (!isPlain(own))
        return refuse("an entry given as a function returns one");
      for (const key of ["root", "related", "confine"] as const)
        if (own[key] !== undefined)
          refuse(`an entry given as a function holds no ${key}`);
      if (isPlain(own.delete) && own.delete.instead !== undefined)
        refuse("an entry given as a function holds no delete.instead");
      resolved = verbsOf(own, scalars, true, refuse) ?? {
        predicates: { "~all": {} },
        read: "~all",
        update: "~all",
        delete: "~all",
      };
      return resolved;
    };
  },
};
