/**
 * What a call's values are to the rules that read them, brought by the words
 * that read a call (`arg`, `now`, `when`, `unless`, `provided`) and by
 * `lazy`, so a rule of constant filters carries none of it: each layer's
 * node read per call (`layers.ts`), every call carrying its values beside the
 * shared domain, an argument with a default at its default where the call
 * passes none, and the domain read at the defaults beside the call's own.
 */

import type { Queries } from "@query-engine/raptor3/shared/query";
import type {
  CallRows,
  CallValues,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { memo } from "@query-engine/raptor3/shared/schema";
import type { CallReads } from "./admission";
import type { AdmittedArgs } from "./arguments";
import { layerOf } from "./layers";
import type { PreparedDomain } from "./row-domain";

/** Calls' shared facts, by the value of one closed argument, then the next. */
interface Shared {
  readonly next: Map<unknown, Shared>;
  rows?: CallRows;
}

const NO_VALUES: AdmittedArgs = {};

export const CALL_READS: CallReads = {
  bind(chain, lazy, domain) {
    const read = new Set(chain.rules!.flatMap(({ references }) => references));
    const declared = chain.args?.all ?? [];
    // An entry given lazily may read any argument, known once it is read.
    let fallback: Record<string, unknown> | undefined;
    for (const { name, default: value } of declared)
      if (value !== undefined && (lazy || read.has(name)))
        (fallback ??= {})[name] = value;
    const required: CallValues["required"] = (argument, model) => {
      const on = declared.find(({ name }) => name === argument)?.required;
      return on === true || on?.includes(model) === true;
    };
    /**
     * The arguments the predicates read, where each takes one of closed
     * values (`oneOf`) and none is the instant: calls that pass the same
     * values share one facts object, and so one read view, as many as the
     * values combine. Not where a stamp names one: its call's are its own.
     */
    const closed =
      lazy ||
      chain.stamps?.named === true ||
      ![...read].every((name) =>
        declared.some(
          (argument) => argument.name === name && "oneOf" in argument
        )
      )
        ? undefined
        : [...read];
    const roots = new Map<CallRows, Shared>();
    /**
     * What a call's predicates read: its arguments, each one with a default
     * at it where the call passes none, and, where they differ from the
     * defaults, the defaults too (`CallValues.defaults`).
     */
    const valuesOf = (values: AdmittedArgs | undefined, shared?: true) => {
      let args = values ?? NO_VALUES;
      let departs = false;
      for (const name in fallback)
        if (Object.hasOwn(args, name))
          departs ||= !Object.is(args[name], fallback[name]);
        else args = { ...fallback, ...args };
      const views = shared && new WeakMap<PreparedDomain, Queries>();
      const own: CallValues = {
        args,
        required,
        view: (domain, call) =>
          views
            ? memo(views, domain, () => domain.queries.under(domain, call))
            : domain.queries.under(domain, call),
        ...(departs && {
          defaults: { args: { ...args, ...fallback }, required },
        }),
      };
      return own;
    };
    const own: RowDomain = { ...domain, layered: layerOf };
    return {
      domain: fallback
        ? {
            ...own,
            defaults: {
              ...own,
              layered: (layer, model, predicate) =>
                layerOf(layer, model, predicate, true),
            },
          }
        : own,
      call(facts, values) {
        if (closed === undefined) return { ...facts, values: valuesOf(values) };
        const fresh = (): Shared => ({ next: new Map() });
        let node = memo(roots, facts, fresh);
        // Closed: every name is an argument's, none the instant.
        for (const name of closed)
          node = memo(node.next, values?.[name!], fresh);
        node.rows ??= { ...facts, values: valuesOf(values, true) };
        return node.rows;
      },
    };
  },
};
