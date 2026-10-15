import nodeAssert from "node:assert/strict";

export default nodeAssert;
export function assert(value: unknown, message?: string): asserts value {
  nodeAssert.ok(value, message ?? "Assertion failed.");
}
export const assertEquals: typeof nodeAssert.deepStrictEqual =
  nodeAssert.deepStrictEqual;
export const assertNotEquals: typeof nodeAssert.notDeepStrictEqual =
  nodeAssert.notDeepStrictEqual;
export const assertStrictEquals: typeof nodeAssert.strictEqual =
  nodeAssert.strictEqual;
export const assertMatch: typeof nodeAssert.match = nodeAssert.match;
export function assertStringIncludes(value: string, expected: string): void {
  nodeAssert.ok(
    value.includes(expected),
    `Expected string to include ${JSON.stringify(expected)}.`,
  );
}
export function assertInstanceOf<T>(
  value: unknown,
  errorType: new (...args: never[]) => T,
): asserts value is T {
  nodeAssert.ok(value instanceof errorType);
}
export function assertExists<T>(value: T): asserts value is NonNullable<T> {
  nodeAssert.ok(value !== undefined && value !== null);
}

type ErrorType = new (...args: never[]) => Error;
function matches(
  error: unknown,
  errorType?: ErrorType,
  message?: string,
): boolean {
  nodeAssert.ok(error instanceof Error);
  if (errorType) nodeAssert.ok(error instanceof errorType);
  if (message) assertStringIncludes(error.message, message);
  return true;
}

export async function assertRejects<T extends Error = Error>(
  fn: () => Promise<unknown>,
  errorType?: new (...args: never[]) => T,
  message?: string,
): Promise<T> {
  let caught: unknown;
  await nodeAssert.rejects(
    async () => {
      try {
        return await fn();
      } catch (error) {
        caught = error;
        throw error;
      }
    },
    (error: unknown) => matches(error, errorType, message),
  );
  return caught as T;
}
export function assertThrows<T extends Error = Error>(
  fn: () => unknown,
  errorType?: new (...args: never[]) => T,
  message?: string,
): T {
  let caught: unknown;
  nodeAssert.throws(
    () => {
      try {
        return fn();
      } catch (error) {
        caught = error;
        throw error;
      }
    },
    (error: unknown) => matches(error, errorType, message),
  );
  return caught as T;
}
