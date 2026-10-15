import { test } from "node:test";
import { assertEquals, assertRejects } from "../test/assert.ts";
import { generateAccessToken } from "./access-token.ts";

test("generateAccessToken requests a client credentials token from the configured endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, init });

      if (url === "https://identity.example/oauth/token") {
        return Promise.resolve(Response.json({ access_token: "access-token" }));
      }

      return Promise.resolve(new Response(null, { status: 404 }));
    },
  });

  try {
    const accessToken = await generateAccessToken({
      tokenEndpoint: "https://identity.example/oauth/token",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    assertEquals(accessToken, "access-token");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://identity.example/oauth/token");
    assertEquals(calls[0].init?.method, "POST");
    assertEquals(calls[0].init?.headers, {
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const body = calls[0].init?.body as URLSearchParams;
    assertEquals(body.get("grant_type"), "client_credentials");
    assertEquals(body.get("client_id"), "client-id");
    assertEquals(body.get("client_secret"), "client-secret");
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("generateAccessToken rejects token responses without access token", async () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => Promise.resolve(Response.json({})),
  });

  try {
    await assertRejects(
      () =>
        generateAccessToken({
          tokenEndpoint: "https://identity.example/oauth/token",
          clientId: "client-id",
          clientSecret: "client-secret",
        }),
      Error,
      "Access token not found in token response.",
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("generateAccessToken retains original well-known discovery", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push(url);
      if (url === "https://cloud.example/.well-known") {
        return Promise.resolve(
          Response.json({
            auth: { issuer: "https://identity.example/realms/flamox" },
          }),
        );
      }
      if (
        url ===
        "https://identity.example/realms/flamox/protocol/openid-connect/token"
      ) {
        return Promise.resolve(Response.json({ access_token: "discovered" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  });

  try {
    assertEquals(
      await generateAccessToken({
        controlPlaneUrl: "https://cloud.example/",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      "discovered",
    );
    assertEquals(calls, [
      "https://cloud.example/.well-known",
      "https://identity.example/realms/flamox/protocol/openid-connect/token",
    ]);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});
