<script lang="ts">
// The ends of the diagram's lines, in crow's foot notation, as SVG markers the lines name (`RelationEdge`): a bar
// for exactly one, a circle then a bar for zero or one, a circle then a crow's foot for zero or many. Each is drawn
// pointing at its card, and turns to face it at either end of a line.
const { id }: { id: string } = $props();
</script>

<svg class="markers" aria-hidden="true">
  <defs>
    <!-- Each end twice: as the lines are drawn, and lit (a chosen model's or relation's lines). -->
    {#each ['', '-lit'] as tone (tone)}
      <marker id="{id}{tone}-one" class={tone ? 'lit' : undefined} viewBox="0 0 24 20" refX="24" refY="10" markerWidth="24" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M14 3V17M19 3V17" />
      </marker>
      <marker id="{id}{tone}-zero-or-one" class={tone ? 'lit' : undefined} viewBox="0 0 24 20" refX="24" refY="10" markerWidth="24" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <circle cx="8" cy="10" r="4" />
        <path d="M19 3V17" />
      </marker>
      <marker id="{id}{tone}-zero-or-many" class={tone ? 'lit' : undefined} viewBox="0 0 24 20" refX="24" refY="10" markerWidth="24" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <circle cx="6" cy="10" r="4" />
        <path d="M13 10L24 2M13 10H24M13 10L24 18" />
      </marker>
    {/each}
  </defs>
</svg>

<style>
  .markers { position: absolute; width: 0; height: 0; overflow: hidden; }
  path,
  circle {
    fill: var(--color-surface);
    stroke: color-mix(in oklab, var(--color-neutral) 55%, transparent);
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  path { fill: none; }
  .lit path,
  .lit circle { stroke: var(--color-link); stroke-width: 2.2; }
</style>
