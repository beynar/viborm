import type { WithCacheOptions } from "@cache/schema";

const cacheOptions: WithCacheOptions = { ttl: "5 seconds", bypass: true };

// @ts-expect-error - the typo is refused beside a valid cache option
const refusedOptions: WithCacheOptions = { bypass: true, bypas: true };

export { cacheOptions, refusedOptions };
