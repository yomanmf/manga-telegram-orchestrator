import assert from "node:assert/strict";
import test from "node:test";

import { loadAnalyticsLockbox } from "../src/analytics-lockbox.mjs";

test("loads analytics settings from the VM Lockbox secret", async () => {
  const env = {};
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/analytics-lockbox-secret-id")) return new Response("secret-id");
    if (String(url).endsWith("/token")) return Response.json({ access_token: "iam-token" });
    return Response.json({ entries: [
      { key: "ANALYTICS_INGEST_TOKEN", textValue: "ingest-secret" },
      { key: "ANALYTICS_DASHBOARD_USERNAME", textValue: "owner" },
      { key: "ANALYTICS_DASHBOARD_PASSWORD", textValue: "dashboard-secret" },
      { key: "SMTP_PASS", textValue: "ignored" }
    ] });
  };

  await loadAnalyticsLockbox({ env, fetchImpl });

  assert.equal(env.ANALYTICS_INGEST_TOKEN, "ingest-secret");
  assert.equal(env.ANALYTICS_DASHBOARD_USERNAME, "owner");
  assert.equal(env.ANALYTICS_DASHBOARD_PASSWORD, "dashboard-secret");
  assert.equal(env.SMTP_PASS, undefined);
  assert.equal(requests[2].options.headers.Authorization, "Bearer iam-token");
});
