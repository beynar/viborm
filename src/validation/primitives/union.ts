import { discardAsyncValidationResult } from "../parse-failure";
import type {
  InferInput,
  InferOutput,
  ValidationIssue,
  ValidationResult,
  VibSchema,
} from "../types";
import { isRecord } from "../value-guards";
import { createSchema, fail } from "./helpers";

// =============================================================================
// Union Schema
// =============================================================================

const ASYNC_REFUSAL: readonly ValidationIssue[] = Object.freeze([
  Object.freeze({ message: "Async schemas are not supported" }),
]);

export type UnionOptions<T extends readonly VibSchema<any, any>[]> = T;

export interface UnionSchema<
  TOptions extends readonly VibSchema<any, any>[],
  TInput = TOptions[number][" vibInferred"]["0"],
  TOutput = InferOutput<TOptions[number]>,
> extends VibSchema<TInput, TOutput> {
  readonly type: "union";
  readonly options: TOptions;
}

/**
 * The tag of a TAGGED union: one key at which every member is an object whose
 * entry is a required literal, each a different one. A value carrying one of
 * those literals was written for that member alone.
 */
interface Tags {
  readonly key: string;
  readonly members: ReadonlyMap<unknown, VibSchema["~standard"]["validate"]>;
}

function tagsOf(options: readonly VibSchema<any, any>[]): Tags | undefined {
  let key: string | undefined;
  const members = new Map<unknown, VibSchema["~standard"]["validate"]>();
  for (const option of options) {
    const {
      type,
      entries,
      options: shape,
    } = option as {
      type?: string;
      entries?: Record<string, unknown>;
      options?: { array?: boolean; omit?: readonly string[] };
    };
    if (type !== "object" || !entries || shape?.array === true) return;
    key ??= Object.keys(entries).find((name) => isLiteral(entries[name]));
    const tag = key === undefined ? undefined : entries[key];
    if (!(isLiteral(tag) && tag.acceptsUndefined !== true)) return;
    if (members.has(tag.value) || shape?.omit?.includes(key!)) return;
    members.set(tag.value, option["~standard"].validate);
  }
  return key === undefined || members.size < 2 ? undefined : { key, members };
}

function isLiteral(
  entry: unknown
): entry is { type: "literal"; value: unknown; acceptsUndefined?: boolean } {
  return isRecord(entry) && entry.type === "literal";
}

type MemberResult = ReturnType<VibSchema["~standard"]["validate"]>;

/** A member's result, an async member's promise being a refusal. */
function settled(result: MemberResult): ValidationResult<unknown> {
  if (!("then" in result)) return result as ValidationResult<unknown>;
  discardAsyncValidationResult(result);
  return { issues: ASYNC_REFUSAL };
}

/** A member's first issue, spelled with its path for a refusal that lists several. */
function describe({ message, path }: ValidationIssue): string {
  return path?.length ? `${path.join(".")}: ${message}` : message;
}

/**
 * Create a union schema that validates against multiple options.
 * Returns the result of the first matching schema.
 *
 * A refusal names the member the value was written for. In a tagged union
 * (every member an object with its own literal at one key) that is the member
 * its tag names, and only that member runs. Otherwise it is the member whose
 * first issue reads DEEPEST into the value (`{ gt: "3" }` is refused at `gt`
 * by the operator object, not at the root by the shorthand). Members that
 * refused equally deep leave no such member, and the refusal lists what each
 * one said, once (one issue, path kept, when they all said the same).
 *
 * @example
 * const stringOrNumber = v.union([v.string(), v.number()]);
 */
export function union<const TOptions extends readonly VibSchema<any, any>[]>(
  options: TOptions
): UnionSchema<TOptions> {
  const validators = options.map((option) => option["~standard"].validate);
  // Read on first use: a union nothing validates through never inspects its
  // members. Members whose entries are still unresolved thunks then read as
  // untagged for good, and the depth rule alone names the member.
  let tags: Tags | undefined | null = null;
  const schema = createSchema<
    InferInput<TOptions[number]>,
    InferOutput<TOptions[number]>
  >("union", (value) => {
    if (tags === null) tags = tagsOf(options);
    const tagged = tags && isRecord(value) && tags.members.get(value[tags.key]);
    if (tagged) {
      return settled(tagged(value)) as ValidationResult<
        InferOutput<TOptions[number]>
      >;
    }
    // Success returns the matching member's result as-is. Nothing about a
    // refusal is allocated until a second member refuses as deep as the first,
    // so the common "first member misses, second matches" pattern stays free.
    let deepest: readonly ValidationIssue[] | undefined;
    let depth = -1;
    let tied: string[] | undefined;

    for (const validate of validators) {
      const result = settled(validate(value));
      if (!result.issues) {
        return result as { value: InferOutput<TOptions[number]> };
      }
      const { issues } = result;
      const reach = issues[0]!.path?.length ?? 0;
      if (reach > depth) {
        deepest = issues;
        depth = reach;
        tied = undefined;
      } else if (reach === depth) {
        const said = describe(issues[0]!);
        tied ??= [describe(deepest![0]!)];
        if (!tied.includes(said)) tied.push(said);
      }
    }

    if (tied && tied.length > 1) return fail(tied.join(", or "));
    return deepest
      ? { issues: deepest }
      : fail("Expected no value: the union has no member");
  }) as UnionSchema<TOptions>;

  (schema as any).options = options;

  return schema;
}
