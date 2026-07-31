import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  badRequest,
  conflict,
  createHttpContext,
  defineHttp,
  error,
  forbidden,
  html,
  http,
  type HttpContext,
  type HttpHandler,
  type HttpMethod,
  HttpResponseFactory,
  type HttpRouteDefinition,
  internalServerError,
  isHttpRouteDefinition,
  json,
  noContent,
  notFound,
  proxy,
  redirect,
  RuntimeError,
  status,
  text,
  unauthorized,
  unprocessableEntity,
  upstream,
} from "./mod.ts";

const startedAt = "2026-06-11T00:00:00.000Z";
const silentLogger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

function context(
  request = new Request("https://connector.local/users/42?tag=a&tag=b&page=2", {
    headers: {
      cookie: "session=abc%20123; theme=dark",
      "x-trace": "trace-1",
    },
  }),
  options: {
    env?: Record<string, string>;
    params?: Record<string, string>;
    waitUntil?: (task: Promise<unknown>) => void;
  } = {},
): HttpContext {
  return createHttpContext({
    request,
    params: options.params ?? { id: "42" },
    env: options.env ?? { API_TOKEN: "secret" },
    requestId: "req-1",
    startedAt,
    log: silentLogger,
    waitUntil: options.waitUntil,
  });
}

function handlerFor(
  route: HttpRouteDefinition,
  method: HttpMethod,
): HttpHandler {
  const handler = route.handlers[method];
  assert(
    typeof handler === "function",
    `${method} handler should be registered`,
  );
  return handler;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

async function withMockFetch<T>(
  handler: (input: FetchInput, init: FetchInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    return Promise.resolve(handler(input, init));
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function fetchUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

Deno.test("defineHttp registers functional handlers, all fallback, middleware, and error handling", async () => {
  const calls: string[] = [];
  const route = defineHttp({
    use: [
      async (ctx, next) => {
        calls.push(`before:${ctx.req.method}`);
        const response = await next();
        calls.push(`after:${response.status}`);
        return response;
      },
    ],
    all: (ctx) => ctx.res.ok().text("all"),
    POST: (ctx) => ctx.res.created().text("created"),
    onError: (error, ctx) => {
      assertInstanceOf(error, RuntimeError);
      return ctx.res.status(599).text(error.code);
    },
  });

  assertEquals(route.protocol, "http");
  assert(isHttpRouteDefinition(route));
  assertEquals(await (await handlerFor(route, "GET")(context())).text(), "all");

  const postResponse = await handlerFor(route, "POST")(
    context(new Request("https://connector.local/users", { method: "POST" })),
  );
  assertEquals(postResponse.status, 201);
  assertEquals(await postResponse.text(), "created");
  assertEquals(calls, ["before:GET", "after:200", "before:POST", "after:201"]);

  const failingRoute = defineHttp({
    use: [async (_ctx, next) => {
      await next();
      return await next();
    }],
    get: (ctx) => ctx.res.ok().text("ok"),
    onError: (errorValue, ctx) => {
      assertInstanceOf(errorValue, RuntimeError);
      return ctx.res.status(599).text(errorValue.code);
    },
  });

  const errorResponse = await handlerFor(failingRoute, "GET")(context());
  assertEquals(errorResponse.status, 599);
  assertEquals(await errorResponse.text(), "MIDDLEWARE_ERROR");
});

Deno.test("defineHttp propagates handler errors when no error handler is configured", async () => {
  const route = defineHttp({
    get: () => {
      throw new Error("boom");
    },
  });

  await assertRejects(
    async () => await handlerFor(route, "GET")(context()),
    Error,
    "boom",
  );
});

Deno.test("http fluent builder registers methods and applies middleware", async () => {
  const route = http()
    .use(async (ctx, next) => {
      const response = await next();
      return ctx.res.from(response).header("x-powered-by", "sdk").send();
    })
    .get((ctx) => ctx.res.ok().text(ctx.req.params.require("id")))
    .post((ctx) => ctx.res.created().json({ path: ctx.req.path }))
    .put((ctx) => ctx.res.ok().text(ctx.req.method))
    .patch((ctx) => ctx.res.ok().text(ctx.req.method))
    .delete((ctx) => ctx.res.noContent())
    .head((ctx) => ctx.res.ok().text("hidden"))
    .options((ctx) => ctx.res.ok().text(ctx.req.method));

  assert(isHttpRouteDefinition(route));

  const getResponse = await handlerFor(route, "GET")(context());
  assertEquals(getResponse.headers.get("x-powered-by"), "sdk");
  assertEquals(await getResponse.text(), "42");

  const postResponse = await handlerFor(route, "POST")(
    context(new Request("https://connector.local/users", { method: "POST" }), {
      params: {},
    }),
  );
  assertEquals(postResponse.status, 201);
  assertEquals(await postResponse.json(), { path: "/users" });

  assertEquals(
    await (await handlerFor(route, "PUT")(
      context(
        new Request("https://connector.local/users/42", { method: "PUT" }),
      ),
    )).text(),
    "PUT",
  );
  assertEquals(
    await (await handlerFor(route, "PATCH")(
      context(
        new Request("https://connector.local/users/42", { method: "PATCH" }),
      ),
    )).text(),
    "PATCH",
  );
  assertEquals(
    (await handlerFor(route, "DELETE")(
      context(
        new Request("https://connector.local/users/42", { method: "DELETE" }),
      ),
    )).status,
    204,
  );
  assertEquals(
    await (await handlerFor(route, "HEAD")(
      context(
        new Request("https://connector.local/users/42", { method: "HEAD" }),
      ),
    )).text(),
    "",
  );
  assertEquals(
    await (await handlerFor(route, "OPTIONS")(
      context(
        new Request("https://connector.local/users/42", { method: "OPTIONS" }),
      ),
    )).text(),
    "OPTIONS",
  );
});

Deno.test("http fluent builder supports all handlers and error handlers", async () => {
  const route = http()
    .onError((errorValue, ctx) => {
      assertInstanceOf(errorValue, Error);
      return ctx.res.badRequest(errorValue.message);
    })
    .all(() => {
      throw new Error("not today");
    });

  const response = await handlerFor(route, "PATCH")(
    context(
      new Request("https://connector.local/anything", { method: "PATCH" }),
    ),
  );
  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: { code: "BAD_REQUEST", message: "not today" },
  });
});

Deno.test("http fluent builder throws on duplicate method registration", () => {
  const error = assertThrows(
    () => {
      // deno-lint-ignore no-explicit-any
      (http() as any).get(() => new Response("first")).get(() =>
        new Response("second")
      );
    },
    RuntimeError,
  );
  assertEquals(error.code, "DUPLICATE_HANDLER");
  assert(error.message.includes("GET"));
});

Deno.test("http fluent builder throws when all() conflicts with existing handler", () => {
  const error = assertThrows(
    () => {
      // deno-lint-ignore no-explicit-any
      (http() as any).get(() => new Response("get")).all(() =>
        new Response("all")
      );
    },
    RuntimeError,
  );
  assertEquals(error.code, "DUPLICATE_HANDLER");
  assert(error.message.includes("GET"));
});

Deno.test("http fluent builder throws when registering method after all()", () => {
  const error = assertThrows(
    () => {
      // deno-lint-ignore no-explicit-any
      (http() as any).all(() => new Response("all")).post(() =>
        new Response("post")
      );
    },
    RuntimeError,
  );
  assertEquals(error.code, "DUPLICATE_HANDLER");
  assert(error.message.includes("POST"));
});

Deno.test("http fluent builder allows multiple middleware registrations", async () => {
  const order: string[] = [];
  const route = http()
    .use((_ctx, next) => {
      order.push("first");
      return next();
    })
    .use((_ctx, next) => {
      order.push("second");
      return next();
    })
    .get((ctx) => {
      order.push("handler");
      return ctx.res.ok().text("done");
    });

  await handlerFor(route, "GET")(context());
  assertEquals(order, ["first", "second", "handler"]);
});

Deno.test("isHttpRouteDefinition rejects non-route values", () => {
  assertEquals(isHttpRouteDefinition(null), false);
  assertEquals(
    isHttpRouteDefinition({ protocol: "imap", handlers: {} }),
    false,
  );
  assertEquals(isHttpRouteDefinition({ protocol: "http" }), false);
  assertEquals(
    isHttpRouteDefinition({ protocol: "http", handlers: [] }),
    false,
  );
});

Deno.test("createHttpContext exposes request, params, query, cookies, env, and background tasks", async () => {
  const tasks: Promise<unknown>[] = [];
  const ctx = context(undefined, {
    waitUntil: (task) => tasks.push(task),
  });

  assertEquals(ctx.protocol, "http");
  assertEquals(ctx.requestId, "req-1");
  assertEquals(ctx.startedAt, startedAt);
  assertEquals(ctx.env.API_TOKEN, "secret");
  assert(Object.isFrozen(ctx.env));

  assertEquals(ctx.req.method, "GET");
  assertEquals(ctx.req.path, "/users/42");
  assertEquals(ctx.req.search, "?tag=a&tag=b&page=2");
  assertEquals(ctx.req.header("x-trace"), "trace-1");
  assertEquals(ctx.req.cookie("session"), "abc 123");
  assertEquals(ctx.req.cookies(), { session: "abc 123", theme: "dark" });

  const urlCopy = ctx.req.url;
  urlCopy.pathname = "/mutated";
  assertEquals(ctx.req.path, "/users/42");

  assertEquals(ctx.req.params.get("id"), "42");
  assertEquals(ctx.req.params.require("id"), "42");
  assertEquals(ctx.req.params.all(), { id: "42" });
  assertThrows(
    () => ctx.req.params.require("missing"),
    RuntimeError,
    'Missing required route parameter "missing"',
  );

  assertEquals(ctx.req.query.get("tag"), "a");
  assertEquals(ctx.req.query.all("tag"), ["a", "b"]);
  assertEquals(ctx.req.query.has("page"), true);
  assertEquals(ctx.req.query.int("page"), 2);
  assertEquals(ctx.req.query.int("missing", 10), 10);
  assertEquals([...ctx.req.query.entries()], [
    ["tag", "a"],
    ["tag", "b"],
    ["page", "2"],
  ]);

  const queryCopy = ctx.req.query.toURLSearchParams();
  queryCopy.set("page", "3");
  assertEquals(ctx.req.query.int("page"), 2);

  ctx.waitUntil(Promise.resolve());
  assertEquals(tasks.length, 1);
  await tasks[0];
});

Deno.test("query facade parses numbers and booleans and rejects invalid values", () => {
  const ctx = context(
    new Request(
      "https://connector.local/search?count=3&ratio=2.5&enabled=yes&disabled=off&badInt=1.2&badNumber=x&badBoolean=maybe",
    ),
  );

  assertEquals(ctx.req.query.int("count"), 3);
  assertEquals(ctx.req.query.number("ratio"), 2.5);
  assertEquals(ctx.req.query.boolean("enabled"), true);
  assertEquals(ctx.req.query.boolean("disabled"), false);
  assertEquals(ctx.req.query.boolean("missing", true), true);
  assertThrows(() => ctx.req.query.int("badInt"), RuntimeError);
  assertThrows(() => ctx.req.query.number("badNumber"), RuntimeError);
  assertThrows(() => ctx.req.query.boolean("badBoolean"), RuntimeError);
});

Deno.test("request body facade reads JSON, text, urlencoded, form data, binary, and auto formats", async () => {
  const jsonCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    }),
  );
  assertEquals(await jsonCtx.req.body.json(), { name: "Ada" });
  assertEquals(await jsonCtx.req.body.auto(), { name: "Ada" });

  const textCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      body: "hello",
    }),
  );
  assertEquals(await textCtx.req.body.text(), "hello");
  assertEquals(await textCtx.req.body.auto(), "hello");

  const urlEncodedCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Ada&active=true",
    }),
  );
  const params = await urlEncodedCtx.req.body.urlEncoded();
  assertEquals(params.get("name"), "Ada");
  assertInstanceOf(await urlEncodedCtx.req.body.auto(), URLSearchParams);

  const binaryCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  const firstBuffer = await binaryCtx.req.body.arrayBuffer();
  const secondBuffer = await binaryCtx.req.body.arrayBuffer();
  assertEquals([...new Uint8Array(firstBuffer)], [1, 2, 3]);
  assertEquals(firstBuffer === secondBuffer, false);
  assertInstanceOf(await binaryCtx.req.body.auto(), ArrayBuffer);

  const form = new FormData();
  form.set("upload", "value");
  const formCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      body: form,
    }),
  );
  assertEquals((await formCtx.req.body.formData()).get("upload"), "value");

  const emptyJsonCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "  ",
    }),
  );
  assertEquals(await emptyJsonCtx.req.body.json(), {});

  const invalidJsonCtx = context(
    new Request("https://connector.local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  const thrown = await assertRejects(
    () => invalidJsonCtx.req.body.json(),
    RuntimeError,
    "Request body is not valid JSON",
  );
  assertEquals(thrown.code, "INVALID_JSON");
});

