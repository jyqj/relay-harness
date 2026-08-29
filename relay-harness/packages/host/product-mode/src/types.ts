/** Shared product-mode wire vocabulary. */
/** Shared ordinary-user or advanced-developer presentation mode. */
export type ProductMode = 'simple' | 'developer'
/** Current resolved product mode. */
export interface ProductModeSnapshot { readonly mode: ProductMode }
/** Request to persist one explicit product mode. */
export interface ProductModeSetRequest { readonly mode: ProductMode }
