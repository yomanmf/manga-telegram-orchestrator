import assert from "node:assert/strict";
import test from "node:test";
import { loadAnalyticsLockbox } from "./analytics-lockbox.mjs";

test("loads analytics URL and token from the VM Lockbox secret", async () => {
  const env = {};
  const responses = [
    new Response("secret-id"),
    new Response(JSON.stringify({ access_token: "iam-token" })),
    new Response(JSON.stringify({ entries: [
      { key: "ANALYTICS_URL", textValue: "https://analytics.example" },
      { key: "ANALYTICS_INGEST_TOKEN", textValue: "ingest-token" },
      { key: "ANALYTICS_DASHBOARD_PASSWORD", textValue: "ignored" }
    ] }))
  ];
  await loadAnalyticsLockbox({ env, fetchImpl: async () => responses.shift() });
  assert.equal(env.ANALYTICS_URL, "https://analytics.example");
  assert.equal(env.ANALYTICS_INGEST_TOKEN, "ingest-token");
  assert.equal(env.ANALYTICS_DASHBOARD_PASSWORD, undefined);
});
