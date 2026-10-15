export type HealthFetch = typeof fetch;

/**
 * Health check script for Docker HEALTHCHECK.
 * Checks if the connector is responding to health endpoint.
 */
export async function checkHealth(
  port = readHealthPort(),
  fetcher: HealthFetch = fetch,
): Promise<number> {
  try {
    const response = await fetcher(`http://localhost:${port}/health`);
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

export function readHealthPort(
  value = process.env["EDGE_CONNECTOR_BIND_PORT"] ?? "8080",
): number {
  return parseInt(value, 10);
}

if (import.meta.main) {
  process.exit(await checkHealth());
}
