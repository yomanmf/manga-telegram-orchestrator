import assert from "node:assert/strict";
import test from "node:test";

import { loadAnalyticsLockbox } from "../src/analytics-lockbox.mjs";

test("loads analytics and Kindle email settings from VM Lockbox secrets", async () => {
  const env = {};
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/analytics-lockbox-secret-id")) return new Response("analytics-secret");
    if (String(url).endsWith("/kindle-email-lockbox-secret-id")) return new Response("kindle-secret");
    if (String(url).endsWith("/token")) return Response.json({ access_token: "iam-token" });
    if (String(url).includes("kindle-secret")) return Response.json({ entries: [
      { key: "SMTP_PASS", textValue: "smtp-pass" },
      { key: "KINDLE_EMAIL", textValue: "reader@kindle.com" }
    ] });
    return Response.json({ entries: [
      { key: "ANALYTICS_INGEST_TOKEN", textValue: "ingest-secret" },
      { key: "ANALYTICS_DASHBOARD_USERNAME", textValue: "owner" },
      { key: "ANALYTICS_DASHBOARD_PASSWORD", textValue: "dashboard-secret" }
    ] });
  };

  await loadAnalyticsLockbox({ env, fetchImpl });

  assert.equal(env.ANALYTICS_INGEST_TOKEN, "ingest-secret");
  assert.equal(env.ANALYTICS_DASHBOARD_USERNAME, "owner");
  assert.equal(env.ANALYTICS_DASHBOARD_PASSWORD, "dashboard-secret");
  assert.equal(env.SMTP_PASS, "smtp-pass");
  assert.equal(env.KINDLE_EMAIL, "reader@kindle.com");
  assert.equal(requests[3].options.headers.Authorization, "Bearer iam-token");
  assert.equal(requests[4].options.headers.Authorization, "Bearer iam-token");
});
