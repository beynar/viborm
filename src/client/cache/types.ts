export type CacheOptions = {
  ttl: number;
};

export interface CacheDriver {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options: CacheOptions) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: (prefix?: string) => Promise<void>;
}
