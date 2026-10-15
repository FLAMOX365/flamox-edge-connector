import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { makeTempDirectory } from "./files.ts";
import { ControlPlaneAgent } from "./control-plane-agent.ts";
import { ControlPlaneClient } from "./control-plane-client.ts";
import { ConnectorControlStateStore } from "./control-state.ts";
import { ConnectorAuditLog } from "./audit-log.ts";
import { generateConnectorKeyPair } from "./connector-identity.ts";
import type { ExtensionManager } from "./extension-manager.ts";
import type {
  ExtensionReconciler,
  ReconciliationResult,
} from "./extension-reconciler.ts";
import type { ConnectorCommand } from "./control-plane-contract.ts";
import type { JsonValue } from "@edge-connector/sdk/extension";
import { RuntimeError } from "./runtime-error.ts";
import { createLogger } from "./logger.ts";

async function fixture(t: TestContext) {
  const directory = await makeTempDirectory("edge-control-test-");
  const state = new ConnectorControlStateStore(join(directory, "control.json"));
  const audit = new ConnectorAuditLog(join(directory, "audit.json"));
  await audit.initialize();
  const identity = {
    schemaVersion: 1 as const,
    connectorId: "fixture",
    tenantId: "fixture-tenant",
    credentialSecret: "fixture-credential",
    pairedAt: "2026-10-15T10:00:00.000Z",
    ...(await generateConnectorKeyPair()),
  };
  const requests: { path: string; body: Record<string, JsonValue> }[] = [];
  const commands: ConnectorCommand[] = [];
  const failures = new Set<string>();
  const server = createServer(async (request, response) => {
    assert.equal(
      request.headers.authorization,
      "EdgeConnector fixture.fixture-credential",
    );
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url!, "http://fixture"),
      path = url.pathname;
    requests.push({
      path,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
    });
    if (failures.has(path)) {
      response.writeHead(503);
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/desired"))
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          revision: 7,
          publisherTrust: { schemaVersion: 1, publishers: [] },
          extensionPolicy: { schemaVersion: 1, extensions: [] },
          extensions: [],
        }),
      );
    else if (path.endsWith("/commands"))
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          commands: commands.filter(
            (command) =>
              command.sequence > Number(url.searchParams.get("afterSequence")),
          ),
        }),
      );
    else response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const client = new ControlPlaneClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    identity,
  );
  const executions: string[] = [];
  const manager = {
    execute: async (
      requestId: string,
      _extensionId: string,
      action: string,
    ) => {
      executions.push(requestId);
      if (action === "denied")
        throw new RuntimeError(
          "EXTENSION_ACTION_NOT_FOUND",
          "Action is not declared.",
        );
      return { accepted: true };
    },
  } as unknown as ExtensionManager;
  let reconciliation: ReconciliationResult = {
    complete: true,
    observations: [],
  };
  const reconciler = {
    reconcile: async () => reconciliation,
  } as unknown as ExtensionReconciler;
  const notifications: unknown[] = [];
  const agent = () =>
    new ControlPlaneAgent(
      identity,
      client,
      reconciler,
      manager,
      state,
      audit,
      60_000,
      createLogger("error", { info() {}, warn() {}, debug() {}, error() {} }),
      () => notifications.push(true),
    );
  const command = (
    sequence: number,
    action = "inspect",
    expiresAt = "2099-01-01T00:00:00.000Z",
  ): ConnectorCommand => ({
    sequence,
    commandId: `command-${sequence}`,
    extensionId: "test.extension",
    action,
    input: null,
    expiresAt,
  });
  return {
    state,
    audit,
    requests,
    commands,
    failures,
    executions,
    notifications,
    agent,
    command,
    setReconciliation(value: ReconciliationResult) {
      reconciliation = value;
    },
  };
}

