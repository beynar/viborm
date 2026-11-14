/**
 * The words of a rule that judge rows: `check` (the row a write leaves must
 * hold a predicate), `gate` (a field is present only where a predicate
 * holds), `facts` (per row, which named predicates hold, under a projection
 * key) and `keep` (a delete updates the row instead). Plain data the rule's
 * part reads where the extension is applied.
 */
import { isPlainRecord } from "@schema/relation/terminal";
import type { ExtensionPart } from "./chain";
import type { CheckWord, FactsWord, GateWord, KeepWord } from "./contract";
import type { DeletionContribution } from "./controls";
import type { DefinitionDraft } from "./extension";
import { keptRowsPart } from "./kept";
import { ArgTestFilter, ArgValue, NowValue, RowValue } from "./rule-words";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const isPlain = isPlainRecord;

/** What one judging word holds. */
export class Judging {
  readonly kind: "check" | "gate" | "facts";
  readonly value: unknown;
  readonly ordered: boolean;
  constructor(
    kind: "check" | "gate" | "facts",
    value: unknown,
    ordered = false
  ) {
    this.kind = kind;
    this.value = value;
    this.ordered = ordered;
  }
}

/** The row a write leaves (or creates) must hold `where`. */
export function check<W>(where: NoInfer<W>): CheckWord<W>;
export function check(where: object): unknown {
  return new Judging("check", where);
}

/**
 * The field is present where `where` holds, absent elsewhere, and read as
 * `NULL` by every operand a call writes over it.
 */
export function gate<W>(where: NoInfer<W>): GateWord<W>;
export function gate(where: object): unknown {
  return new Judging("gate", where);
}

/**
 * Per row, whether each named predicate holds: a `select` or `include`
 * naming the key reads them. `ordered`: the last name that holds, or `null`.
 */
export function facts<
  const Names extends string,
  Ordered extends boolean = false,
>(
  predicates: Readonly<Record<Names, object>>,
  options?: { readonly ordered?: Ordered }
): FactsWord<Names, Ordered>;
export function facts(
  predicates: Readonly<Record<string, object>>,
  options?: { readonly ordered?: boolean }
): unknown {
  return new Judging("facts", predicates, options?.ordered === true);
}

/** The delete updates the row with `data` instead of removing it. */
export function keep<D>(data: D): KeepWord<D>;
export function keep(data: object): unknown {
  return new Kept(data, keptRowsPart);
}

/** What a delete of one model writes instead, written where its rule is applied. */
export interface KeepTarget {
  readonly model: string;
  readonly args: DefinitionDraft["args"];
  /** The extension's deletion member, made at its first `keep`. */
  readonly deletion: () => Mutable<DeletionContribution>;
  readonly refuse: (problem: string) => never;
}

/** `keep(data)`'s value: it writes the deletion member the rows host reads. */
export class Kept {
  readonly data: unknown;
  /** What keeps deleted rows: brought by `keep` itself. */
  readonly host: ExtensionPart;
  constructor(data: unknown, host: ExtensionPart) {
    this.data = data;
    this.host = host;
  }
  write(target: KeepTarget): void {
    keepInto(target, this.data);
  }
}

function keepInto(
  { model, args, deletion: made, refuse }: KeepTarget,
  given: unknown
): void {
  let data = given;
  let removeWhen: Record<string, string | number | boolean> | undefined;
  if (data instanceof ArgTestFilter && data.kind !== "provided") {
    const { arg, test } = data;
    const spec = args?.[arg.name];
    const values =
      spec !== undefined && "oneOf" in spec ? spec.oneOf : undefined;
    const removes =
      data.kind === "unless"
        ? test
        : values?.length === 2
          ? values.find((value) => value !== test)
          : undefined;
    if (
      arg.path !== undefined ||
      (typeof removes !== "string" &&
        typeof removes !== "number" &&
        typeof removes !== "boolean")
    )
      throw refuse("keep() takes data, or unless(arg(name), value, data)");
    removeWhen = { [arg.name]: removes };
    data = data.then;
  }
  if (!isPlain(data))
    throw refuse("keep() takes the data the row is updated with");
  let at: string | undefined;
  const assign: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value instanceof NowValue) {
      if (at !== undefined) refuse("keep() writes now in one field");
      at = field;
    } else if (value instanceof ArgValue || value instanceof RowValue)
      refuse("keep() writes constants and now");
    else assign[field] = value;
  }
  const deletion = made();
  if (removeWhen !== undefined) {
    if (
      deletion.removeWhen !== undefined &&
      JSON.stringify(deletion.removeWhen) !== JSON.stringify(removeWhen)
    )
      refuse("one extension's keep() parts name the same physical delete");
    deletion.removeWhen = removeWhen;
  }
  (deletion.models as Record<string, object>)[model] = {
    ...(at === undefined ? {} : { at }),
    assign,
  };
}
