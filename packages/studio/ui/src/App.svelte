<script lang="ts">
import { AppShell, type AppShellSidebarProps } from "entasis/app-shell";
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { Confirmation, confirmation } from "entasis/confirmation";
import { bookmarkSimpleIcon } from "entasis/icons/bookmarkSimple";
import { databaseIcon } from "entasis/icons/database";
import { graphIcon } from "entasis/icons/graph";
import { magnifyingGlassIcon } from "entasis/icons/magnifyingGlass";
import { sidebarSimpleIcon } from "entasis/icons/sidebarSimple";
import { tableIcon } from "entasis/icons/table";
import { trashIcon } from "entasis/icons/trash";
import type { SidebarApi } from "entasis/sidebar";
import { Theme } from "entasis/theme";
import { Toaster, toast } from "entasis/toast";
import { onMount } from "svelte";
import ChangesBar from "./components/data/ChangesBar.svelte";
import RowsView from "./components/data/RowsView.svelte";
import Palette from "./components/Palette.svelte";
import SchemaDiagram from "./components/schema/SchemaDiagram.svelte";
import ThemeToggle from "./components/ThemeToggle.svelte";
import { loadSchema, type Scope, type StudioDescription } from "./lib/api";
import { Changes } from "./lib/changes.svelte";
import { type SavedView, Views } from "./lib/views.svelte";

// The studio's frame, entasis's AppShell: the models in its sidebar, then a page — the schema diagram or one model's
// rows — whose title, header actions and footer the page sets itself (`setPageShell`). Where the member is lives in
// the address (`#/schema`, `#/data/<model>?scope=…`, `#/data/<model>?view=<id>`), so the browser's back button
// follows relations back. The views the member saved are listed under the models.
let schema = $state<StudioDescription>();
/** The saved views of the project the studio opened: known once its schema is. */
let views = $state<Views>();
/** The edits stacked until they are saved, across every model's page. */
let changes = $state<Changes>();
/** The ⌘K palette, open. */
let paletteOpen = $state(false);
let failure = $state<string>();
let hash = $state(location.hash);
/** Bumped each time the server reloads the config: the open page reads again. */
let revision = $state(0);

