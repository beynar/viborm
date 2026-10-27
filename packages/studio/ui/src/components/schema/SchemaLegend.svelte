<script lang="ts">
import { Button } from "entasis/button";
import { fingerprintIcon } from "entasis/icons/fingerprint";
import { infoIcon } from "entasis/icons/info";
import { keyIcon } from "entasis/icons/key";
import { linkSimpleIcon } from "entasis/icons/linkSimple";
import { Popover } from "entasis/popover";
import { END_LABELS, type End } from "../../lib/diagram";
import { TYPE_ICONS } from "../../lib/icons";
import { TYPE_LABELS } from "../../lib/values";
import SchemaMarkers from "./SchemaMarkers.svelte";

// What the diagram's marks mean, behind « Legend » (Pyxel's `SchemaLegend`): a column's marks, the types, then the
// relations, a line each, and what each end of a line stands for.
const uid = $props.id();
const markers = `legend-${uid}`;
const ENDS: End[] = ["one", "zero-or-one", "zero-or-many"];
const TYPES = Object.entries(TYPE_ICONS).filter(
  ([type]) => type !== "bigint" && type !== "decimal" && type !== "time"
) as [keyof typeof TYPE_ICONS, (typeof TYPE_ICONS)[keyof typeof TYPE_ICONS]][];
</script>

<SchemaMarkers id={markers} />
<Popover position="bottom-end" size="large" theme={{ popover: { size: { large: 'w-[min(24rem,calc(100vw-2rem))] max-w-none p-0' } } }}>
  {#snippet trigger(popover)}
    <Button size="small" variant="outline" prefix={infoIcon} {@attach popover.trigger}>Legend</Button>
  {/snippet}
  <div class="legend" aria-label="Legend">
    <section>
      <h3>Columns</h3>
      <ul class="two">
        <li><span class="glyph link">{@render keyIcon({ size: 14 })}</span>primary key</li>
        <li><span class="glyph link">{@render fingerprintIcon({ size: 14 })}</span>unique</li>
        <li><span class="glyph link">{@render linkSimpleIcon({ size: 14 })}</span>holds a foreign key</li>
        <li><span class="glyph optional">?</span>nullable</li>
      </ul>
    </section>
    <section>
      <h3>Types</h3>
      <ul class="two">
        {#each TYPES as [type, icon] (type)}
          <li><span class="glyph">{@render icon({ size: 14 })}</span>{TYPE_LABELS[type]}</li>
        {/each}
      </ul>
    </section>
    <section>
      <h3>Relations</h3>
      <ul>
        <li>
          <svg class="line" viewBox="0 0 64 20" aria-hidden="true"><path d="M0 10H64" marker-start="url(#{markers}-zero-or-many)" marker-end="url(#{markers}-one)" /></svg>
          <span>one to many <span class="example">· a user, their posts</span></span>
        </li>
        <li>
          <svg class="line" viewBox="0 0 64 20" aria-hidden="true"><path class="dashed" d="M0 10H64" marker-start="url(#{markers}-zero-or-one)" marker-end="url(#{markers}-one)" /></svg>
          <span>one to one <span class="example">· a user, their profile</span></span>
        </li>
        <li>
          <svg class="line" viewBox="0 0 64 20" aria-hidden="true"><path class="dotted" d="M0 10H64" marker-start="url(#{markers}-zero-or-many)" marker-end="url(#{markers}-zero-or-many)" /></svg>
          <span>many to many <span class="example">· posts, tags</span></span>
        </li>
      </ul>
      <h3>Ends</h3>
      <ul>
        {#each ENDS as end (end)}
          <li><svg class="line" viewBox="0 0 64 20" aria-hidden="true"><path d="M0 10H64" marker-end="url(#{markers}-{end})" /></svg>{END_LABELS[end]}</li>
        {/each}
      </ul>
    </section>
  </div>
</Popover>

<style>
  .legend { display: grid; font-size: 12px; color: color-mix(in oklab, var(--color-neutral) 75%, transparent); }
  section { display: grid; gap: 6px; padding: 12px; }
  section + section { border-top: 1px solid color-mix(in oklab, var(--color-neutral) 12%, transparent); }
  h3 { margin: 0; font-size: 11px; font-weight: 500; color: color-mix(in oklab, var(--color-neutral) 55%, transparent); }
  h3:not(:first-child) { margin-top: 6px; }
  ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  ul.two { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 12px; }
  li { display: flex; align-items: center; gap: 8px; min-width: 0; white-space: nowrap; }
  .glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; color: color-mix(in oklab, var(--color-neutral) 55%, transparent); }
  .glyph.link { color: var(--color-link); }
  .glyph.optional { font-size: 13px; font-weight: 600; }
  .line { flex: none; width: 64px; height: 20px; overflow: visible; }
  .line path { stroke: color-mix(in oklab, var(--color-neutral) 55%, transparent); stroke-width: 1.6; fill: none; }
  .line path.dashed { stroke-dasharray: 6 4; }
  .line path.dotted { stroke-dasharray: 2 4; }
  .example { color: color-mix(in oklab, var(--color-neutral) 50%, transparent); }
</style>
