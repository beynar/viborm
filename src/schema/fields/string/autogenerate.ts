import { monotonicFactory } from "ulidx";
import { nanoid } from "nanoid";
import { createId as cuid } from "@paralleldrive/cuid2";
const ulidFactory = monotonicFactory();

export const defaultUuid = (prefix?: string) => () => {
  return prefix ? `${prefix}-${crypto.randomUUID()}` : crypto.randomUUID();
};

export const defaultUlid = (prefix?: string) => () => {
  return prefix ? `${prefix}-${ulidFactory()}` : ulidFactory();
};

export const defaultNanoid = (length?: number, prefix?: string) => () => {
  return prefix ? `${prefix}-${nanoid(length)}` : nanoid(length);
};

export const defaultCuid = (prefix?: string) => () => {
  return prefix ? `${prefix}-${cuid()}` : cuid();
};