Deno.test("response helpers and builders create typed responses", async () => {
  const jsonResponse = json({ ok: true }, { status: 202 });
  assertEquals(jsonResponse.status, 202);
  assertEquals(
    jsonResponse.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(await jsonResponse.json(), { ok: true });

  assertEquals(await text("hello").text(), "hello");
  assertEquals(
    html("<strong>ok</strong>").headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertEquals(noContent().status, 204);
  assertEquals(
    redirect("https://example.com").headers.get("location"),
    "https://example.com",
  );
  assertEquals(await error(418, "Teapot", "TEAPOT").json(), {
    error: { code: "TEAPOT", message: "Teapot" },
  });
  assertEquals(await badRequest("Bad").json(), {
    error: { code: "BAD_REQUEST", message: "Bad" },
  });
  assertEquals(await unauthorized().json(), {
    error: { code: "UNAUTHORIZED", message: "Unauthorized" },
  });
  assertEquals(await forbidden().json(), {
    error: { code: "FORBIDDEN", message: "Forbidden" },
  });
  assertEquals(await notFound().json(), {
    error: { code: "NOT_FOUND", message: "Not found" },
  });
  assertEquals(await conflict().json(), {
    error: { code: "CONFLICT", message: "Conflict" },
  });
  assertEquals(await unprocessableEntity("Invalid").json(), {
    error: { code: "UNPROCESSABLE_ENTITY", message: "Invalid" },
  });
  assertEquals(await internalServerError().json(), {
    error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" },
  });

  const cookieResponse = status(201)
    .headers({ "x-one": "1" })
    .appendHeader("x-one", "2")
    .removeHeader("x-missing")
    .cookie("session", "a b", {
      httpOnly: true,
      maxAge: 60,
      path: "/",
      sameSite: "lax",
      secure: true,
    })
    .send({ created: true });
  assertEquals(cookieResponse.status, 201);
  assertEquals(cookieResponse.headers.get("x-one"), "1, 2");
  assert(cookieResponse.headers.get("set-cookie")?.includes("session=a%20b"));
  assertEquals(await cookieResponse.json(), { created: true });

  assertStrictEquals(
    status(200).send(new Response("raw")) instanceof Response,
    true,
  );
  assertEquals(await status(200).send("raw text").text(), "raw text");
  assertEquals(await status(200).send(3).json(), 3);
  assertEquals(await status(200).send(true).json(), true);
  assertEquals(
    await status(204).type("application/json").text("ignored").text(),
    "",
  );
  assertEquals(
    new HttpResponseFactory("HEAD").ok().text("hidden").headers.get(
      "content-type",
    ),
    null,
  );
  assertThrows(() => status(200).redirect("https://example.com"), RuntimeError);
});

Deno.test("response from builder can rewrite status, headers, and body", async () => {
  const source = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: {
      "content-type": "application/json",
      "x-remove": "yes",
    },
  });
  const jsonResponse = await new HttpResponseFactory()
    .from(source)
    .status(202)
    .header("x-added", "yes")
    .removeHeader("x-remove")
    .json();

  assertEquals(jsonResponse.status, 202);
  assertEquals(jsonResponse.headers.get("x-added"), "yes");
  assertEquals(jsonResponse.headers.get("x-remove"), null);
  assertEquals(await jsonResponse.json(), { ok: true });

  const textResponse = await new HttpResponseFactory()
    .from(new Response("hello", { status: 203 }))
    .text();
  assertEquals(textResponse.status, 203);
  assertEquals(await textResponse.text(), "hello");

  const emptyResponse = await new HttpResponseFactory("HEAD")
    .from(new Response("hidden", { status: 200 }))
    .send();
  assertEquals(await emptyResponse.text(), "");
});

