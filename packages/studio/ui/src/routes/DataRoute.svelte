<script lang="ts">
import { searchParams } from "sv-router";
import RowsView from "../components/data/RowsView.svelte";
import { readScope } from "../lib/route-scope";
import { useStudio } from "../lib/studio-context";
import { navigateModel, openView, route } from "../router";

const studio = useStudio();
const model = $derived(
  studio.schema?.models.find((entry) => entry.name === route.params.model)
);
const saved = $derived(
  searchParams.toURLSearchParams().get("view") ?? undefined
);
const opened = $derived(studio.views?.find(saved));
const filter = $derived.by(() => {
  if (saved) return {};
  try {
    return { scope: readScope(searchParams.toURLSearchParams().get("scope")) };
  } catch {
    return { error: "This relation link has an invalid filter." };
  }
});
</script>

{#if studio.schema && studio.views && studio.changes}
  {#if !model}
    <p class="m-0 p-6 text-neutral/60">No model named “{route.params.model}”.</p>
  {:else if saved && !studio.views.loaded}
    <p class="m-0 p-6 text-neutral/60">Loading the view…</p>
  {:else if saved && (!opened || opened.model !== model.name)}
    <p class="m-0 p-6 text-neutral/60">This saved view no longer exists for this model.</p>
  {:else if filter.error}
    <p class="m-0 p-6 text-neutral/60">{filter.error}</p>
  {:else}
    {#key `${route.pathname}?${searchParams.toString()}#${studio.revision}`}
      <RowsView {model} models={studio.schema.models} readonly={studio.schema.readonly} scope={opened?.scope ?? filter.scope} view={opened} views={studio.views} changes={studio.changes} {openView} navigate={navigateModel} />
    {/key}
  {/if}
{/if}
