import { test } from "node:test";
import { assertEquals, assertInstanceOf } from "../test/assert.ts";
import { ErrorCodes, RuntimeError } from "./mod.ts";

test("RuntimeError preserves code, message, name, and cause", () => {
  const cause = new Error("source");
  const error = new RuntimeError("VALIDATION_ERROR", "Invalid payload", {
    cause,
  });

  assertInstanceOf(error, Error);
  assertEquals(error.name, "RuntimeError");
  assertEquals(error.code, "VALIDATION_ERROR");
  assertEquals(error.message, "Invalid payload");
  assertEquals(error.cause, cause);
});

test("ErrorCodes exposes stable public SDK error code constants", () => {
  assertEquals(ErrorCodes.FORBIDDEN, "FORBIDDEN");
  assertEquals(ErrorCodes.NOT_FOUND, "NOT_FOUND");
  assertEquals(ErrorCodes.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
  assertEquals(ErrorCodes.VALIDATION_ERROR, "VALIDATION_ERROR");
  assertEquals(ErrorCodes.RATE_LIMITED, "RATE_LIMITED");
  assertEquals(ErrorCodes.SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
  assertEquals(ErrorCodes.REQUEST_REJECTED, "REQUEST_REJECTED");
  assertEquals(ErrorCodes.CONFIGURATION_ERROR, "CONFIGURATION_ERROR");
});
