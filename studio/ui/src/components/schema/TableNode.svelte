<script lang="ts" module>
import type { StudioModel } from "../../lib/api";

export type TableData = {
  model: StudioModel;
  /** The anchors lines leave from, and those they reach. */
  sources: ReadonlySet<string>;
  targets: ReadonlySet<string>;
  /** Column name → the model it holds a key of. */
  pointing: ReadonlyMap<string, string>;
  open: (model: string) => void;
};
</script>

<script lang="ts">
  import { Handle, type Node, type NodeProps, Position } from '@xyflow/svelte'
  import { CARD_HEADER, CARD_ROW, CARD_WIDTH, columnAnchor, handleOf, relationAnchor } from '../../lib/diagram'
  import { typeLabel } from '../../lib/values'
  import Icon from '../Icon.svelte'

  // One model of the diagram: its name (a link to its rows), then a row per column — its key, a column that holds a
  // key of another model (a link), a fingerprint when no two rows share its value, its type — then a row per relation.
  // Each row a line meets has an anchor on each side (`RelationEdge`).
  let { data }: NodeProps<Node<TableData>> = $props()
</script>

{#snippet anchors(anchor: string)}
  {#if data.sources.has(anchor)}
    <Handle type="source" position={Position.Left} id={handleOf(anchor, 'left')} isConnectable={false} class="anchor" />
    <Handle type="source" position={Position.Right} id={handleOf(anchor, 'right')} isConnectable={false} class="anchor" />
  {/if}
  {#if data.targets.has(anchor)}
    <Handle type="target" position={Position.Left} id={handleOf(anchor, 'left')} isConnectable={false} class="anchor" />
    <Handle type="target" position={Position.Right} id={handleOf(anchor, 'right')} isConnectable={false} class="anchor" />
  {/if}
{/snippet}

<div class="card" style:width="{CARD_WIDTH}px" style:--header="{CARD_HEADER}px" style:--row="{CARD_ROW}px">
  <header>
    <span class="icon"><Icon name="table" /></span>
    <button class="name nodrag ghost" title="Browse {data.model.name}" onclick={() => data.open(data.model.name)}>{data.model.name}</button>
    {#if data.model.table !== data.model.name}<span class="table" title="Table">{data.model.table}</span>{/if}
  </header>
  <ul>
    {#each data.model.fields as field (field.name)}
      {@const target = data.pointing.get(field.name)}
      <li class:key={field.id}>
        {@render anchors(columnAnchor(field.name))}
        <span class="mark">
          {#if field.id}
            <span title="Primary key"><Icon name="key" size={14} label="Primary key" /></span>
          {:else if target}
            <span title="Holds a key of {target}"><Icon name="link" size={14} label="Foreign key to {target}" /></span>
          {/if}
        </span>
        <span class="field">{field.name}</span>
        {#if field.unique && !field.id}
          <span class="unique" title="Unique"><Icon name="unique" size={14} label="Unique" /></span>
        {/if}
        <span class="type" class:nullable={field.nullable}>{typeLabel(field)}</span>
      </li>
    {/each}
  </ul>
  {#if data.model.relations.length > 0}
    <ul class="relations">
      {#each data.model.relations as relation (relation.name)}
        <li>
          {@render anchors(relationAnchor(relation.name))}
          <span class="mark"><Icon name="arrow" size={14} /></span>
          <span class="field">{relation.name}</span>
          <span class="type">{relation.targets.join(' | ')}{relation.cardinality === 'many' ? '[]' : ''}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--color-surface);
    font-size: 12.5px;
    line-height: 18px;
    box-shadow: 0 1px 2px color-mix(in oklab, var(--color-neutral) 6%, transparent);
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--header);
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .icon { display: inline-flex; color: var(--muted); }
  .name { height: 26px; padding: 0 4px; font-size: 14px; font-weight: 600; }
  .name:hover { color: var(--color-link); text-decoration: underline; }
  .table { margin-left: auto; font: 11px var(--mono); color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 4px 0; }
  ul.relations { border-top: 1px dashed var(--border); }
  li { position: relative; display: flex; align-items: center; gap: 6px; height: var(--row); padding: 0 12px; }
  li.key { font-weight: 600; }
  .relations li { color: var(--muted); font-style: italic; }
  .mark { display: inline-flex; width: 14px; color: var(--color-link); }
  .relations .mark { color: var(--muted); }
  .field { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .unique { display: inline-flex; color: var(--color-link); }
  .type { margin-left: auto; font: 11px var(--mono); color: var(--muted); white-space: nowrap; font-style: normal; }
  .type.nullable { color: color-mix(in oklab, var(--color-neutral) 40%, transparent); }
  /* A row's anchors are where a line meets it: unseen, on its row's edges. */
  .card :global(.svelte-flow__handle.anchor) { width: 1px; height: 1px; min-width: 0; min-height: 0; border: 0; background: transparent; }
</style>
