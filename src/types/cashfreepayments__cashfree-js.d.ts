/** Minimal types for @cashfreepayments/cashfree-js (1.0.7), which ships none.
 *
 * Deliberately narrow: this declares only the two calls the signup flow makes,
 * so the compiler still catches a typo in them. Widening it to `any` would type
 * the one place where a wrong argument silently means a customer cannot pay. */
declare module "@cashfreepayments/cashfree-js" {
  export interface CashfreeSubscriptionsCheckoutOptions {
    /** subscription_session_id from POST /pg/subscriptions. */
    subsSessionId: string;
    /** "_self" keeps the return inside this tab, which is where UPI and banking
     * apps hand control back. */
    redirectTarget?: "_self" | "_blank" | "_top";
  }

  export interface CashfreeInstance {
    subscriptionsCheckout(options: CashfreeSubscriptionsCheckoutOptions): Promise<unknown>;
  }

  /** Resolves null when the script cannot be fetched. */
  export function load(options: { mode: "sandbox" | "production" }): Promise<CashfreeInstance | null>;
}
