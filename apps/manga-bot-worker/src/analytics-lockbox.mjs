const METADATA = "http://169.254.169.254/computeMetadata/v1";
const ANALYTICS_KEYS = new Set([
  "ANALYTICS_INGEST_TOKEN",
  "ANALYTICS_DASHBOARD_USERNAME",
  "ANALYTICS_DASHBOARD_PASSWORD",
  "KINDLE_EMAIL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM"
]);

export async function loadAnalyticsLockbox({ env = process.env, fetchImpl = fetch } = {}) {
  if ([...ANALYTICS_KEYS].every((key) => env[key])) return;
  try {
    const secretIds = [];
    for (const [envName, metadataName] of [
      ["ANALYTICS_LOCKBOX_SECRET_ID", "analytics-lockbox-secret-id"],
      ["KINDLE_EMAIL_LOCKBOX_SECRET_ID", "kindle-email-lockbox-secret-id"]
    ]) {
      let secretId = String(env[envName] || "").trim();
      if (!secretId) {
        const response = await fetchImpl(
          `${METADATA}/instance/attributes/${metadataName}`,
          { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2_000) }
        );
        if (response.ok) secretId = (await response.text()).trim();
      }
      if (secretId && !secretIds.includes(secretId)) secretIds.push(secretId);
    }
    if (!secretIds.length) return;
    const tokenResponse = await fetchImpl(`${METADATA}/instance/service-accounts/default/token`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000)
    });
    if (!tokenResponse.ok) throw new Error(`VM IAM token request failed (${tokenResponse.status})`);
    const token = (await tokenResponse.json()).access_token;
    if (!token) throw new Error("VM metadata response does not contain access_token");
    for (const secretId of secretIds) {
      const payloadResponse = await fetchImpl(
        `https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/${encodeURIComponent(secretId)}/payload`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
      );
      if (!payloadResponse.ok) throw new Error(`Runtime Lockbox request failed (${payloadResponse.status})`);
      const payload = await payloadResponse.json();
      for (const entry of payload.entries || []) {
        if (ANALYTICS_KEYS.has(entry.key) && typeof entry.textValue === "string" && !env[entry.key]) {
          env[entry.key] = entry.textValue;
        }
      }
    }
  } catch (error) {
    console.warn("Runtime Lockbox secret could not be loaded", error);
  }
}
