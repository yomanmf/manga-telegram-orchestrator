import https from "node:https";

// Bound connection establishment separately from Telegram's long-poll response.
export async function telegramFetch(url, options, { request = https.request, connectTimeoutMs = 1_500 } = {}) {
  let connectionTimer;
  try {
    return await new Promise((resolve, reject) => {
      const req = request(url, {
        method: options.method,
        headers: options.headers,
        agent: options.agent,
        signal: options.signal,
        family: 4
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      connectionTimer = setTimeout(() => {
        req.destroy(Object.assign(new Error("Telegram connection timed out"), { code: "ETIMEDOUT" }));
      }, connectTimeoutMs);
      req.on("socket", (socket) => {
        if (!socket.connecting) clearTimeout(connectionTimer);
        else socket.once("secureConnect", () => clearTimeout(connectionTimer));
      });
      req.on("error", reject);
      req.end(options.body);
    });
  } finally {
    clearTimeout(connectionTimer);
  }
}
