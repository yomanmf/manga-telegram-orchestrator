const API_URL = "https://api.mangadex.org";
const CHAPTER_PREFIX = "mangadex:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titles(entry) {
  return [
    ...Object.values(entry?.attributes?.title || {}),
    ...(entry?.attributes?.altTitles || []).flatMap((item) => Object.values(item || {}))
  ];
}

async function json(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`MangaDex returned HTTP ${response.status}`);
  return response.json();
}

export async function loadCompleteMangaDexVolumes(title, fetchImpl = fetch) {
  const searchUrl = new URL(`${API_URL}/manga`);
  searchUrl.searchParams.set("title", title);
  searchUrl.searchParams.set("limit", "10");
  const search = await json(fetchImpl, searchUrl);
  const requested = normalize(title);
  const manga = (search.data || []).find((entry) =>
    titles(entry).some((candidate) => normalize(candidate) === requested)
  );
  const lastVolume = Number(manga?.attributes?.lastVolume);
  if (!manga?.id || manga.attributes?.status !== "completed" || !Number.isInteger(lastVolume) || lastVolume < 1) {
    return [];
  }

  const feedUrl = new URL(`${API_URL}/manga/${encodeURIComponent(manga.id)}/feed`);
  feedUrl.searchParams.set("limit", "500");
  feedUrl.searchParams.append("translatedLanguage[]", "en");
  feedUrl.searchParams.set("order[volume]", "asc");
  feedUrl.searchParams.set("order[chapter]", "asc");
  const feed = await json(fetchImpl, feedUrl);
  if (feed.total > 500) return [];

  const grouped = new Map();
  for (const entry of feed.data || []) {
    const volume = Number(entry?.attributes?.volume);
    if (
      !UUID.test(entry?.id || "") ||
      !Number.isInteger(volume) ||
      volume < 1 ||
      volume > lastVolume ||
      Number(entry.attributes.pages) < 1 ||
      entry.attributes.externalUrl
    ) continue;
    const chapters = grouped.get(volume) || [];
    chapters.push(entry);
    grouped.set(volume, chapters);
  }
  if (grouped.size !== lastVolume) return [];

  return Array.from({ length: lastVolume }, (_, index) => {
    const volume = index + 1;
    const entries = grouped.get(volume);
    if (!entries?.length) return null;
    entries.sort((left, right) => Number(left.attributes.chapter || 0) - Number(right.attributes.chapter || 0));
    return {
      id: CHAPTER_PREFIX + entries.map((entry) => entry.id).join(","),
      title: `Volume ${volume}`,
      date: "",
      index: volume
    };
  }).filter(Boolean);
}

export function isMangaDexChapterId(value) {
  try {
    parseMangaDexChapterIds(value);
    return true;
  } catch {
    return false;
  }
}

export function parseMangaDexChapterIds(value) {
  const text = String(value || "");
  if (!text.startsWith(CHAPTER_PREFIX)) throw new Error("Invalid MangaDex chapter ID");
  const ids = text.slice(CHAPTER_PREFIX.length).split(",");
  if (ids.length < 1 || ids.length > 50 || ids.some((id) => !UUID.test(id))) {
    throw new Error("Invalid MangaDex chapter ID");
  }
  return ids;
}

export async function loadMangaDexChapterImageUrls(value, fetchImpl = fetch) {
  const urls = [];
  for (const chapterId of parseMangaDexChapterIds(value)) {
    const result = await json(fetchImpl, `${API_URL}/at-home/server/${chapterId}`);
    const baseUrl = new URL(String(result.baseUrl || ""));
    if (
      baseUrl.protocol !== "https:" ||
      !(
        baseUrl.hostname === "uploads.mangadex.org" ||
        baseUrl.hostname.endsWith(".mangadex.network")
      )
    ) throw new Error("MangaDex returned an unsafe image server");
    const hash = String(result.chapter?.hash || "");
    const files = result.chapter?.data;
    if (!/^[0-9a-f]{32}$/i.test(hash) || !Array.isArray(files) || files.length < 1) {
      throw new Error("MangaDex returned an invalid chapter");
    }
    for (const file of files) {
      if (!/^[^/\\]+\.(?:jpe?g|png|gif|webp)$/i.test(String(file))) {
        throw new Error("MangaDex returned an invalid image name");
      }
      urls.push(new URL(`/data/${hash}/${file}`, baseUrl).toString());
    }
  }
  return urls;
}
