/**
 * Corrupt Endpoint - This file intentionally has errors for testing isolation.
 *
 * This demonstrates that faulty functions don't crash the entire runtime.
 * The runtime should log an error and skip this file, allowing other
 * functions to work normally.
 */

// Intentional duplicate handler registration error
import { http } from "@edge-connector/sdk";

export default http()
  .get(() => new Response("first"))
  .get(() => new Response("second - DUPLICATE!")); // This will throw DUPLICATE_HANDLER
