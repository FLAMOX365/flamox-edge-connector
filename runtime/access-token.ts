export type AccessTokenOptions = {
  /** Direct OAuth2 token endpoint. Preferred for the managed FLAMOX365 control plane. */
  tokenEndpoint?: string;
  /** Original connector-compatible base URL exposing `.well-known`. */
  controlPlaneUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Timeout in ms for each token-related fetch (default 10s). */
  timeoutMs?: number;
  /** External signal (e.g. shutdown) that aborts the fetches promptly. */
  signal?: AbortSignal;
};

const defaultTokenFetchTimeoutMs = 10_000;

/** Combines the per-fetch timeout with an optional external abort signal. */
function fetchSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

type TokenResponse = {
  access_token?: unknown;
};

type WellKnownConfiguration = {
  auth?: {
    issuer?: unknown;
  };
};

export async function generateAccessToken(
  options: AccessTokenOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultTokenFetchTimeoutMs;
  const tokenEndpoint =
    options.tokenEndpoint ?? (await discoverTokenEndpoint(options, timeoutMs));
  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }),
    signal: fetchSignal(timeoutMs, options.signal),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Failed to obtain access token: ${tokenResponse.statusText}`,
    );
  }

  const tokenData = (await tokenResponse.json()) as TokenResponse;
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("Access token not found in token response.");
  }

  return tokenData.access_token;
}

async function discoverTokenEndpoint(
  options: AccessTokenOptions,
  timeoutMs: number,
): Promise<string> {
  if (!options.controlPlaneUrl) {
    throw new Error(
      "Either tokenEndpoint or controlPlaneUrl must be configured.",
    );
  }
  const wellKnownResponse = await fetch(
    joinUrl(options.controlPlaneUrl, ".well-known"),
    { signal: fetchSignal(timeoutMs, options.signal) },
  );
  if (!wellKnownResponse.ok) {
    throw new Error(
      `Failed to fetch well-known configuration: ${wellKnownResponse.statusText}`,
    );
  }
  const wellKnown = (await wellKnownResponse.json()) as WellKnownConfiguration;
  const issuer =
    typeof wellKnown.auth?.issuer === "string"
      ? wellKnown.auth.issuer
      : undefined;
  if (!issuer) {
    throw new Error(
      "Authentication endpoint not found in well-known configuration.",
    );
  }
  return joinUrl(issuer, "protocol/openid-connect/token");
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}
