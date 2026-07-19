import JSZip from "jszip";

const MAX_COVER_BYTES = 12 * 1024 * 1024;

function assertRemoteCoverUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("The manga source returned an invalid cover URL");
  }
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
    throw new Error("The manga source returned an unsafe cover URL");
  }
  return url;
}

async function fetchCover(coverUrl, seriesUrl) {
  let current = assertRemoteCoverUrl(coverUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.1",
        Referer: String(seriesUrl || "https://weebcentral.com/")
      }
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = assertRemoteCoverUrl(new URL(response.headers.get("location"), current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Manga cover download failed (${response.status})`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_COVER_BYTES) throw new Error("The manga cover is larger than 12 MB");
    const cover = Buffer.from(await response.arrayBuffer());
    if (cover.length === 0 || cover.length > MAX_COVER_BYTES) {
      throw new Error("The manga cover is empty or larger than 12 MB");
    }
    const isJpeg = cover[0] === 0xff && cover[1] === 0xd8;
    const isPng = cover.length >= 8 && cover.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isJpeg && !isPng) throw new Error("The manga cover is not a JPEG or PNG image");
    return cover;
  }
  throw new Error("The manga cover redirected too many times");
}

export function createMangaAppClient({ baseUrl, sessionToken }) {
  if (!baseUrl || !sessionToken) {
    throw new Error("MANGA_APP_URL and MANGA_APP_SESSION_TOKEN are required");
  }
  const url = baseUrl.replace(/\/$/, "");
  const cookie = `manga_session=${encodeURIComponent(sessionToken)}`;

  async function json(pathname, options = {}) {
    const response = await fetch(`${url}${pathname}`, {
      ...options,
      headers: { Cookie: cookie, Accept: "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Manga app failed (${response.status})`);
    return data;
  }

  return {
    search(query) {
      return json(`/weebcentral/search?q=${encodeURIComponent(query)}`);
    },
    loadSeries(seriesUrl) {
      return json(`/weebcentral/series?url=${encodeURIComponent(seriesUrl)}`);
    },
    downloadCover({ coverUrl, seriesUrl }) {
      return fetchCover(coverUrl, seriesUrl);
    },
    async processChapter({ chapterId, mangaTitle, chapterTitle, shouldMerge = true }) {
      const response = await fetch(`${url}/weebcentral/chapter`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Accept: "application/zip",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ chapterId, mangaTitle, chapterTitle, shouldMerge })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Chapter processing failed (${response.status})`);
      }
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      const files = [];
      for (const [name, entry] of Object.entries(zip.files)) {
        if (!entry.dir && /\.pdf$/i.test(name)) {
          files.push({ name, bytes: Buffer.from(await entry.async("nodebuffer")) });
        }
      }
      if (files.length === 0) throw new Error("The manga processor returned no PDF files");
      return files;
    }
  };
}
