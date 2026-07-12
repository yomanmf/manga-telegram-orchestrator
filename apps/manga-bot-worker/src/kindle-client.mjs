import fs from "node:fs";

export function createKindleClient({ baseUrl, sharedSecret }) {
  if (!baseUrl || !sharedSecret) {
    throw new Error("KINDLE_WORKER_URL and KINDLE_SHARED_SECRET are required");
  }
  const url = baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${sharedSecret}` };

  async function api(pathname, options = {}) {
    const response = await fetch(`${url}${pathname}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Kindle worker failed (${response.status})`);
    return data;
  }

  return {
    status() { return api("/api/status"); },
    job(id) { return api(`/api/jobs/${encodeURIComponent(id)}`); },
    connectToken() { return api("/api/connect-token", { method: "POST" }); },
    async enqueueFile(filePath, filename, options = {}) {
      const { size } = await fs.promises.stat(filePath);
      const ticket = await api("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename,
          size,
          batchId: options.batchId || undefined,
          deferQueue: Boolean(options.deferStart)
        })
      });
      const upload = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf", "Content-Length": String(size) },
        body: fs.createReadStream(filePath),
        duplex: "half"
      });
      const data = await upload.json().catch(() => ({}));
      if (!upload.ok) throw new Error(data.error || `Kindle PDF upload failed (${upload.status})`);
      return data.job;
    },
    startBatch(batchId) {
      return api(`/api/batches/${encodeURIComponent(batchId)}/start`, {
        method: "POST"
      });
    }
  };
}
