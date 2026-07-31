import { defineExtension } from "@edge-connector/sdk";

export default defineExtension({
  actions: {
    health: ({ configuration, secrets }) => ({
      configured: typeof configuration.targetHost === "string",
      authenticated: typeof secrets.API_TOKEN === "string",
    }),
    read: async ({ configuration, secrets }, input) => {
      const targetHost = String(configuration.targetHost);
      const response = await fetch(`https://${targetHost}/api/example`, {
        headers: { authorization: `Bearer ${secrets.API_TOKEN}` },
      });
      return {
        status: response.status,
        input,
        body: await response.text(),
      };
    },
  },
});
