import sharp from "sharp";

const MAX_COVER_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeComicTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  if (title.length > 180) throw new Error("Title is too long");
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new Error("Title contains invalid characters");
  return title;
}

export function englishSearchTitle(value) {
  return String(value || "")
    .replace(/\((?:[^)]*\b(?:colou?r|digital|official)\b[^)]*)\)/gi, " ")
    .replace(/\b(?:digital\s+)?colou?red(?:\s+comics?)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function chapterNumberFromFileName(value) {
  const label = String(value || "").replace(/\.[^/.]+$/, "");
  const match = label.match(/(?:chapter|глава|ch[.]?)\s*([\d]+(?:[.,]\d+)?)/i) ||
    label.match(/\b([\d]+(?:[.,]\d+)?)\b/);
  return match ? match[1].replace(",", ".") : null;
}

export function explicitVolumeFromFileName(value) {
  const match = String(value || "").match(/(?:vol(?:ume)?|том)\s*[.#:_-]?\s*(\d+(?:[.,]\d+)?)/i);
  return match ? match[1].replace(",", ".") : null;
}

function titleValues(attributes = {}) {
  return [
    ...Object.values(attributes.title || {}),
    ...(attributes.altTitles || []).flatMap((entry) => Object.values(entry || {}))
  ].filter(Boolean);
}

export function selectMangaDexSeries(entries, requestedTitle) {
  const requested = normalize(englishSearchTitle(requestedTitle));
  const ranked = (Array.isArray(entries) ? entries : []).map((entry) => {
    const scores = titleValues(entry?.attributes).map((title) => {
      const candidate = normalize(englishSearchTitle(title));
      if (candidate === requested) return 1_000;
      if (candidate.startsWith(`${requested} `)) return 650 - (candidate.length - requested.length);
      if (candidate.includes(requested)) return 400 - (candidate.length - requested.length);
      return 0;
    });
    return { entry, score: Math.max(0, ...scores) };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.score > 0 ? ranked[0].entry : null;
}

function numeric(value) {
  const parsed = Number(String(value || "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function volumeForChapter(aggregate, chapterNumber) {
  const target = numeric(chapterNumber);
  if (target === null) return null;
  for (const [volume, value] of Object.entries(aggregate?.volumes || {})) {
    if (numeric(volume) === null) continue;
    for (const chapter of Object.keys(value?.chapters || {})) {
      const number = numeric(chapter);
      if (number !== null && Math.abs(number - target) < 0.000001) return String(volume);
    }
  }
  return null;
}

function publicHttpsUrl(value) {
  const url = new URL(String(value || ""));
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") || host === "localhost" ||
    host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" ||
    host.endsWith(".local") || /^10[.]/.test(host) || /^192[.]168[.]/.test(host) ||
    /^172[.](?:1[6-9]|2\d|3[01])[.]/.test(host)
  ) throw new Error("Unsafe comic cover URL");
  return url;
}

async function request(fetchImpl, url, options = {}) {
  return fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "User-Agent": "manga-pdf-processor/1.0 (comic cover lookup)",
      ...(options.headers || {})
    }
  });
}

async function json(fetchImpl, url) {
  const response = await request(fetchImpl, url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Cover metadata lookup failed (${response.status})`);
  return response.json();
}

function seriesMatches(value, title) {
  const candidate = normalize(value);
  const requested = normalize(englishSearchTitle(title));
  return candidate === requested || candidate.startsWith(`${requested} `) || candidate.includes(` ${requested} `);
}

function containsVolume(value, volume) {
  const escaped = String(volume).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\bvol(?:ume)?[.]?\\s*|#\\s*|\\b)${escaped}(?![\\d.])`, "i").test(String(value || ""));
}

function appleArtworkUrl(value) {
  let url;
  try {
    url = publicHttpsUrl(value);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().endsWith(".mzstatic.com")) return null;
  if (!/\/\d+x\d+bb[.](?:jpe?g|png)$/i.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/\d+x\d+bb[.](?:jpe?g|png)$/i, "/1600x2560bb.jpg");
  return url.toString();
}

async function appleBooksCandidates({ fetchImpl, title, volume }) {
  const candidates = [];
  for (const country of ["gb", "us"]) {
    const search = new URL("https://itunes.apple.com/search");
    search.searchParams.set("term", volume ? `${englishSearchTitle(title)} Vol. ${volume}` : englishSearchTitle(title));
    search.searchParams.set("entity", "ebook");
    search.searchParams.set("country", country);
    search.searchParams.set("limit", "25");
    let results;
    try {
      results = await json(fetchImpl, search);
    } catch {
      continue;
    }
    for (const book of results.results || []) {
      const name = book?.trackName || book?.trackCensoredName || "";
      const isComic = (book?.genres || []).some((genre) => /manga|comic|graphic novel/i.test(String(genre)));
      if (book?.kind !== "ebook" || !isComic || !seriesMatches(name, title)) continue;
      if (volume && !containsVolume(name, volume)) continue;
      const url = appleArtworkUrl(book.artworkUrl100);
      if (url) candidates.push({ url, source: "Apple Books", score: volume ? 3_000 : 1_000 });
    }
  }
  return candidates;
}

async function openLibraryCandidates({ fetchImpl, title, volume }) {
  const search = new URL("https://openlibrary.org/search.json");
  search.searchParams.set("q", volume
    ? `title:\"${englishSearchTitle(title)}\" \"Vol. ${volume}\"`
    : `title:\"${englishSearchTitle(title)}\"`);
  search.searchParams.set("fields", "title,subtitle,cover_i,language,publisher");
  search.searchParams.set("limit", "20");
  const results = await json(fetchImpl, search);
  return (results.docs || []).flatMap((work) => {
    const name = `${work?.title || ""} ${work?.subtitle || ""}`;
    if (!seriesMatches(name, title) || (volume && !containsVolume(name, volume))) return [];
    if (!Number.isInteger(work.cover_i) || work.cover_i < 1) return [];
    return [{
      url: `https://covers.openlibrary.org/b/id/${work.cover_i}-L.jpg?default=false`,
      source: "Open Library",
      score: volume ? 2_000 : 500
    }];
  });
}

async function downloadImage(fetchImpl, initialUrl) {
  let current = publicHttpsUrl(initialUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await request(fetchImpl, current, {
      redirect: "manual",
      headers: { Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.1" }
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = publicHttpsUrl(new URL(response.headers.get("location"), current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Cover download failed (${response.status})`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_COVER_BYTES) throw new Error("Cover is larger than 12 MB");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) throw new Error("Cover has an invalid size");
    const metadata = await sharp(bytes, { animated: false }).metadata();
    if (!metadata.width || !metadata.height || !["jpeg", "png"].includes(metadata.format)) {
      throw new Error("Cover is not a valid JPEG or PNG image");
    }
    return {
      bytes,
      width: metadata.width,
      height: metadata.height,
      contentType: metadata.format === "png" ? "image/png" : "image/jpeg"
    };
  }
  throw new Error("Cover redirected too many times");
}

async function resolveVolume({ fetchImpl, title, chapterNumber }) {
  if (!chapterNumber) return null;
  try {
    const search = new URL("https://api.mangadex.org/manga");
    search.searchParams.set("title", englishSearchTitle(title));
    search.searchParams.set("limit", "10");
    const results = await json(fetchImpl, search);
    const manga = selectMangaDexSeries(results.data, title);
    if (!manga?.id) return null;
    const aggregate = await json(fetchImpl, `https://api.mangadex.org/manga/${encodeURIComponent(manga.id)}/aggregate`);
    return volumeForChapter(aggregate, chapterNumber);
  } catch {
    return null;
  }
}

export async function resolveComicCover({ fetchImpl = fetch, title, fileName }) {
  const normalizedTitle = normalizeComicTitle(title);
  if (!normalizedTitle) return null;
  const chapterNumber = chapterNumberFromFileName(fileName);
  const volume = explicitVolumeFromFileName(fileName) ||
    await resolveVolume({ fetchImpl, title: normalizedTitle, chapterNumber });
  const candidates = [];
  candidates.push(...await appleBooksCandidates({ fetchImpl, title: normalizedTitle, volume }));
  try {
    candidates.push(...await openLibraryCandidates({ fetchImpl, title: normalizedTitle, volume }));
  } catch {
    // Apple Books may still have supplied an exact result.
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 16);
  let best = null;
  for (const candidate of unique) {
    try {
      const image = await downloadImage(fetchImpl, candidate.url);
      const rank = candidate.score * 1_000_000_000 + image.width * image.height;
      if (!best || rank > best.rank) best = { ...candidate, ...image, rank };
      if (image.width >= 1_200 && image.height >= 1_800) break;
    } catch {
      // Try the next matching catalog cover.
    }
  }
  return best ? { ...best, volume, chapterNumber } : null;
}
