/**
 * Price-Check Module
 *
 * This module provides AI-powered price verification for KhataPay bills.
 * It compares bill line items against a curated pricebook and flags
 * potential overcharges or suspicious amounts.
 *
 * Usage:
 *   - From Node: Import ScriptedPriceBrain or use the /api/pricecheck endpoint
 *   - From Python: Call the /haggle endpoint with "pricecheck" context, or use the Python agent service
 *   - Re-verify pricebook: Run `npm run verify-prices` (every 10 days)
 */

export { ScriptedPriceBrain, PRICEBOOK } from "../agents/pricecheck_local";
export { verifyPricebook, runPriceVerification } from "./verifyPricebook";