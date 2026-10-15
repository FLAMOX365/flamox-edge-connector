/**
 * Users Endpoint
 *
 * GET  /users      - List all users
 * POST /users      - Create a new user
 *
 * This example shows how to:
 * - Read query parameters (ctx.req.query)
 * - Parse request bodies (ctx.req.body)
 * - Return JSON responses (ctx.res)
 * - Return errors (ctx.res.error)
 */

import { defineHttp } from "@edge-connector/sdk";

// Example user data types.
interface User {
  id: string;
  name: string;
  email: string;
  department?: string;
}

interface CreateUserInput {
  name: string;
  email: string;
  department?: string;
}

// Example in-memory data. In production, connect this to your own data source.
const users: User[] = [
  {
    id: "1",
    name: "Max Miller",
    email: "m.mueller@example.com",
    department: "IT",
  },
  {
    id: "2",
    name: "Anna Schmidt",
    email: "a.schmidt@example.com",
    department: "HR",
  },
  {
    id: "3",
    name: "Peter Weber",
    email: "p.weber@example.com",
    department: "IT",
  },
];

export default defineHttp({
  /**
   * GET /users - List all users
   *
   * Query parameters:
   * - department: Filter by department
   * - limit: Maximum number of results
   */
  get: (ctx) => {
    let result = [...users];

    // Filter by department.
    const department = ctx.req.query.get("department");
    if (department) {
      result = result.filter((u) => u.department === department);
    }

    // Limit
    const limitStr = ctx.req.query.get("limit");
    if (limitStr) {
      const limit = parseInt(limitStr, 10);
      if (!isNaN(limit) && limit > 0) {
        result = result.slice(0, limit);
      }
    }

    return ctx.res.ok().json(result);
  },

  /**
   * POST /users - Create a new user
   *
   * Request-Body:
   * {
   *   "name": "...",
   *   "email": "...",
   *   "department": "..." (optional)
   * }
   */
  post: async (ctx) => {
    // Parse request body.
    const input = await ctx.req.body.json<CreateUserInput>();

    // Validation.
    if (!input.name || !input.email) {
      return ctx.res.badRequest("name and email are required");
    }

    // Create the new user.
    const newUser: User = {
      id: String(users.length + 1),
      name: input.name,
      email: input.email,
      department: input.department,
    };

    users.push(newUser);

    return ctx.res.created().json(newUser);
  },
});
