/** Private reuse of pure compilation; caller-owned declarations remain mutable. */
export function declarationRevision(
  roots: readonly object[],
  opaque: ReadonlySet<object>
): (() => boolean) | undefined {
  const nodes: {
    value: object;
    keys: (string | symbol)[];
    values: unknown[];
    enumerable: boolean[];
    prototype: object | null;
  }[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return true;
    if (opaque.has(value) || seen.has(value)) return true;
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype ||
          !Array.from({ length: value.length }, (_, index) =>
            Object.hasOwn(value, index)
          ).every(Boolean)
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const values: unknown[] = [];
    const enumerable: boolean[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !(
          descriptor &&
          "value" in descriptor &&
          Object.is(Reflect.get(value, key), descriptor.value)
        )
      )
        return false;
      values.push(descriptor.value);
      enumerable.push(descriptor.enumerable === true);
      if (!visit(descriptor.value)) return false;
    }
    nodes.push({ value, keys, values, enumerable, prototype });
    return true;
  };
  if (!roots.every(visit)) return;
  return () =>
    nodes.every(({ value, keys, values, enumerable, prototype }) => {
      const current = Reflect.ownKeys(value);
      return (
        Object.getPrototypeOf(value) === prototype &&
        current.length === keys.length &&
        keys.every((key, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return (
            current[index] === key &&
            descriptor &&
            "value" in descriptor &&
            Object.is(descriptor.value, values[index]) &&
            Object.is(Reflect.get(value, key), values[index]) &&
            descriptor.enumerable === enumerable[index]
          );
        })
      );
    });
}

/**
 * A frozen copy of a plain declaration (what `declarationRevision` accepted):
 * records and arrays copied with their keys, order, enumerability and
 * prototype; `opaque` values, functions and anything else kept as they are.
 * A model compiled after the policy is applied reads this copy, so it sees
 * the declaration as it was applied.
 */
export function declarationSnapshot<T>(
  value: T,
  opaque: ReadonlySet<object>
): T {
  const copies = new Map<object, object>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item !== "object" || opaque.has(item))
      return item;
    const prototype = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      return item;
    const known = copies.get(item);
    if (known !== undefined) return known;
    const out: object = Array.isArray(item) ? [] : Object.create(prototype);
    copies.set(item, out);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      Object.defineProperty(out, key, {
        value: copy(descriptor.value),
        enumerable: descriptor.enumerable === true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(out);
  };
  return copy(value) as T;
}

/**
 * Frozen copies of compiled values, one copy per original however many
 * values share it (a target's predicate is inlined wherever it is read), or
 * `undefined` for a value that is not plain data: core reuses the admission
 * of a deeply frozen entry, and never freezes what the caller owns.
 */
export function plainFreezer(): <T>(value: T) => T | undefined {
  const copies = new Map<object, object>();
  const open = new Set<object>();
  const FAIL = Symbol("not plain");
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item !== "object")
      return typeof item === "function" || typeof item === "symbol"
        ? FAIL
        : item;
    const known = copies.get(item);
    if (known !== undefined) return known;
    if (open.has(item)) return FAIL;
    const prototype = Object.getPrototypeOf(item);
    const array = Array.isArray(item);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return FAIL;
    open.add(item);
    try {
      const out: Record<string | number, unknown> = array
        ? []
        : Object.create(prototype);
      for (const key of Reflect.ownKeys(item)) {
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (
          typeof key !== "string" ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          return FAIL;
        const value = copy(descriptor.value);
        if (value === FAIL) return FAIL;
        // Defined, never assigned: a key spelled `__proto__` stays a key.
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      if (
        array &&
        (out as unknown as unknown[]).length !== (item as unknown[]).length
      )
        return FAIL;
      Object.freeze(out);
      copies.set(item, out);
      return out;
    } finally {
      open.delete(item);
    }
  };
  return <T>(value: T) => {
    const result = copy(value);
    return result === FAIL ? undefined : (result as T);
  };
}
