/**
 * Branded key for type inference.
 * 
 * KEY INSIGHT: ArkType uses a STRING, not a unique symbol.
 * This is: export declare const inferred: " arkInferred";
 * 
 * Using a string literal allows TypeScript's pattern matching
 * to work correctly during circular reference resolution.
 */
export const inferred = " vibInferred" as const;
export type inferred = typeof inferred;
