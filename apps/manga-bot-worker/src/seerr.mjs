const DEFAULT_BASE_URL = "http://media-seerr:5055";
const REQUEST_TIMEOUT_MS = 10_000;
const COMPLETED_STATUS = 5;
const AVAILABLE_STATUS = 5;

export function createSeerrClient({ baseUrl = DEFAULT_BASE_URL, apiKey, fetchImpl = fetch } = {}) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const key = String(apiKey || "").trim();

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(root + path, {
        ...options,
        headers: { ...(options.headers || {}), "X-Api-Key": key, Accept: "application/json" },
        signal: controller.signal
      });
    } catch {
      throw upstreamError("Seerr is unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw upstreamError(`Seerr returned HTTP ${response.status}`);
    return response;
  }

  async function json(path) {
    const response = await request(path);
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") throw upstreamError("Seerr returned an invalid response");
    return data;
  }

  return {
    async listCompleted() {
      const pageSize = 100;
      const items = [];
      let total = 1;
      for (let skip = 0; skip < total; skip += pageSize) {
        const data = await json(`/api/v1/request?take=${pageSize}&skip=${skip}&filter=available&sort=modified&sortDirection=desc`);
        const batch = Array.isArray(data.results) ? data.results : [];
        total = nonNegativeInteger(data.pageInfo && data.pageInfo.results);
        items.push(...batch);
        if (!batch.length) break;
      }
      const completed = await Promise.all(items.map(async (item) => {
        const media = item && item.media;
        const type = item && item.type === "tv" ? "tv" : "movie";
        const tmdbId = positiveInteger(media && media.tmdbId);
        if (!positiveInteger(item && item.id) || !positiveInteger(media && media.id) || !tmdbId) return null;
        const details = await json(`/api/v1/${type}/${tmdbId}`);
        return {
          source: "seerr",
          requestId: Number(item.id),
          mediaId: Number(media.id),
          name: String((type === "tv" ? details.name : details.title) || "Completed media").slice(0, 300),
          mediaType: type,
          state: "completed",
          progress: 1,
          size: 0,
          completed: 0,
          downloadSpeed: 0,
          uploadSpeed: 0,
          eta: 0,
          addedOn: Math.max(0, Math.floor(Date.parse(item.updatedAt || "") / 1000) || 0)
        };
      }));
      return completed.filter(Boolean);
    },

    async deleteCompleted(requestId, mediaId) {
      const requestIdValue = positiveInteger(requestId);
      const mediaIdValue = positiveInteger(mediaId);
      if (!requestIdValue || !mediaIdValue) throw clientError(400, "Invalid Seerr media identifiers");
      const item = await json(`/api/v1/request/${requestIdValue}`);
      if (Number(item.status) !== COMPLETED_STATUS ||
          Number(item.media && item.media.status) !== AVAILABLE_STATUS ||
          Number(item.media && item.media.id) !== mediaIdValue) {
        throw clientError(409, "Seerr media is not an available completed request");
      }
      await request(`/api/v1/media/${mediaIdValue}/file`, { method: "DELETE" });
      await request(`/api/v1/request/${requestIdValue}`, { method: "DELETE" });
      return { ok: true, requestId: requestIdValue, mediaId: mediaIdValue };
    }
  };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function clientError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function upstreamError(message) { return clientError(502, message); }
