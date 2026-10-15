import { accessSchema } from "./access";
import { contentSchema } from "./content";
import { identitySchema } from "./identity";

export const schema = {
  ...identitySchema,
  ...contentSchema,
  ...accessSchema,
};
