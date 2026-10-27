<script lang="ts">
import { AppShell, type AppShellSidebarProps } from "entasis/app-shell";
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { Confirmation } from "entasis/confirmation";
import { databaseIcon } from "entasis/icons/database";
import { graphIcon } from "entasis/icons/graph";
import { sidebarSimpleIcon } from "entasis/icons/sidebarSimple";
import { tableIcon } from "entasis/icons/table";
import type { SidebarApi } from "entasis/sidebar";
import { Theme } from "entasis/theme";
import { Toaster, toast } from "entasis/toast";
import { onMount } from "svelte";
import RowsView from "./components/data/RowsView.svelte";
import SchemaDiagram from "./components/schema/SchemaDiagram.svelte";
import ThemeToggle from "./components/ThemeToggle.svelte";
import { loadSchema, type Scope, type StudioSchema } from "./lib/api";

// The studio's frame, entasis's AppShell: the models in its sidebar, then a page — the schema diagram or one model's
// rows — whose title, header actions and footer the page sets itself (`setPageShell`). Where the member is lives in
// the address (`#/schema`, `#/data/<model>?scope=…`), so the browser's back button follows relations back.
let schema = $state<StudioSchema>();
let failure = $state<string>();
let hash = $state(location.hash);
/** Bumped each time the server reloads the config: the open page reads again. */
let revision = $state(0);

onMount(() => {
  const changed = () => (hash = location.hash);
  addEventListener("hashchange", changed);
  loadSchema()
    .then((loaded) => (schema = loaded))
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

type Route =
  | { view: "schema" }
  | { view: "data"; model: string; scope?: Scope };
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
  return {
    view: "data",
    model: decodeURIComponent(parts[1]),
    ...(scope ? { scope } : {}),
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
const sidebar = $derived<AppShellSidebarProps>({
  collapsible: "icon",
  items: [
    {
      items: [
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
        isActive: route.view === "data" && route.model === model.name,
      })),
    },
  ],
  header: brand,
  footer: sidebarFooter,
});
</script>

{#snippet brand(_sidebar: SidebarApi)}
  <div class="flex items-center gap-2 px-2 py-1.5">
    <span class="inline-flex shrink-0">{@render databaseIcon({ size: 18 })}</span>
    <span class="truncate text-[14px] font-semibold">VibORM Studio</span>
    {#if schema}<span class="ml-auto"><Chip size="small" variant="soft">{schema.dialect}</Chip></span>{/if}
  </div>
{/snippet}

{#snippet sidebarFooter(sidebar: SidebarApi)}
  <!-- Two icons: the theme, and the sidebar folded to its icons or unfolded. -->
  <div class="flex flex-wrap items-center gap-1">
    <ThemeToggle />
    <Button size="small" variant="ghost" squared prefix={sidebarSimpleIcon} label={sidebar.open ? 'Collapse the sidebar' : 'Expand the sidebar'} onclick={sidebar.toggle} />
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
          <RowsView model={current} models={schema.models} scope={route.scope} {navigate} />
        {/key}
      {:else}
        <p class="m-0 p-6 text-neutral/60">No model named “{route.model}”.</p>
      {/if}
    </AppShell>
    <Toaster />
    <Confirmation />
  {/snippet}
</Theme>
