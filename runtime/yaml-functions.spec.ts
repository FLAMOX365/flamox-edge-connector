import { assertEquals, assertThrows } from "@std/assert";
import { RuntimeError } from "./runtime-error.ts";
import {
  applyYamlRequestTransform,
  applyYamlResponseTransform,
  interpolate,
  type YamlRequestTransformConfig,
  type YamlResponseTransformConfig,
  type YamlTransformContext,
} from "./yaml-functions.ts";

const baseContext: YamlTransformContext = {
  requestId: "test-request-id",
  startedAt: "2024-01-01T00:00:00.000Z",
  request: {
    method: "GET",
    url: "/api/test",
    headers: { "content-type": ["application/json"] },
    body: "test-body",
  },
  env: {
    API_TOKEN: "secret-token",
    TENANT_ID: "tenant-123",
  },
};

Deno.test("interpolate replaces env variables", () => {
  assertEquals(
    interpolate("Bearer {{ env.API_TOKEN }}", baseContext),
    "Bearer secret-token",
  );
});

Deno.test("interpolate replaces context variables", () => {
  assertEquals(
    interpolate("Request: {{ context.requestId }}", baseContext),
    "Request: test-request-id",
  );
});

Deno.test("interpolate replaces request variables", () => {
  assertEquals(
    interpolate(
      "URL: {{ request.url }}, Method: {{ request.method }}",
      baseContext,
    ),
    "URL: /api/test, Method: GET",
  );
});

Deno.test("interpolate handles missing variables gracefully", () => {
  assertEquals(
    interpolate("Value: {{ env.MISSING }}", baseContext),
    "Value: ",
  );
});

Deno.test("YAML request transform adds headers", () => {
  const config: YamlRequestTransformConfig = {
    headers: {
      add: {
        "x-tenant-id": "{{ env.TENANT_ID }}",
        "x-request-id": "{{ context.requestId }}",
      },
    },
  };
  const request = { method: "GET" as const, url: "/test", headers: {} };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.headers?.["x-tenant-id"], ["tenant-123"]);
  assertEquals(result.headers?.["x-request-id"], ["test-request-id"]);
});

Deno.test("YAML request transform removes headers", () => {
  const config: YamlRequestTransformConfig = {
    headers: {
      remove: ["authorization", "x-internal"],
    },
  };
  const request = {
    method: "GET" as const,
    url: "/test",
    headers: {
      "Authorization": ["Bearer token"],
      "X-Internal": ["secret"],
      "Content-Type": ["application/json"],
    },
  };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.headers?.["Authorization"], undefined);
  assertEquals(result.headers?.["X-Internal"], undefined);
  assertEquals(result.headers?.["Content-Type"], ["application/json"]);
});

Deno.test("YAML request transform sets headers", () => {
  const config: YamlRequestTransformConfig = {
    headers: {
      set: {
        "authorization": "Bearer {{ env.API_TOKEN }}",
      },
    },
  };
  const request = {
    method: "GET" as const,
    url: "/test",
    headers: { "authorization": ["old-token"] },
  };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.headers?.["authorization"], ["Bearer secret-token"]);
});

Deno.test("YAML request transform applies URL prefix", () => {
  const config: YamlRequestTransformConfig = {
    url: {
      prefix: "/api/v2",
    },
  };
  const request = { method: "GET" as const, url: "/users" };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.url, "/api/v2/users");
});

Deno.test("YAML request transform applies URL rewrite", () => {
  const config: YamlRequestTransformConfig = {
    url: {
      rewrite: "/internal{{ request.url }}",
    },
  };
  const request = { method: "GET" as const, url: "/users" };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.url, "/internal/users");
});

Deno.test("YAML request transform removes URL prefix", () => {
  const config: YamlRequestTransformConfig = {
    url: {
      removePrefix: "/api",
    },
  };
  const request = { method: "GET" as const, url: "/api/users" };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.url, "/users");
});

Deno.test("YAML request transform rejects with contains condition", () => {
  const config: YamlRequestTransformConfig = {
    reject: {
      if: 'request.url contains "/admin"',
      code: "FORBIDDEN",
      message: "Admin access denied",
    },
  };
  const request = { method: "GET" as const, url: "/admin/users" };

  assertThrows(
    () => applyYamlRequestTransform(config, request, baseContext),
    RuntimeError,
    "Admin access denied",
  );
});

Deno.test("YAML request transform rejects with equals condition", () => {
  const config: YamlRequestTransformConfig = {
    reject: {
      if: 'env.BLOCK_ALL == "true"',
      code: "BLOCKED",
      message: "All requests blocked",
    },
  };
  const context = {
    ...baseContext,
    env: { ...baseContext.env, BLOCK_ALL: "true" },
  };
  const request = { method: "GET" as const, url: "/test" };

  assertThrows(
    () => applyYamlRequestTransform(config, request, context),
    RuntimeError,
    "All requests blocked",
  );
});

Deno.test("YAML request transform passes when condition not met", () => {
  const config: YamlRequestTransformConfig = {
    reject: {
      if: 'request.url contains "/admin"',
      code: "FORBIDDEN",
      message: "Admin access denied",
    },
  };
  const request = { method: "GET" as const, url: "/users" };

  const result = applyYamlRequestTransform(config, request, baseContext);

  assertEquals(result.url, "/users");
});

Deno.test("YAML response transform modifies status code", () => {
  const config: YamlResponseTransformConfig = {
    statusCode: {
      set: 201,
    },
  };
  const response = { statusCode: 200, headers: {}, body: "ok" };

  const result = applyYamlResponseTransform(config, response, baseContext);

  assertEquals(result.statusCode, 201);
});

Deno.test("YAML response transform adds headers", () => {
  const config: YamlResponseTransformConfig = {
    headers: {
      add: {
        "x-processed-by": "flamox-edge-connector",
      },
    },
  };
  const response = { statusCode: 200, headers: {}, body: "ok" };

  const result = applyYamlResponseTransform(config, response, baseContext);

  assertEquals(result.headers?.["x-processed-by"], ["flamox-edge-connector"]);
});

Deno.test("YAML response transform sets body", () => {
  const config: YamlResponseTransformConfig = {
    body: {
      set: '{"wrapped": true, "requestId": "{{ context.requestId }}"}',
    },
  };
  const response = { statusCode: 200, headers: {}, body: "original" };

  const result = applyYamlResponseTransform(config, response, baseContext);

  assertEquals(
    result.body,
    '{"wrapped": true, "requestId": "test-request-id"}',
  );
});
