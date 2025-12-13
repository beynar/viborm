import { monotonicFactory } from "ulidx";
import { nanoid } from "nanoid";
import { createId as cuid } from "@paralleldrive/cuid2";

export const defaultUuid = () => {
  return crypto.randomUUID();
};

const ulidFactory = monotonicFactory();
export const defaultUlid = () => ulidFactory();

export const defaultNanoid = (length?: number) => () => nanoid(length);

export const defaultCuid = () => cuid();
