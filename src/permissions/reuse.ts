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

/** Never freeze application data or change opaque leaves such as Date/Decimal. */
export function immutablePlainCopy<T>(value: T): T | undefined {
  const seen = new Set<object>();
  const plain = (item: unknown): boolean => {
    if (item === null || typeof item !== "object")
      return typeof item !== "function" && typeof item !== "symbol";
    if (seen.has(item)) return true;
    const prototype = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype ||
          !Array.from({ length: item.length }, (_, index) =>
            Object.hasOwn(item, index)
          ).every(Boolean)
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    seen.add(item);
    return Reflect.ownKeys(item).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      return (
        typeof key === "string" &&
        descriptor &&
        "value" in descriptor &&
        (descriptor.enumerable || (Array.isArray(item) && key === "length")) &&
        plain(descriptor.value)
      );
    });
  };
  if (!plain(value)) return;
  let copy: T;
  try {
    copy = structuredClone(value);
  } catch (error) {
    // A Proxy can present a plain descriptor view but cannot be cloned.
    if (error instanceof DOMException && error.name === "DataCloneError")
      return;
    throw error;
  }
  seen.clear();
  const freeze = (item: unknown, original: unknown): void => {
    if (
      item === null ||
      typeof item !== "object" ||
      original === null ||
      typeof original !== "object" ||
      seen.has(item)
    )
      return;
    seen.add(item);
    // structuredClone normalizes null-prototype dictionaries; retain their
    // lookup semantics before freezing our private copy.
    Object.setPrototypeOf(item, Object.getPrototypeOf(original));
    for (const key of Object.keys(item))
      freeze(Reflect.get(item, key), Reflect.get(original, key));
    Object.freeze(item);
  };
  freeze(copy, value);
  return copy;
}
