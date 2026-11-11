/**
 * The models a light document (`"light": true`, what
 * `introspectSchema({ light: true })` writes) produced. A light document
 * leaves out what only migrations read, its indexes first, so the migration
 * serializer refuses these models: a push of them would drop every index.
 */
export const lightModels = new WeakSet<object>();