Deno.test("upstream builder sends configured requests", async () => {
  await withMockFetch((input, init) => {
    const headers = new Headers(init?.headers);
    assertEquals(
      fetchUrl(input),
      "https://api.example/users/a%20b?active=true&tag=one&tag=two",
    );
    assertEquals(init?.method, "POST");
    assertEquals(headers.get("authorization"), "Bearer token");
    assertEquals(headers.get("x-source"), "sdk");
    assertEquals(headers.get("content-type"), "application/json");
    assertEquals(init?.body, JSON.stringify({ name: "Ada" }));
    assertInstanceOf(init?.signal, AbortSignal);
    return Response.json({ upstream: true }, { status: 207 });
  }, async () => {
    const response = await upstream("https://api.example/base/")
      .path("/users/{id}", { id: "a b" })
      .queryParam("active", true)
      .queryFrom(
        new URLSearchParams([[
          "tag",
          "one",
        ], ["tag", "two"]]),
      )
      .headersFrom({ "x-source": "sdk" })
      .bearer("token")
      .timeout(500)
      .post({ name: "Ada" });

    assertEquals(response.status, 207);
    assertEquals(await response.json(), { upstream: true });
  });

  await withMockFetch((_input, init) => {
    assertEquals(init?.method, "GET");
    assertEquals(init?.body, undefined);
    return new Response("ok");
  }, async () => {
    assertEquals(
      await upstream("https://api.example").body("ignored").get().then((r) =>
        r.text()
      ),
      "ok",
    );
  });

  await withMockFetch((_input, init) => {
    assertEquals(init?.method, "PUT");
    assertEquals(init?.body, "plain");
    return new Response("ok");
  }, async () => {
    await upstream("https://api.example").textBody("plain").put();
  });

  await withMockFetch((_input, init) => {
    assertEquals(init?.method, "PATCH");
    assertEquals(init?.body, JSON.stringify({ patch: true }));
    return new Response("ok");
  }, async () => {
    await upstream("https://api.example").patch({ patch: true });
  });

  await withMockFetch((_input, init) => {
    assertEquals(init?.method, "DELETE");
    return new Response("ok");
  }, async () => {
    await upstream("https://api.example").delete();
  });

  assertThrows(
    () => upstream("https://api.example").path("/users/{missing}", {}),
    RuntimeError,
    'Missing path parameter "missing"',
  );
});

