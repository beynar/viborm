<script lang="ts">
import QueryPage from "../components/query/QueryPage.svelte";
import { useStudio } from "../lib/studio-context";
import { navigateModel, route } from "../router";

const studio = useStudio();
const saved = $derived(route.params.id);
const opened = $derived(studio.queries?.find(saved));
</script>

{#if !studio.queries?.loaded}
  <p class="m-0 p-6 text-neutral/60">Loading queries…</p>
{:else if saved && !opened}
  <p class="m-0 p-6 text-neutral/60">This saved query no longer exists.</p>
{:else if studio.schema}
  {#if opened && opened.code === undefined && !studio.schema.models.some(model => model.name === opened.model)}
    <p class="m-0 p-6 text-neutral/60">No model named “{opened.model}”.</p>
  {:else}
    {#key `${saved ?? ''}#${studio.revision}`}<QueryPage schema={studio.schema} navigate={navigateModel} queries={studio.queries} saved={opened} />{/key}
  {/if}
{/if}
