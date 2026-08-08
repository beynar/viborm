import type { WithCacheOptions } from "@src/cache";

const cacheOptions: WithCacheOptions = { ttl: "5 seconds", bypass: true };

// @ts-expect-error - the typo is refused beside a valid cache option
const refusedOptions: WithCacheOptions = { bypass: true, bypas: true };

void cacheOptions;
void refusedOptions;
