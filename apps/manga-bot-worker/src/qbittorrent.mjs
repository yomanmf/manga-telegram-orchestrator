const DEFAULT_BASE_URL = "http://media-qbittorrent:8080";
const REQUEST_TIMEOUT_MS = 10_000;

export function createQbittorrentClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(root + path, { ...options, signal: controller.signal });
    } catch {
      throw upstreamError("qBittorrent is unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw upstreamError(`qBittorrent returned HTTP ${response.status}`);
    return response;
  }

  return {
    async list() {
      const response = await request("/api/v2/torrents/info?filter=all&sort=added_on&reverse=true", {
        headers: { Accept: "application/json" }
      });
      const items = await response.json().catch(() => null);
      if (!Array.isArray(items)) throw upstreamError("qBittorrent returned an invalid torrent list");
      return items.map(publicTorrent);
    },

    async delete(hash) {
      const body = new URLSearchParams({ hashes: hash, deleteFiles: "true" });
      await request("/api/v2/torrents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
    }
  };
}

function publicTorrent(item) {
  return {
    hash: String(item.hash || "").toLowerCase(),
    name: String(item.name || "Unnamed torrent").slice(0, 300),
    state: String(item.state || "unknown").slice(0, 60),
    progress: boundedNumber(item.progress, 0, 1),
    size: nonNegativeNumber(item.size),
    completed: nonNegativeNumber(item.completed),
    downloadSpeed: nonNegativeNumber(item.dlspeed),
    uploadSpeed: nonNegativeNumber(item.upspeed),
    eta: nonNegativeNumber(item.eta),
    addedOn: nonNegativeNumber(item.added_on)
  };
}

function boundedNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function upstreamError(message) {
  const error = new Error(message);
  error.status = 502;
  return error;
}
