/**
 * Lazy record helper for deferred schema construction.
 *
 * Builds a plain object whose properties are memoizing getters: each value is
 * constructed on first read and cached (stable identity) thereafter. Getters
 * are enumerable + configurable, so the object is indistinguishable from an
 * eagerly-built record to consumers (`key in obj`, `Object.keys`, single-key
 * access all behave identically) — the only difference is that a builder that
 * is never read never runs.
 *
 * Used to make model schema construction pay-per-use: a `findUnique` request
 * only builds the whereUnique/select/include schemas it touches, never the
 * create/update/aggregate trees — a large saving on the cold (first-query)
 * path per serverless isolate.
 */
export function lazyRecord<T extends object>(
  builders: {
    [K in keyof T]: () => T[K];
  }
): T {
  const target = {} as T;
  for (const key of Object.keys(builders) as (keyof T)[]) {
    let build: (() => T[keyof T]) | undefined = builders[key];
    let value: T[keyof T];
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (build) {
          value = build();
          build = undefined;
        }
        return value;
      },
    });
  }
  return target;
}

type ScalarSchemas = {
  readonly base: unknown;
  readonly create: unknown;
  readonly update: unknown;
  readonly filter: unknown;
};

type ScalarSchemaBuilders<T extends ScalarSchemas> = {
  readonly base: T["base"];
  readonly create: () => T["create"];
  readonly update: () => T["update"];
  readonly filter: () => T["filter"];
};

type ScalarSchemaRecord<T extends ScalarSchemas> = Pick<
  T,
  "base" | "create" | "update" | "filter"
>;

type LazyState<T> = { build: () => T } | { value: T };

/**
 * Compact lazy storage for the four variants owned by every scalar field.
 *
 * The enumerable accessors reuse shared getter functions instead of allocating
 * a closure per property and field. Each resolved variant drops its factory
 * while unresolved siblings remain lazy.
 */
class LazyScalarSchemas<T extends ScalarSchemas>
  implements ScalarSchemaRecord<T>
{
  readonly base: T["base"];
  declare readonly create: T["create"];
  declare readonly update: T["update"];
  declare readonly filter: T["filter"];
  #create: LazyState<T["create"]>;
  #update: LazyState<T["update"]>;
  #filter: LazyState<T["filter"]>;

  constructor(builders: ScalarSchemaBuilders<T>) {
    this.base = builders.base;
    this.#create = { build: builders.create };
    this.#update = { build: builders.update };
    this.#filter = { build: builders.filter };
    Object.defineProperties(this, {
      create: {
        enumerable: true,
        configurable: true,
        get: LazyScalarSchemas.readCreate,
      },
      update: {
        enumerable: true,
        configurable: true,
        get: LazyScalarSchemas.readUpdate,
      },
      filter: {
        enumerable: true,
        configurable: true,
        get: LazyScalarSchemas.readFilter,
      },
    });
  }

  private static readCreate<T extends ScalarSchemas>(
    this: LazyScalarSchemas<T>
  ): T["create"] {
    if ("value" in this.#create) return this.#create.value;
    const value = this.#create.build();
    this.#create = { value };
    return value;
  }

  private static readUpdate<T extends ScalarSchemas>(
    this: LazyScalarSchemas<T>
  ): T["update"] {
    if ("value" in this.#update) return this.#update.value;
    const value = this.#update.build();
    this.#update = { value };
    return value;
  }

  private static readFilter<T extends ScalarSchemas>(
    this: LazyScalarSchemas<T>
  ): T["filter"] {
    if ("value" in this.#filter) return this.#filter.value;
    const value = this.#filter.build();
    this.#filter = { value };
    return value;
  }
}

export function lazyScalarSchemas<T extends ScalarSchemas>(
  builders: ScalarSchemaBuilders<T>
): ScalarSchemaRecord<T> {
  return new LazyScalarSchemas(builders);
}
