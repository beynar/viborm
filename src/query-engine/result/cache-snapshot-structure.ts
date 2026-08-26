export class CacheSnapshotFailure extends Error {}

export function failCacheSnapshot(): never {
  throw new CacheSnapshotFailure();
}

export function readSnapshotArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return failCacheSnapshot();
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    keys.length !== length + 1 ||
    keys[length] !== "length"
  ) {
    return failCacheSnapshot();
  }
  const items = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (keys[index] !== key) return failCacheSnapshot();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && "value" in descriptor && descriptor.enumerable)) {
      return failCacheSnapshot();
    }
    items[index] = descriptor.value;
  }
  return items;
}

export function readSnapshotRecord(
  value: unknown,
  allowNullPrototype = false
): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failCacheSnapshot();
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    !(allowNullPrototype && prototype === null)
  ) {
    return failCacheSnapshot();
  }
  const keys = Reflect.ownKeys(value);
  const entries: (readonly [string, unknown])[] = new Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return failCacheSnapshot();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!(descriptor && "value" in descriptor && descriptor.enumerable)) {
      return failCacheSnapshot();
    }
    entries[index] = [key, descriptor.value];
  }
  return entries;
}

export function defineSnapshotProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function withSnapshotObject<T>(
  active: WeakSet<object>,
  value: object,
  read: () => T
): T {
  if (active.has(value)) return failCacheSnapshot();
  active.add(value);
  try {
    return read();
  } finally {
    active.delete(value);
  }
}

export function encodeSnapshotNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return failCacheSnapshot();
  }
  return Object.is(value, -0) ? "-0" : String(value);
}

export function decodeSnapshotNumber(value: unknown): number {
  if (typeof value !== "string") return failCacheSnapshot();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || encodeSnapshotNumber(parsed) !== value) {
    return failCacheSnapshot();
  }
  return parsed;
}

export function encodeSnapshotCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return failCacheSnapshot();
  }
  return String(value);
}

export function decodeSnapshotCount(value: unknown): number {
  const parsed = decodeSnapshotNumber(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return failCacheSnapshot();
  }
  return parsed;
}
