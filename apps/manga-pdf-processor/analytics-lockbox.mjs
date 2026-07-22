const METADATA = "http://169.254.169.254/computeMetadata/v1";
const ANALYTICS_KEYS = new Set(["ANALYTICS_URL", "ANALYTICS_INGEST_TOKEN"]);

export async function loadAnalyticsLockbox({ env = process.env, fetchImpl = fetch } = {}) {
  if ([...ANALYTICS_KEYS].every((key) => env[key])) return;
  try {
    let secretId = String(env.ANALYTICS_LOCKBOX_SECRET_ID || "").trim();
    if (!secretId) {
      const response = await fetchImpl(
        `${METADATA}/instance/attributes/analytics-lockbox-secret-id`,
        { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2_000) }
      );
      if (!response.ok) return;
      secretId = (await response.text()).trim();
    }
    if (!secretId) return;
    const tokenResponse = await fetchImpl(`${METADATA}/instance/service-accounts/default/token`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000)
    });
    if (!tokenResponse.ok) throw new Error(`VM IAM token request failed (${tokenResponse.status})`);
    const token = (await tokenResponse.json()).access_token;
    if (!token) throw new Error("VM metadata response does not contain access_token");
    const payloadResponse = await fetchImpl(
      `https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/${encodeURIComponent(secretId)}/payload`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!payloadResponse.ok) throw new Error(`Analytics Lockbox request failed (${payloadResponse.status})`);
    const payload = await payloadResponse.json();
    for (const entry of payload.entries || []) {
      if (ANALYTICS_KEYS.has(entry.key) && typeof entry.textValue === "string" && !env[entry.key]) {
        env[entry.key] = entry.textValue;
      }
    }
  } catch (error) {
    console.warn("Analytics Lockbox secret could not be loaded", error);
  }
}
