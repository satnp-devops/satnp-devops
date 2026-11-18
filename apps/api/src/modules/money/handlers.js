// Event handlers of the money module. Billing reacts to nothing from other modules yet: deals and
// delivery react to billing's events (payment.succeeded, quote.accepted, agreement.signed...) at
// integration. Handlers added here must be idempotent (jobs retry).
export const moneyEventHandlers = {};
