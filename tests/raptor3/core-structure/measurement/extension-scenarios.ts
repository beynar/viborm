import type { ScenarioDefinition } from "../../harness/protocol";
import { extensionAScenario } from "./extension-a-scenario";
import { extensionBScenario } from "./extension-b-scenario";
import { extensionCompositionScenario } from "./extension-composition-scenario";
import type { ExtensionRecipe } from "./extension-recipes";

export function extensionScenario(recipe: ExtensionRecipe): ScenarioDefinition {
  if (recipe.slice === "a") return extensionAScenario(recipe);
  if (recipe.slice === "b") return extensionBScenario(recipe);
  return extensionCompositionScenario(recipe);
}
