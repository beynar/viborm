// biome-ignore-all lint/style/useFilenamingConvention: StepScope is the architecture name.
/**
 * Scope-owned step-id allocator (ATOM §1). A single scope hands out every step
 * id in one operation, so two same-model children under one parent cannot
 * collide on a hand-built string id — the collision class V1's `stepId()`
 * counter also closed. A label used once is returned verbatim (readable ids for
 * the common case); a repeated label is disambiguated by a per-label counter.
 */
export class StepScope {
  private readonly used = new Map<string, number>();

  allocate(label: string): string {
    const count = this.used.get(label) ?? 0;
    this.used.set(label, count + 1);
    return count === 0 ? label : `${label}#${count}`;
  }
}
