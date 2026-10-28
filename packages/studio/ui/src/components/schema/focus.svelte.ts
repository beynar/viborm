// What the diagram puts forward: a model chosen (a card clicked), or one of its relations (a relation row clicked).
// The model's lines light up and the cards they reach stay clear; a relation lights up its own lines only and the
// cards it reaches stand out. Everything else fades. Shared by context with the cards and the lines, so choosing
// changes no node and moves no card.
import { getContext, setContext } from "svelte";
import type { Link } from "../../lib/diagram";

export type CardState = "chosen" | "reached" | "near" | "faded" | undefined;
export type LineState = "lit" | "faded" | undefined;

export class SchemaFocus {
  model = $state<string>();
  relation = $state<string>();
  readonly #links: () => readonly Link[];

  constructor(links: () => readonly Link[]) {
    this.#links = links;
  }

  /** The lines put forward: the relation's, else every line that meets the model. */
  readonly lit = $derived.by(() => {
    const { model, relation } = this;
    if (!model) return new Set<string>();
    return new Set(
      this.#links()
        .filter(({ edge }) =>
          relation === undefined
            ? edge.from.model === model || edge.to.model === model
            : (edge.from.model === model && edge.from.relation === relation) ||
              (edge.to.model === model && edge.to.relation === relation)
        )
        .map((link) => link.id)
    );
  });

  /** The models at the other end of the lit lines. */
  readonly reached = $derived.by(() => {
    const ends = new Set<string>();
    for (const link of this.#links()) {
      if (!this.lit.has(link.id)) continue;
      ends.add(link.from === this.model ? link.to : link.from);
      if (link.from === link.to) ends.add(link.from);
    }
    return ends;
  });

  card(model: string): CardState {
    if (!this.model) return undefined;
    if (model === this.model) return "chosen";
    if (!this.reached.has(model)) return "faded";
    return this.relation === undefined ? "near" : "reached";
  }

  line(id: string): LineState {
    if (!this.model) return undefined;
    return this.lit.has(id) ? "lit" : "faded";
  }

  /** A card clicked: chosen, or let go when it already was. */
  chooseModel(model: string): void {
    if (this.model === model && this.relation === undefined)
      return this.clear();
    this.model = model;
    this.relation = undefined;
  }

  /** A relation row clicked: chosen, or back to its model when it already was. */
  chooseRelation(model: string, relation: string): void {
    if (this.model === model && this.relation === relation) {
      this.relation = undefined;
      return;
    }
    this.model = model;
    this.relation = relation;
  }

  clear(): void {
    this.model = undefined;
    this.relation = undefined;
  }
}

const KEY = Symbol("schema-focus");
export const provideFocus = (focus: SchemaFocus) => setContext(KEY, focus);
export const useFocus = () => getContext<SchemaFocus>(KEY);
