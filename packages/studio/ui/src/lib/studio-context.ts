import { createContext } from "svelte";
import type { StudioDescription } from "./api";
import type { Changes } from "./changes.svelte";
import type { Queries } from "./queries.svelte";
import type { Views } from "./views.svelte";

/** The persistent app layout owns project state across route changes. */
export const [useStudio, provideStudio] = createContext<{
  readonly schema: StudioDescription | undefined;
  readonly views: Views | undefined;
  readonly queries: Queries | undefined;
  readonly changes: Changes | undefined;
  readonly revision: number;
}>();
