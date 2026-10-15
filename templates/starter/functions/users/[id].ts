/**
 * Single User Endpoint
 *
 * GET    /users/:id - Get a single user
 * PUT    /users/:id - Update a user
 * DELETE /users/:id - Delete a user
 *
 * This example shows how to:
 * - Read URL parameters (ctx.req.params)
 * - Return 404 errors
 * - Return 204 No Content responses
 */

import { http } from "@edge-connector/sdk";

// Same data structure as in index.ts.
interface User {
  id: string;
  name: string;
  email: string;
  department?: string;
}

// In a real application, import your data source here.
// This example uses a simple in-memory store.
const users: Map<string, User> = new Map([
  [
    "1",
    {
      id: "1",
      name: "Max Miller",
      email: "m.mueller@example.com",
      department: "IT",
    },
  ],
  [
    "2",
    {
      id: "2",
      name: "Anna Schmidt",
      email: "a.schmidt@example.com",
      department: "HR",
    },
  ],
]);

export default http()
  /**
   * GET /users/:id - Get a single user
   */
  .get((ctx) => {
    const id = ctx.req.params.require("id");
    const user = users.get(id);

    if (!user) {
      return ctx.res.notFound(`User with ID ${id} not found`);
    }

    return ctx.res.ok().json(user);
  })
  /**
   * PUT /users/:id - Update a user
   */
  .put(async (ctx) => {
    const id = ctx.req.params.require("id");
    const existing = users.get(id);

    if (!existing) {
      return ctx.res.notFound(`User with ID ${id} not found`);
    }

    const input = await ctx.req.body.json<Partial<User>>();

    const updated: User = {
      ...existing,
      ...input,
      id, // The ID cannot be changed.
    };

    users.set(id, updated);

    return ctx.res.ok().json(updated);
  })
  /**
   * DELETE /users/:id - Delete a user
   */
  .delete((ctx) => {
    const id = ctx.req.params.require("id");

    if (!users.has(id)) {
      return ctx.res.notFound(`User with ID ${id} not found`);
    }

    users.delete(id);

    return ctx.res.noContent();
  });
