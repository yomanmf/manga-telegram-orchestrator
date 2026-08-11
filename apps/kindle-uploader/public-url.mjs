export function publicRequestBaseUrl(req, fallback) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "")
    .split(",", 1)[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",", 1)[0].trim();
  try {
    return proto === "https" && host
      ? new URL("https://" + host).origin
      : fallback;
  } catch {
    return fallback;
  }
}
