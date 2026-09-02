/**
 * Unit F — how a program's fragments group into members and merge groups.
 *
 * K3 states why a fragment ended (`FragmentBoundary`); the enforcers need the
 * inverse view: which fragments belong to which bulk member, and which
 * fragments a merge root's row count governs. Both are derived here, once, so
 * the transaction enforcer (savepoint per merge group) and the segments
 * enforcer (progress per member) read the same layout.
 *
 * Reading of the boundary kinds, stated once (the report flags it as the one
 * place K3 is ambiguous):
 *
 * - `member(i)` on fragment k: the NEXT fragment is bulk member `i` (row N
 *   must observe row N−1, so the boundary opens at the start of row N). A
 *   fragment before the first member boundary is the capture/prefix.
 * - `mergeOutcome(row)` on fragment k: fragment k's first write is the merge
 *   root; fragments k+1 … up to and including the next fragment whose boundary
 *   is `member` or `end` are its dependents, and run only when the root made a
 *   row.
 * - `executionBinding` cuts a fragment without changing membership.
 */
import { QueryEngineError } from "@errors";
import type { Fragment, Program } from "../fragment";

export interface FragmentPlacement {
  readonly fragment: Fragment;
  readonly index: number;
  /** Bulk member this fragment belongs to, when the program has members. */
  readonly member: number | undefined;
}

export interface MemberGroup {
  readonly fragments: readonly Fragment[];
  /** The skippable merge root's step id, when the group is governed by one. */
  readonly mergeRoot: string | undefined;
  readonly member: number | undefined;
}

export function placements(program: Program): readonly FragmentPlacement[] {
  const placed: FragmentPlacement[] = [];
  let member: number | undefined;
  program.fragments.forEach((fragment, index) => {
    placed.push({ fragment, index, member });
    if (fragment.boundary.kind === "member") {
      member = fragment.boundary.index;
    }
  });
  return placed;
}

export function memberCount(program: Program): number | undefined {
  const indices = new Set<number>();
  for (const fragment of program.fragments) {
    if (fragment.boundary.kind === "member") {
      indices.add(fragment.boundary.index);
    }
  }
  return indices.size === 0 ? undefined : indices.size;
}

/** The first write of a merge-outcome fragment is its root. */
export function mergeRootOf(fragment: Fragment): string {
  const root = fragment.writes.find((step) => step.kind === "write");
  if (!root) {
    throw new QueryEngineError(
      "A merge-outcome fragment carries no write to decide the outcome."
    );
  }
  return root.id;
}

/**
 * Fragments in execution order, grouped so that a merge root and the
 * dependents its row count governs form one group.
 */
export function memberGroups(program: Program): readonly MemberGroup[] {
  const groups: MemberGroup[] = [];
  const placed = placements(program);
  let index = 0;
  while (index < placed.length) {
    const head = placed[index];
    if (!head) break;
    if (head.fragment.boundary.kind !== "mergeOutcome") {
      groups.push({
        fragments: [head.fragment],
        mergeRoot: undefined,
        member: head.member,
      });
      index += 1;
      continue;
    }
    const fragments: Fragment[] = [head.fragment];
    index += 1;
    while (index < placed.length) {
      const next = placed[index];
      if (!next) break;
      fragments.push(next.fragment);
      index += 1;
      const kind = next.fragment.boundary.kind;
      if (kind === "member" || kind === "end") break;
    }
    groups.push({
      fragments,
      mergeRoot: mergeRootOf(head.fragment),
      member: head.member,
    });
  }
  return groups;
}
