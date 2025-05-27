import { z } from "zod/v4";

export const lazy = <T extends z.ZodTypeAny>(schema: T) => {
  return z.lazy(() => schema);
};

const test = z.object({
  get() {
    tests: z.lazy(() => test);
  },
});
