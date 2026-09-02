/**
 * Step ids for the pattern engine (pattern-engine-ideal-state.md §12.3, unit E).
 *
 * The pinned id scheme is a LABEL per statement plus a per-label counter: the
 * first use of a label is the label itself, the n-th repeat is `label#n`. That
 * is exactly the behavior of the write engine's `StepScope`, reproduced here so
 * the engine that replaces it keeps every pinned id (`tag.find#1`) without
 * importing the seam it deletes.
 *
 * Labels are allocated in PAYLOAD ORDER by the packer's pre-pass; the order is
 * the contract (§6.2), the spellings are the table below.
 */
export class StepIds {
  private readonly used = new Map<string, number>();

  allocate(label: string): string {
    const count = this.used.get(label) ?? 0;
    this.used.set(label, count + 1);
    return count === 0 ? label : `${label}#${count}`;
  }
}

/**
 * The label inventory the packer reproduces. Every spelling here is one the
 * current Parts allocate (`grep "scope.allocate(" src/query-engine`); the packer
 * calls them in the same order the Parts' constructors did.
 */
export const stepLabels = {
  /** Root operations (`UpdateOperation`, `DeleteOperation`, `CreateOperation`). */
  locate: (name: string) => `${name}.locate`,
  update: (name: string) => `${name}.update`,
  create: (name: string) => `${name}.create`,
  delete: (name: string) => `${name}.delete`,
  select: (name: string) => `${name}.select`,
  guardExists: (name: string) => `${name}.guard.exists`,
  /** Nested targets (`RelationLinkPart`, `RelationJunctionPart`, the record compilers). */
  find: (child: string) => `${child}.find`,
  connect: (child: string) => `${child}.connect`,
  disconnect: (child: string) => `${child}.disconnect`,
  deleteChild: (child: string) => `${child}.delete.child`,
  junctionInsert: (child: string) => `${child}.junction.insert`,
  junctionDelete: (child: string) => `${child}.junction.delete`,
  setClear: (child: string) => `${child}.set.clear`,
  setInsert: (child: string) => `${child}.set.insert`,
  guardOccupied: (child: string) => `${child}.guard.occupied`,
  guardDeparting: (child: string) => `${child}.departing`,
  slotOwners: (child: string) => `${child}.slot.owners`,
} as const;
