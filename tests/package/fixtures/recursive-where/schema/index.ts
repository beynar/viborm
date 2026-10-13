import { accessSchema } from "./access";
import { contentSchema } from "./content";
import { identitySchema } from "./identity";
import { integrationsSchema } from "./integrations";

export const schema = {
  ...identitySchema,
  ...contentSchema,
  ...integrationsSchema,
  ...accessSchema,
};
