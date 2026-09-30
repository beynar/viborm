import type {
  CallRows,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import type { ResolvedDeletion, ResolvedRows } from "./chain";
import type { AdmittedControls } from "./controls";

type Predicates = ResolvedRows["models"][string][string];

/** One `rows` member: its control, and where each of its modes sits. */
interface BoundRowsMember {
  readonly control: string;
  readonly names: readonly string[];
  readonly modes: ReadonlyMap<unknown, number>;
  readonly fallback: number;
  /** How far one step of this member's mode moves the combination index. */
  readonly stride: number;
}

/**
 * A chain's row facts, resolved once when an extension is applied: one
 * {@link CallRows} per combination of its `rows` members' modes, with and
 * without the tombstones, so a call only looks its facts up.
 */
export interface RowsBinding {
  readonly members: readonly BoundRowsMember[];
  readonly deletion: Readonly<Record<string, ResolvedDeletion>>;
  /** Indexed by mode combination: the call writes tombstones. */
  readonly tombstoning: readonly CallRows[];
  /** Indexed by mode combination: the call deletes physically. */
  readonly physical: readonly CallRows[];
}

const NO_DELETION: Readonly<Record<string, ResolvedDeletion>> = Object.freeze(
  Object.create(null)
);

/** One purpose's predicates per model, for one mode of every member. */
function modelDomain(
  rows: readonly ResolvedRows[],
  modes: readonly string[],
  purpose: keyof Predicates
): ModelDomain {
  const domain = new Map<string, Record<string, unknown>[]>();
  for (const [index, member] of rows.entries()) {
    for (const [model, entry] of Object.entries(member.models)) {
      const where = entry[modes[index]!]?.[purpose];
      if (where === undefined) continue;
      const list = domain.get(model) ?? [];
      list.push(where);
      domain.set(model, list);
    }
  }
  return domain;
}

export function bindRows(
  rows: readonly ResolvedRows[] | undefined,
  deletion: Readonly<Record<string, ResolvedDeletion>> | undefined
): RowsBinding {
  const declared = rows ?? [];
  let stride = 1;
  const members = declared.map((member): BoundRowsMember => {
    const names = Object.keys(Object.values(member.models)[0] ?? {});
    const modes = names.length === 0 ? [member.default] : names;
    const bound = {
      control: member.control,
      names: modes,
      modes: new Map<unknown, number>(
        modes.map((mode, index) => [mode, index])
      ),
      fallback: modes.indexOf(member.default),
      stride,
    };
    stride *= modes.length;
    return bound;
  });
  const domains: RowDomain[] = [];
  for (let combination = 0; combination < stride; combination++) {
    const modes = members.map(
      (member) =>
        member.names[
          Math.floor(combination / member.stride) % member.names.length
        ]!
    );
    domains.push(
      Object.freeze({
        root: modelDomain(declared, modes, "root"),
        related: modelDomain(declared, modes, "related"),
      })
    );
  }
  const defaults =
    domains[
      members.reduce(
        (index, member) => index + member.fallback * member.stride,
        0
      )
    ]!;
  const tombstones =
    deletion === undefined ? undefined : new Map(Object.entries(deletion));
  const physical = domains.map((domain) => Object.freeze({ domain, defaults }));
  return Object.freeze({
    members,
    deletion: deletion ?? NO_DELETION,
    physical,
    tombstoning:
      tombstones === undefined
        ? physical
        : domains.map((domain) =>
            Object.freeze({ domain, defaults, tombstones })
          ),
  });
}

/**
 * One call's row facts, from the controls it admitted: the modes its `rows`
 * controls chose (an absent one reads as its default), and whether it deletes
 * physically — its model's `deletion` entry names a `removeWhen` the call's
 * controls match. That control is placed only on the deletes of the models
 * the entry manages, so no other call can match it.
 */
export function callRows(
  binding: RowsBinding,
  model: string,
  controls: AdmittedControls | undefined
): CallRows {
  let combination = 0;
  for (const member of binding.members) {
    combination +=
      member.stride *
      (member.modes.get(controls?.[member.control]) ?? member.fallback);
  }
  const removeWhen = binding.deletion[model]?.removeWhen;
  const physical =
    removeWhen !== undefined &&
    Object.entries(removeWhen).every(
      ([control, value]) => controls?.[control] === value
    );
  return (physical ? binding.physical : binding.tombstoning)[combination]!;
}
