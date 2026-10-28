import { createRouter } from "sv-router";
import App from "./App.svelte";
import type { Scope } from "./lib/api";
import type { SavedQuery } from "./lib/queries.svelte";
import type { SavedView } from "./lib/views.svelte";
import DataRoute from "./routes/DataRoute.svelte";
import NotFound from "./routes/NotFound.svelte";
import QueryRoute from "./routes/QueryRoute.svelte";
import SchemaRoute from "./routes/SchemaRoute.svelte";

export const {
  p,
  navigate: go,
  isActive,
  route,
} = createRouter({
  layout: App,
  "/": SchemaRoute,
  "/schema": SchemaRoute,
  "/data/:model": DataRoute,
  "/query": QueryRoute,
  "/query/:id": QueryRoute,
  "*": NotFound,
  hooks: {
    beforeLoad({ pathname }) {
      // Commit a focused editor before its page unmounts (including Back/Forward).
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      if (pathname === "/") throw go("/schema", { replace: true });
    },
  },
});

export const modelHref = (model: string) =>
  p("/data/:model", { params: { model } });
export const viewHref = (view: Pick<SavedView, "id" | "model">) =>
  p("/data/:model", {
    params: { model: view.model },
    search: { view: view.id },
  });
export const queryHref = (query: Pick<SavedQuery, "id">) =>
  p("/query/:id", { params: { id: query.id } });
export const navigateModel = (model: string, scope?: Scope) =>
  go("/data/:model", {
    params: { model },
    ...(scope ? { search: { scope: JSON.stringify(scope) } } : {}),
  });
export const openView = (view: Pick<SavedView, "id" | "model">) =>
  go("/data/:model", {
    params: { model: view.model },
    search: { view: view.id },
  });

export const openQuery = (query: Pick<SavedQuery, "id">) =>
  go("/query/:id", { params: { id: query.id } });
