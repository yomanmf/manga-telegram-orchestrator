import JSZip from "jszip";

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
