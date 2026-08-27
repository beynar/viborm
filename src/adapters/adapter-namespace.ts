// The adapter's namespace fact, installed once.
//
// `readonly` is a compile-time claim, and query rendering, migrations, cache
// scope and instrumentation all read this one object at execution time. The
// property is therefore installed as an own, non-writable, non-configurable
// value: hostile JavaScript that binds a cache scope and then rewrites the
// qualifier before the statement runs fails at the assignment instead.
//
// The whole adapter is deliberately NOT frozen — drivers still replace the
// `vector` and `geospatial` members after construction.

import { type NamespaceDialect, normalizeNamespace } from "@schema/identifier";

/**
 * Validate one constructor argument and install it. `undefined` installs an
 * immutable absence, which is what an unbound MySQL adapter means.
 */
export function installAdapterNamespace(
  adapter: object,
  namespace: unknown,
  dialect: NamespaceDialect
): void {
  Object.defineProperty(adapter, "namespace", {
    value:
      namespace === undefined
        ? undefined
        : normalizeNamespace(namespace, dialect),
    writable: false,
    enumerable: true,
    configurable: false,
  });
}
