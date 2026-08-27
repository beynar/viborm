// Records keyed by DATA.
//
// A schema is built from maps whose keys come from somewhere else: a model
// shape's field key, a document's model/field/variant key, an enum reference, a
// default's own object keys. `record[key] = value` is not a safe way to build
// such a map, because `__proto__` is an accessor on `Object.prototype`:
// assigning through it sets a prototype and creates NO own key. The entry
// disappears, and what is left is a well-formed object, so nothing downstream
// can notice the loss.
//
// Reading has the mirror problem: `record[key]` resolves inherited members, so
// a data key of `__proto__`, `constructor` or `toString` answers something the
// map never held.
//
// One owner for both, used everywhere a key comes from data — the JSON
// document's maps and `s.model(...)`'s classified member maps alike. It carries
// no refusal: whether a key is a legal identifier is `isValidSchemaIdentifier`'s
// question, asked at hydration and by the document reader, and the answer is the
// same whichever way the key was written. The document READER needs neither
// helper, because it asks that question before anything is written.

/** A map with no inherited members, so a data key can only find what was put. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null);
}

/** Write one own key, whatever it is called. */
export function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Read one own key, or nothing. */
export function own<T>(
  source: Record<string, T> | undefined,
  key: string
): T | undefined {
  if (source === undefined || !Object.hasOwn(source, key)) return;
  return source[key];
}