Deno.test("context upstream helper adds request id", async () => {
  await withMockFetch((_input, init) => {
    assertEquals(new Headers(init?.headers).get("x-request-id"), "req-1");
    return new Response("ok");
  }, async () => {
    assertEquals(
      await context().upstream("https://api.example").get().then((r) =>
        r.text()
      ),
      "ok",
    );
  });
});

Deno.test("proxy builder forwards transformed HTTP requests", async () => {
  const ctx = context(
    new Request("https://connector.local/proxy/orders?include=items", {
      method: "POST",
      headers: {
        "x-forward": "yes",
        "x-remove": "drop",
      },
      body: "payload",
    }),
  );

  await withMockFetch((input, init) => {
    const headers = new Headers(init?.headers);
    assertEquals(
      fetchUrl(input),
      "https://internal.example/orders?include=items",
    );
    assertEquals(init?.method, "POST");
    assertEquals(headers.get("x-forward"), "yes");
    assertEquals(headers.get("x-remove"), null);
    assertEquals(headers.get("x-added"), "1");
    assertEquals(init?.body, "payload");
    assertInstanceOf(init?.signal, AbortSignal);
    return new Response("proxied", {
      status: 202,
      headers: {
        "x-keep": "yes",
        "x-secret": "remove",
      },
    });
  }, async () => {
    const response = await proxy(ctx)
      .to("https://internal.example")
      .stripPrefix("/proxy")
      .forwardHeaders()
      .removeRequestHeader("x-remove")
      .header("x-added", "1")
      .bearer(undefined)
      .removeResponseHeader("x-secret")
      .timeout(500)
      .send();

    assertEquals(response.status, 202);
    assertEquals(response.headers.get("x-keep"), "yes");
    assertEquals(response.headers.get("x-secret"), null);
    assertEquals(await response.text(), "proxied");
  });
});

Deno.test("proxy builder rejects missing targets and skips GET bodies", async () => {
  await assertRejects(
    () => context().proxy.send(),
    RuntimeError,
    "HTTP proxy target is not configured",
  );

  await withMockFetch((_input, init) => {
    assertEquals(init?.method, "GET");
    assertEquals(init?.body, undefined);
    return new Response("ok");
  }, async () => {
    assertEquals(
      await context().proxy.to("https://internal.example").send().then((r) =>
        r.text()
      ),
      "ok",
    );
  });
});
