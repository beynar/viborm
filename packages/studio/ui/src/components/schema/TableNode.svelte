<script lang="ts" module>
import type { StudioModel } from "../../lib/api";

export type TableData = {
  model: StudioModel;
  /** The anchors lines leave from, and those they reach. */
  sources: ReadonlySet<string>;
  targets: ReadonlySet<string>;
  /** Column name → the model it holds a key of. */
  pointing: ReadonlyMap<string, string>;
};
</script>

<script lang="ts">
  import { Handle, type Node, type NodeProps, Position } from '@xyflow/svelte'
  import { fingerprintIcon } from 'entasis/icons/fingerprint'
  import { keyIcon } from 'entasis/icons/key'
  import { linkSimpleIcon } from 'entasis/icons/linkSimple'
  import { tooltip } from 'entasis/tooltip'
  import { CARD_HEADER, CARD_ROW, CARD_WIDTH, columnAnchor, handleOf, relationAnchor } from '../../lib/diagram'
  import { TYPE_ICONS } from '../../lib/icons'
  import { MODEL_ICON } from '../../lib/model-icons'
  import { TYPE_LABELS } from '../../lib/values'
  import { modelHref } from '../../router'
  import { useFocus } from './focus.svelte'

  // One model of the diagram, after Pyxel's: its name (a link to its rows), then a row per column — its key (a key), a
  // column that holds a key of another model (a link), its type's icon, its name, a « ? » when a row may leave it
  // empty, a fingerprint when no two rows share its value — then a row per relation. Each row a line meets has an
  // anchor on each side (`RelationEdge`).
  let { data }: NodeProps<Node<TableData>> = $props()
  const focus = useFocus()
  /** Chosen, reached by the chosen relation, beside the chosen model, or faded behind them. */
  const tone = $derived(focus.card(data.model.name))
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

<div class={['card', tone]} style:width="{CARD_WIDTH}px" style:--header="{CARD_HEADER}px" style:--row="{CARD_ROW}px">
  <header>
    <span class="icon" aria-hidden="true">{@render MODEL_ICON[data.model.icon]({ size: 16 })}</span>
    <a class="name nodrag" href={modelHref(data.model.name)}>{data.model.name}</a>
    {#if data.model.table !== data.model.name}
      <span class="table" {@attach tooltip({ content: 'The table in the database' })}>{data.model.table}</span>
    {/if}
  </header>
  <ul>
    {#each data.model.fields as field (field.name)}
      {@const target = data.pointing.get(field.name)}
      <li class:key={field.id}>
        {@render anchors(columnAnchor(field.name))}
        <span class="mark" aria-hidden={!field.id && !target}>
          {#if field.id}
            <span {@attach tooltip({ content: 'Primary key' })}>{@render keyIcon({ size: 14 })}</span>
          {:else if target}
            <span {@attach tooltip({ content: `Holds a key of ${target}` })}>{@render linkSimpleIcon({ size: 14 })}</span>
          {/if}
        </span>
        <span class="type" {@attach tooltip({ content: TYPE_LABELS[field.type] })}>{@render TYPE_ICONS[field.type]({ size: 14 })}</span>
        <span class="field">{field.name}{#if field.list}<span class="optional">[]</span>{/if}{#if field.nullable}<span class="optional" {@attach tooltip({ content: 'Nullable' })}>?</span>{/if}</span>
        {#if field.unique && !field.id}
          <span class="unique" {@attach tooltip({ content: 'Unique: no two rows hold the same value' })}>{@render fingerprintIcon({ size: 14 })}</span>
        {/if}
        <span class="label">{TYPE_LABELS[field.type]}</span>
      </li>
    {/each}
  </ul>
  {#if data.model.relations.length > 0}
    <ul class="relations">
      {#each data.model.relations as relation (relation.name)}
        {@const chosen = focus.model === data.model.name && focus.relation === relation.name}
        <!-- A relation chosen lights its own lines and the cards it reaches. -->
        <li class:chosen data-relation={relation.name}>
          {@render anchors(relationAnchor(relation.name))}
          <button type="button" class="relation nodrag" aria-pressed={chosen} title="Show where {relation.name} leads" onclick={() => focus.chooseRelation(data.model.name, relation.name)}>
            <span class="field">{relation.name}</span>
            <span class="label">{relation.targets.join(' | ')}{relation.cardinality === 'many' ? '[]' : ''}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .card {
    border: 1px solid color-mix(in oklab, var(--color-neutral) 18%, transparent);
    border-radius: 12px;
    background: var(--color-surface);
    font-size: 13px;
    line-height: 18px;
    cursor: pointer;
    transition: opacity 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }
  /* The model chosen, the cards its relation reaches, and the rest, faded behind them. */
  .card.chosen { border-color: var(--color-link); box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-link) 22%, transparent); }
  .card.reached { border-color: color-mix(in oklab, var(--color-link) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-link) 14%, transparent); }
  .card.faded { opacity: 0.35; }
  .relation { all: unset; display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; height: 100%; cursor: pointer; }
  .relation:focus-visible { outline: 2px solid var(--color-link); outline-offset: -2px; border-radius: 4px; }
  .relations li:hover { background: color-mix(in oklab, var(--color-neutral) 5%, transparent); }
  .relations li.chosen { color: var(--color-link); background: color-mix(in oklab, var(--color-link) 9%, transparent); }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--header);
    padding: 0 12px;
    border-bottom: 1px solid color-mix(in oklab, var(--color-neutral) 12%, transparent);
  }
  .icon { display: inline-flex; color: color-mix(in oklab, var(--color-neutral) 60%, transparent); }
  .name { font-size: 15px; font-weight: 600; color: inherit; text-decoration: none; }
  .name:hover { text-decoration: underline; }
  .table { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: color-mix(in oklab, var(--color-neutral) 45%, transparent); }
  ul { list-style: none; margin: 0; padding: 4px 0; }
  ul.relations { border-top: 1px dashed color-mix(in oklab, var(--color-neutral) 12%, transparent); }
  li { position: relative; display: flex; align-items: center; gap: 6px; height: var(--row); padding: 0 12px; }
  li.key { font-weight: 600; }
  .relations li { color: color-mix(in oklab, var(--color-neutral) 60%, transparent); font-style: italic; }
  .mark { display: inline-flex; width: 14px; color: var(--color-link); }
  .type { display: inline-flex; color: color-mix(in oklab, var(--color-neutral) 55%, transparent); }
  .field { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .optional { margin-left: 2px; color: color-mix(in oklab, var(--color-neutral) 45%, transparent); font-weight: 400; }
  .unique { display: inline-flex; color: var(--color-link); }
  .label { margin-left: auto; color: color-mix(in oklab, var(--color-neutral) 45%, transparent); font-size: 11px; font-weight: 400; font-style: normal; white-space: nowrap; }
  /* A row's anchors are where a line meets it: unseen, on its row's edges. */
  .card :global(.svelte-flow__handle.anchor) { width: 1px; height: 1px; min-width: 0; min-height: 0; border: 0; background: transparent; }
</style>
