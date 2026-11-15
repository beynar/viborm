import type {
  CallRows,
  ModelDomain,
  RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import {
  type AdmittedLayer,
  admitLayer,
  type BoundEntries,
  nativeSchema,
  type RuleLayer,
} from "./admission";
import { rebind, refuseUndeclared } from "./call-rows";
import type {
  CallRowsBinding,
  ExtensionPart,
  ResolvedExtensionChain,
} from "./chain";
import { prepareCall } from "./row-domain";

/**
 * One purpose's predicates per model, each at its layer's place in the
 * chain: the layer the engine reads it as.
 */
function modelDomain(
  layers: readonly AdmittedLayer[],
  purpose: "root" | "related",
  lazy: BoundEntries["filters"] | undefined
): ModelDomain {
  const built = new Map<string, readonly Input[] | null>();
  return {
    get: (model) =>
      memo(built, model, () => {
        let list: Input[] | null = null;
        for (const [layer, member] of layers.entries()) {
          // An entry given lazily holds its filters: read it now.
          const filters = member.models[model] ?? lazy?.(model, layer);
          const where = filters?.[purpose];
          if (where !== undefined) (list ??= [])[layer] = where;
        }
        return list;
      }) ?? undefined,
  };
}
/**
 * A chain's row facts, resolved once when an extension is applied: one
 * domain, with the chain's kept rows, stamps and order, so a call only looks
 * its facts up. The predicates hold the values they read as parameters,
 * prepared once for every call: where one of them reads a call value, what
 * the words that read it brought carries each call's values beside the
 * shared domain (`call-values.ts`). Bound for a chain whose parts filter,
 * keep or judge rows.
 */
export function bindRows(chain: ResolvedExtensionChain): CallRowsBinding {
  // Only a rule's layer binds rows (`keep` comes with one).
  const layers = chain.rules!;
  // The entries beyond the filters, where some word brought what binds them.
  const host = layers.find((layer) => layer.host)?.host;
  const {
    lazy = false,
    filters,
    prepare = prepareCall,
    ...entries
  } = host?.bind(chain) ?? {};
  const { kept, stamps, defaultOrder: order } = chain;
  let domain: RowDomain = {
    root: modelDomain(layers, "root", filters),
    related: modelDomain(layers, "related", filters),
    ...entries,
    // Where some layer confines its sets, what `within` brought binds them.
    ...layers.find((layer) => layer.confine)?.brings?.confines?.bind(layers),
    ...(order && { order: new Map(Object.entries(order)) }),
  };
  // Where some predicate reads its call, what the words that read it
  // brought carries each call's values.
  const reads = layers
    .find((layer) => layer.reads)
    ?.reads?.bind(chain, lazy, domain);
  if (reads) domain = reads.domain;
  /** The facts of a call that deletes physically. */
  const physical: CallRows = {
    domain,
    ...(stamps && { stamps: stamps.all }),
    prepare,
  };
  /** The facts of a call whose deletes keep their rows. */
  const tombstoning =
    kept === undefined ? physical : { ...physical, tombstones: kept };
  return {
    /**
     * One call's row facts, from the arguments it admitted, and whether it
     * deletes physically ({@link Kept.removes}); when a stamp names an
     * argument, the call's values are put in.
     */
    call(model, values) {
      let facts =
        kept?.removes(model, values) === true ? physical : tombstoning;
      if (stamps?.named === true)
        facts = { ...facts, stamps: stamps.of(values) };
      return reads?.call(facts, values) ?? facts;
    },
  };
}

/**
 * `rule`: one extension's layer admitted where it is applied, the arguments
 * its predicates read checked against the chain's (an entry given lazily's
 * when it is first read), and the chain's call facts bound again. The layer
 * is the extension's for one schema: admitted once where the schema's
 * scalars admit with the engine's own schemas (a field's own schema may
 * read its value differently on another call).
 */
export function layerPart(layer: RuleLayer): ExtensionPart {
  let native: boolean | undefined;
  let admitted: AdmittedLayer | undefined;
  return {
    join(application) {
      const { name, next, schema, registry } = application;
      const own = admitted ?? admitLayer(layer, schema, name, registry);
      if ((native ??= nativeSchema(schema))) admitted = own;
      refuseUndeclared(application, own.references);
      next.rules = [...(next.rules ?? []), own];
      next.bindRows = bindRows;
    },
    seal(application) {
      rebind(application, bindRows);
    },
  };
}
