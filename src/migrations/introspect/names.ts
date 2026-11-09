/**
 * Document keys from database names.
 *
 * A database name is kept as the key whenever it is a schema identifier; only a
 * name that is not one gets a derived key, and the model or field then carries
 * the real name (`table` / `column`). Every derivation is deterministic: the
 * same database gives the same document.
 */

import { isValidSchemaIdentifier } from "../../schema/identifier";

/** F010's reserved member names: a column may not take them as its key. */
const RESERVED_MEMBERS = new Set(["_count", "_distance"]);

const INVALID_CHARACTER = /[^a-zA-Z0-9_]/g;
const LEADING_DIGIT = /^[0-9]/;

/** The key a database name would take if it were free. */
function keyCandidate(name: string): string {
  let key = name.replace(INVALID_CHARACTER, "_");
  if (key === "" || LEADING_DIGIT.test(key)) key = `_${key}`;
  return key.slice(0, 60);
}

/** One namespace of keys: a document's models, or one model's members. */
export class KeyAllocator {
  readonly #taken = new Set<string>();

  constructor(private readonly reserved: ReadonlySet<string> = new Set()) {}

  has(key: string): boolean {
    return this.#taken.has(key);
  }

  #free(key: string): boolean {
    return (
      !(this.#taken.has(key) || this.reserved.has(key)) &&
      isValidSchemaIdentifier(key)
    );
  }

  /**
   * The database name itself when it is a free identifier, else the first free
   * of its sanitized spelling and that spelling suffixed `_2`, `_3` …
   */
  claimName(name: string): string {
    if (this.#free(name)) {
      this.#taken.add(name);
      return name;
    }
    return this.claim(keyCandidate(name));
  }

  /** `base`, else `base_2`, `base_3` … — the first that is free. */
  claim(base: string): string {
    const root = keyCandidate(base);
    let key = root;
    for (let n = 2; !this.#free(key); n++) key = `${root}_${n}`;
    this.#taken.add(key);
    return key;
  }
}

/** A member allocator: model members may not take F010's reserved names. */
export function memberAllocator(): KeyAllocator {
  return new KeyAllocator(RESERVED_MEMBERS);
}

const SNAKE_ID_SUFFIX = /^(.+)_id$/i;
const CAMEL_ID_SUFFIX = /^(.*[a-z0-9])I[dD]$/;

/**
 * The relation name a single foreign-key column suggests: `author_id` and
 * `authorId` both suggest `author`. Anything else suggests nothing, and the
 * caller falls back on the target's key.
 */
export function relationNameFromColumn(column: string): string | undefined {
  const match = SNAKE_ID_SUFFIX.exec(column) ?? CAMEL_ID_SUFFIX.exec(column);
  return match?.[1];
}