test("control sync reports successful, expired and denied commands and resumes persisted cursors without replay", async (t) => {
  const f = await fixture(t);
  f.commands.push(
    f.command(1),
    f.command(2, "inspect", "2000-01-01T00:00:00.000Z"),
    f.command(3, "denied"),
  );
  const agent = f.agent();
  await agent.runOnce();
  assert.deepEqual(f.executions, ["command-1", "command-3"]);
  const results = f.requests
    .filter((request) => request.path.endsWith("/command-results"))
    .map((request) => request.body);
  assert.deepEqual(
    results.map((result) => result.status),
    ["SUCCEEDED", "EXPIRED", "FAILED"],
  );
  assert.equal(results[1]!.errorCode, "COMMAND_EXPIRED");
  assert.equal(results[2]!.errorCode, "EXTENSION_ACTION_NOT_FOUND");
  assert.deepEqual(await f.state.load(), {
    schemaVersion: 1,
    desiredRevision: 7,
    commandSequence: 3,
  });
  assert.equal(agent.state().commandSequence, 3);
  assert.equal(agent.state().tenantId, "fixture-tenant");
  assert.equal(f.audit.list().length, 0);
  assert.ok(f.notifications.length > 0);
  await f.agent().runOnce();
  assert.deepEqual(f.executions, ["command-1", "command-3"]);
});

test("control sync retains the revision and audit outbox when observed-state delivery fails", async (t) => {
  const f = await fixture(t);
  await f.audit.record("test.event", "SUCCEEDED");
  f.failures.add("/edge/connectors/control/observed");
  await assert.rejects(() => f.agent().runOnce(), /503/);
  assert.equal((await f.state.load()).desiredRevision, 0);
  assert.equal(f.audit.list().length, 1);
  assert.equal(
    f.requests.some((request) => request.path.endsWith("/commands")),
    false,
  );
  f.failures.clear();
  await f.agent().runOnce();
  assert.equal((await f.state.load()).desiredRevision, 7);
  assert.equal(f.audit.list().length, 0);
});

test("control sync reports an incomplete reconciliation without acknowledging its desired revision", async (t) => {
  const f = await fixture(t);
  f.setReconciliation({
    complete: false,
    observations: [
      {
        extensionId: "test.extension",
        desiredStatus: "ACTIVE",
        desiredVersion: "2.0.0",
        observedStatus: "ACTIVE",
        observedVersion: "1.0.0",
        errorCode: "EXTENSION_RECONCILIATION_FAILED",
        errorMessage: null,
      },
    ],
  });
  await f.agent().runOnce();
  assert.equal((await f.state.load()).desiredRevision, 0);
  const observed = f.requests.find((request) =>
    request.path.endsWith("/observed"),
  )!.body;
  assert.equal(observed.desiredRevision, 7);
  assert.equal(
    (observed.extensions as Record<string, JsonValue>[])[0]!.observedVersion,
    "1.0.0",
  );
});

test("control sync advances command cursors only after result acknowledgement and retries with the same command id", async (t) => {
  const f = await fixture(t);
  f.commands.push(f.command(1));
  f.failures.add("/edge/connectors/control/command-results");
  await assert.rejects(() => f.agent().runOnce(), /503/);
  assert.equal((await f.state.load()).commandSequence, 0);
  assert.equal(f.audit.list().length, 1);
  f.failures.clear();
  await f.agent().runOnce();
  assert.deepEqual(f.executions, ["command-1", "command-1"]);
  assert.equal((await f.state.load()).commandSequence, 1);
  assert.equal(f.audit.list().length, 0);
});

test("control sync retains unacknowledged audit events and drains at most one bounded page", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 105; index++)
    await f.audit.record("test.event", "SUCCEEDED", { index });
  const originalIds = f.audit.list().map((event) => event.eventId);
  f.failures.add("/edge/connectors/control/audit");
  await assert.rejects(() => f.agent().runOnce(), /503/);
  assert.deepEqual(
    f.audit.list().map((event) => event.eventId),
    originalIds,
  );
  f.failures.clear();
  await f.agent().runOnce();
  assert.deepEqual(
    f.audit.list().map((event) => event.eventId),
    originalIds.slice(100),
  );
  const payload = f.requests
    .filter((request) => request.path.endsWith("/audit"))
    .at(-1)!.body.events as JsonValue[];
  assert.equal(payload.length, 100);
  await f.agent().runOnce();
  assert.equal(f.audit.list().length, 0);
});