onMount(() => {
  // Back, forward or a typed URL tear the page down under a focused field, which
  // entasis then writes mid-teardown (`state_unsafe_mutation`): blur it first.
  const changed = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    hash = location.hash;
  };
  addEventListener("hashchange", changed);
  loadSchema()
    .then((loaded) => {
      schema = loaded;
      views = new Views(loaded.project);
      changes = new Changes(loaded.project);
    })
    .catch(
      (error) =>
        (failure = error instanceof Error ? error.message : String(error))
    );
  // The server watches the config and the schema it imports: a save reloads them here.
  const events = new EventSource("./api/events");
  events.addEventListener("schema", async () => {
    try {
      schema = await loadSchema();
      revision += 1;
      toast.success({ title: "Schema reloaded" });
    } catch (error) {
      toast.danger({
        title: "The schema could not be read",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });
  events.addEventListener("error", (event) => {
    if (!(event instanceof MessageEvent)) return;
    toast.danger({
      title: "Your config failed to reload",
      description: `${JSON.parse(event.data).message}\nThe previous schema is still served.`,
    });
  });
  return () => {
    removeEventListener("hashchange", changed);
    events.close();
  };
});

$effect(() => views?.follow());

type Route =
  | { view: "schema" }
  | { view: "data"; model: string; scope?: Scope; saved?: string };
const route = $derived.by<Route>(() => {
  const [path = "", query = ""] = hash.slice(1).split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "data" || !parts[1]) return { view: "schema" };
  const encoded = new URLSearchParams(query).get("scope");
  let scope: Scope | undefined;
  try {
    scope = encoded ? JSON.parse(encoded) : undefined;
  } catch {
    scope = undefined;
  }
  const saved = new URLSearchParams(query).get("view");
  return {
    view: "data",
    model: decodeURIComponent(parts[1]),
    ...(scope ? { scope } : {}),
    ...(saved ? { saved } : {}),
  };
});

function navigate(model: string, scope?: Scope) {
  location.hash = `#/data/${encodeURIComponent(model)}${scope ? `?${new URLSearchParams({ scope: JSON.stringify(scope) })}` : ""}`;
}

const current = $derived(
  route.view === "data"
    ? schema?.models.find((model) => model.name === route.model)
    : undefined
);
const viewHref = (view: SavedView) =>
  `#/data/${encodeURIComponent(view.model)}?view=${encodeURIComponent(view.id)}`;
/** The view open, when the address names one of this model's. */
const opened = $derived(
  route.view === "data" && views?.find(route.saved)?.model === route.model
    ? views.find(route.saved)
    : undefined
);
/** The views whose model the schema still has. */
const listed = $derived(
  (views?.list ?? []).filter((view) =>
    schema?.models.some((model) => model.name === view.model)
  )
);

async function removeView(view: SavedView) {
  const { confirmed } = await confirmation({
    title: `Delete the view “${view.name}”?`,
    description: "Only the view goes: the rows stay as they are.",
    confirm: { text: "Delete", color: "danger" },
    cancel: "Cancel",
  });
  if (!confirmed) return;
  const open = opened?.id === view.id;
  views?.remove(view.id);
  if (open) location.hash = `#/data/${encodeURIComponent(view.model)}`;
  toast.success({ title: `The view “${view.name}” was deleted` });
}
const sidebar = $derived<AppShellSidebarProps>({
  collapsible: "icon",
  items: [
    {
      items: [
        {
          label: "Search",
          icon: magnifyingGlassIcon,
          badge: "⌘K",
          onclick: () => (paletteOpen = true),
        },
        {
          label: "Schema",
          href: "#/schema",
          icon: graphIcon,
          isActive: route.view === "schema",
        },
      ],
    },
    {
      label: "Models",
      items: (schema?.models ?? []).map((model) => ({
        label: model.name,
        href: `#/data/${encodeURIComponent(model.name)}`,
        icon: tableIcon,
        isActive:
          route.view === "data" && route.model === model.name && !opened,
      })),
    },
    ...(listed.length
      ? [
          {
            label: "Views",
            items: listed.map((view) => ({
              label: view.name,
              href: viewHref(view),
              icon: bookmarkSimpleIcon,
              badge: view.model,
              tooltip: `${view.name} · ${view.model}`,
              isActive: opened?.id === view.id,
              action: {
                label: `Actions for the view ${view.name}`,
                menu: [
                  {
                    type: "option" as const,
                    title: "Delete view",
                    prefix: trashIcon,
                    color: "danger" as const,
                    onclick: () => removeView(view),
                  },
                ],
              },
            })),
          },
        ]
      : []),
  ],
  header: brand,
  footer: sidebarFooter,
});
</script>

<!-- The studio's name and the database it speaks to, the sidebar's fold beside them. Folded to its icons, the
     sidebar shows the database's icon, which turns into the unfold button under the pointer or the keyboard. -->
{#snippet brand(sidebar: SidebarApi)}
  {#if sidebar.open || sidebar.isMobile}
    <div class="flex items-start gap-2 px-2 py-1">
      <span class="mt-0.5 inline-flex shrink-0">{@render databaseIcon({ size: 18 })}</span>
      <div class="grid min-w-0 flex-1 gap-1">
        <span class="truncate text-[14px] leading-5 font-semibold">VibORM Studio</span>
        {#if schema}<span><Chip size="small" variant="soft">{schema.dialect}</Chip></span>{/if}
      </div>
      <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label="Collapse the sidebar" onclick={sidebar.toggle} />
    </div>
  {:else}
    <div class="group/brand relative mx-auto grid size-8 place-items-center">
      <span class="inline-flex transition-opacity group-focus-within/brand:opacity-0 group-hover/brand:opacity-0">{@render databaseIcon({ size: 18 })}</span>
      <span class="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-focus-within/brand:opacity-100 group-hover/brand:opacity-100">
        <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label="Expand the sidebar" onclick={sidebar.toggle} />
      </span>
    </div>
  {/if}
{/snippet}

{#snippet sidebarFooter(sidebar: SidebarApi)}
  <!-- The theme, light or dark; centred in the rail when the sidebar is folded to its icons. -->
  <div class={['flex items-center gap-1', !(sidebar.open || sidebar.isMobile) && 'justify-center']}>
    <ThemeToggle />
  </div>
{/snippet}

<Theme>
  {#snippet children()}
    <AppShell variant="inset" {sidebar} contentPadding="none" contentWidth="full" title="VibORM Studio">
      {#if failure}
        <p class="m-0 p-6 text-danger">The studio could not read the schema: {failure}</p>
      {:else if !schema}
        <p class="m-0 p-6 text-neutral/60">Loading the schema…</p>
      {:else if route.view === 'schema'}
        <SchemaDiagram {schema} />
      {:else if current}
        {#key `${hash}#${revision}`}
          <RowsView model={current} models={schema.models} readonly={schema.readonly} scope={opened?.scope ?? route.scope} view={opened} views={views!} changes={changes!} openView={view => (location.hash = viewHref(view))} {navigate} />
        {/key}
      {:else}
        <p class="m-0 p-6 text-neutral/60">No model named “{route.model}”.</p>
      {/if}
      {#if changes}<ChangesBar {changes} />{/if}
    </AppShell>
    {#if schema}
      <Palette bind:open={paletteOpen} {schema} {views} {changes} {navigate} go={hash => (location.hash = hash)} />
    {/if}
    <!-- Bottom right: the changes bar holds the bottom centre. -->
    <Toaster position="bottom-right" />
    <Confirmation />
  {/snippet}
</Theme>
