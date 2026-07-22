const STATUSES = new Set(["received", "success", "error", "cancelled"]);

export function createAnalyticsReporter({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    async report(input) {
      const event = validateBrowserEvent(input);
      if (!env.ANALYTICS_URL || !env.ANALYTICS_INGEST_TOKEN) return false;
      const response = await fetchImpl(`${String(env.ANALYTICS_URL).replace(/\/+$/, "")}/analytics/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.ANALYTICS_INGEST_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...event, botId: "manga_web" }),
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error(`Analytics service rejected the event (${response.status})`);
      return true;
    }
  };
}

export function validateBrowserEvent(input = {}) {
  const eventId = identifier(input.eventId, "eventId", 200);
  if (!eventId.startsWith("manga_web:")) throw new Error("eventId has an invalid prefix");
  const status = identifier(input.status, "status", 24);
  if (!STATUSES.has(status)) throw new Error("status is not supported");
  return {
    eventId,
    requestType: identifier(input.requestType, "requestType", 80),
    userId: identifier(input.userId, "userId", 200),
    requestText: text(input.requestText, 2_000),
    resultText: text(input.resultText, 4_000),
    errorText: text(input.errorText, 2_000),
    status,
    startedAt: date(input.startedAt, "startedAt") || new Date().toISOString(),
    finishedAt: date(input.finishedAt, "finishedAt"),
    durationMs: duration(input.durationMs),
    metadata: metadata(input.metadata)
  };
}

function identifier(value, name, max) {
  const result = String(value || "");
  if (!result || result.length > max || !/^[a-zA-Z0-9._:@-]+$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function text(value, max) {
  if (value == null || value === "") return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}
function date(value, name) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}
function duration(value) {
  if (value == null || value === "") return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 86_400_000) throw new Error("durationMs is invalid");
  return result;
}
function metadata(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 4_000) throw new Error("metadata is invalid");
  return value;
}
