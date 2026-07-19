function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function assertPublicHttpsImageUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10[.]/.test(host) ||
    /^192[.]168[.]/.test(host) ||
    /^172[.](1[6-9]|2\d|3[01])[.]/.test(host)
  ) {
    throw new Error("Unsafe manga cover URL");
  }
  return url.toString();
}

export function parseWeebCentralCoverUrl(seriesHtml) {
  const html = String(seriesHtml || "");
  const propertyFirst = html.match(/<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i);
  const contentFirst = html.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["'][^>]*>/i);
  const value = decodeHtmlAttribute(propertyFirst?.[1] || contentFirst?.[1] || "").trim();
  if (!value) throw new Error("WeebCentral did not provide a manga cover");
  return assertPublicHttpsImageUrl(value);
}
