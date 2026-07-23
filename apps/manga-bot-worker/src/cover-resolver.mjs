import fs from "node:fs/promises";
import path from "node:path";

import { parseChapterLabel } from "./chapters.mjs";
import { imageInfo } from "./epub.mjs";

const MAX_COVER_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const HIGH_RESOLUTION_COVER_WIDTH = 1_200;
const HIGH_RESOLUTION_COVER_HEIGHT = 1_800;
const ENGLISH_PUBLISHERS = [
  "viz", "shonen jump", "kodansha", "seven seas", "yen press", "dark horse",
  "vertical", "square enix", "j-novel", "denpa", "tokyopop", "mangamo"
];
const NON_SINGLE_VOLUME_WORDS = /\b(?:omnibus|3-in-1|box set|coloring book|collector(?:'s)? edition)\b/i;

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function englishSearchTitle(value) {
  return String(value || "")
    .replace(/\((?:[^)]*\b(?:colou?r|digital|official)\b[^)]*)\)/gi, " ")
    .replace(/\b(?:digital\s+)?colou?red(?:\s+comics?)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    const titles = titleValues(entry?.attributes);
    const scores = titles.map((title) => {
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
    (url.port && url.port !== "443") ||
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" ||
    host.endsWith(".local") || /^10[.]/.test(host) || /^192[.]168[.]/.test(host) ||
    /^172[.](?:1[6-9]|2\d|3[01])[.]/.test(host)
  ) {
    throw new Error("Unsafe manga cover URL");
  }
  return url;
}

async function request(fetchImpl, url, options = {}) {
  return fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "User-Agent": "manga-telegram-orchestrator/0.1 (Kindle cover lookup)",
      ...(options.headers || {})
    }
  });
}

async function json(fetchImpl, url) {
  const response = await request(fetchImpl, url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Cover metadata lookup failed (${response.status})`);
  return response.json();
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
    if (!response.ok) throw new Error(`English cover download failed (${response.status})`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_COVER_BYTES) throw new Error("English cover is larger than 12 MB");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) throw new Error("English cover has an invalid size");
    return { bytes, info: imageInfo(bytes), url: current.toString() };
  }
  throw new Error("English cover redirected too many times");
}

function slug(value) {
  return normalize(englishSearchTitle(value)).replace(/\s+/g, "-");
}

function metaContent(html, property) {
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attributes = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
      attributes[match[1].toLowerCase()] = match[2];
    }
    if (attributes.property?.toLowerCase() === property || attributes.name?.toLowerCase() === property) {
      return attributes.content || null;
    }
  }
  return null;
}

function containsVolume(value, volume) {
  const escaped = String(volume).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\bvol(?:ume)?[.]?\\s*|#\\s*|\\b)${escaped}(?![\\d.])`, "i").test(String(value || ""));
}

async function kodanshaCandidate({ fetchImpl, title, volume }) {
  const pageUrl = `https://kodansha.us/series/${slug(title)}/volume-${encodeURIComponent(volume)}/`;
  const response = await request(fetchImpl, pageUrl, { headers: { Accept: "text/html" } });
  if (!response.ok) return null;
  const html = await response.text();
  const pageTitle = metaContent(html, "og:title") || "";
  const requested = normalize(englishSearchTitle(title));
  if (!normalize(pageTitle).includes(requested) || !containsVolume(pageTitle, volume)) return null;
  let imageUrl = metaContent(html, "og:image");
  if (!imageUrl) return null;
  const parsed = publicHttpsUrl(imageUrl);
  if (parsed.hostname === "production.image.azuki.co" && parsed.pathname.endsWith(".webp")) {
    parsed.pathname = parsed.pathname.replace(/[.]webp$/i, ".jpg");
    imageUrl = parsed.toString();
  }
  return { url: imageUrl, source: "Kodansha", score: 2_000 };
}

function publishers(edition) {
  return (edition?.publishers || []).map((publisher) => String(publisher));
}

function isKnownEnglishPublisher(values) {
  const joined = values.join(" ").toLowerCase();
  return ENGLISH_PUBLISHERS.some((publisher) => joined.includes(publisher));
}

function isEnglishEdition(edition) {
  const explicit = (edition?.languages || []).some((language) => language?.key === "/languages/eng");
  return explicit || isKnownEnglishPublisher(publishers(edition));
}

function seriesMatches(value, title) {
  const candidate = normalize(value);
  const requested = normalize(englishSearchTitle(title));
  return candidate === requested || candidate.startsWith(`${requested} `) || candidate.includes(` ${requested} `);
}

function editionScore(edition, title, volume) {
  const name = `${edition?.title || ""} ${edition?.subtitle || ""}`;
  if (!seriesMatches(name, title) || !containsVolume(name, volume)) return -Infinity;
  let score = 200;
  const languageIsEnglish = (edition?.languages || []).some((language) => language?.key === "/languages/eng");
  if (languageIsEnglish) score += 100;
  if (isKnownEnglishPublisher(publishers(edition))) score += 60;
  if (NON_SINGLE_VOLUME_WORDS.test(name)) score -= 500;
  if ((edition?.isbn_10 || []).length > 0 || (edition?.isbn_13 || []).length > 0) score += 20;
  return score;
}

function workScore(work, title, volume) {
  const name = `${work?.title || ""} ${work?.subtitle || ""}`;
  if (!containsVolume(name, volume)) return -Infinity;
  const titleMatches = seriesMatches(name, title);
  if (!titleMatches && !isKnownEnglishPublisher(work?.publisher || [])) return -Infinity;
  let score = 100;
  if (!titleMatches) score -= 50;
  if (NON_SINGLE_VOLUME_WORDS.test(name)) score -= 500;
  if (normalize(name).startsWith(normalize(englishSearchTitle(title)))) score += 30;
  return score;
}

function vizCandidates(edition, score) {
  if (!publishers(edition).join(" ").match(/\b(?:viz|shonen jump)\b/i)) return [];
  return (edition.isbn_10 || []).map((isbn) => ({
    url: `https://dw9to29mmj727.cloudfront.net/products/${encodeURIComponent(isbn)}.jpg`,
    source: "VIZ",
    score: score + 1_000
  }));
}

function publisherHighResolutionCandidates(edition, score) {
  if (!publishers(edition).join(" ").match(/\b(?:viz|shonen jump)\b/i)) return [];
  return (edition.isbn_13 || [])
    .map((isbn) => String(isbn).replace(/[^\dX]/gi, ""))
    .filter((isbn) => /^\d{13}$/.test(isbn))
    .map((isbn) => ({
      url: `https://d28hgpri8am2if.cloudfront.net/book_images/cvr${isbn}_${isbn}_hr.jpg`,
      source: "Simon & Schuster (high-resolution English edition)",
      score: score + 1_200
    }));
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
  url.pathname = url.pathname.replace(
    /\/\d+x\d+bb[.](?:jpe?g|png)$/i,
    "/1600x2560bb.jpg"
  );
  return url.toString();
}

async function appleBooksCandidates({ fetchImpl, title, volume }) {
  const candidates = [];
  for (const country of ["gb", "us"]) {
    const search = new URL("https://itunes.apple.com/search");
    search.searchParams.set("term", `${englishSearchTitle(title)} Vol. ${volume}`);
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
      const isManga = (book?.genres || []).some((genre) => /manga/i.test(String(genre)));
      if (book?.kind !== "ebook" || !isManga || !seriesMatches(name, title) || !containsVolume(name, volume)) {
        continue;
      }
      const url = appleArtworkUrl(book.artworkUrl100);
      if (url) candidates.push({ url, source: "Apple Books (English edition)", score: 3_000 });
    }
  }
  return candidates;
}

async function openLibraryCandidates({ fetchImpl, title, volume }) {
  const query = `title:\"${englishSearchTitle(title)}\" \"Vol. ${volume}\"`;
  const search = new URL("https://openlibrary.org/search.json");
  search.searchParams.set("q", query);
  search.searchParams.set("language", "eng");
  search.searchParams.set("fields", "key,title,subtitle,cover_i,language,isbn,publisher");
  search.searchParams.set("limit", "20");
  const results = await json(fetchImpl, search);
  const works = (results.docs || [])
    .map((work) => ({ work, score: workScore(work, title, volume) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const candidates = [];
  for (const { work, score: baseScore } of works) {
    if (!/^\/works\/OL\d+W$/.test(work.key || "")) continue;
    const editions = await json(fetchImpl, `https://openlibrary.org${work.key}/editions.json?limit=100`);
    for (const edition of editions.entries || []) {
      if (!isEnglishEdition(edition)) continue;
      const score = baseScore + editionScore(edition, title, volume);
      if (!Number.isFinite(score)) continue;
      candidates.push(...publisherHighResolutionCandidates(edition, score));
      candidates.push(...vizCandidates(edition, score));
      for (const coverId of edition.covers || []) {
        if (Number.isInteger(coverId) && coverId > 0) {
          candidates.push({
            url: `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`,
            source: "Open Library (English edition)",
            score
          });
        }
      }
    }
  }
  return candidates;
}

function plainWikiHeading(value) {
  return String(value || "")
    .replace(/'{2,5}/g, "")
    .replace(/\[\[(?:[^|\]]+[|])?([^\]]+)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function wikipediaSeriesSection(wikitext, title) {
  const source = String(wikitext || "");
  const requested = normalize(englishSearchTitle(title));
  const headings = [...source.matchAll(/^==\s*([^=\n].*?[^=\n])\s*==\s*$/gm)];
  const match = headings.find((heading) => normalize(plainWikiHeading(heading[1])) === requested);
  if (!match) return source;
  const start = match.index + match[0].length;
  const next = headings.find((heading) => heading.index > match.index);
  return source.slice(start, next?.index ?? source.length);
}

function chapterNumberFromWikiLine(line) {
  const explicit = String(line || "").match(/^\s*\|\s*ChapterNumber\s*=\s*([^\n]+)/i);
  const value = explicit?.[1] || String(line || "").match(/^\s*[*#]+\s*(.+)$/)?.[1];
  if (!value) return null;
  const match = value.match(/(?:^|[|'])\s*(?:chapter\s*)?(\d+(?:[.,]\d+)?)(?!\d)/i) ||
    value.match(/^\s*(?:chapter\s*)?(\d+(?:[.,]\d+)?)(?!\d)/i);
  return match ? numeric(match[1]) : null;
}

export function volumeFromWikipediaWikitext(wikitext, title, chapterNumber) {
  const target = numeric(chapterNumber);
  if (target === null) return null;
  const section = wikipediaSeriesSection(wikitext, title);
  let volume = null;
  let inChapterList = false;
  for (const line of section.split(/\r?\n/)) {
    const volumeMatch = line.match(/^\s*\|\s*VolumeNumber\s*=\s*[^\d\n]*(\d+(?:[.,]\d+)?)/i);
    if (volumeMatch) {
      volume = String(volumeMatch[1]).replace(",", ".");
      inChapterList = false;
      continue;
    }
    if (/^\s*\|\s*ChapterList\s*=/i.test(line)) inChapterList = true;
    if (!volume || (!inChapterList && !/^\s*\|\s*ChapterNumber\s*=/i.test(line))) continue;
    const number = chapterNumberFromWikiLine(line);
    if (number !== null && Math.abs(number - target) < 0.000001) return volume;
  }
  return null;
}

async function wikipediaWikitext(fetchImpl, page) {
  const api = new URL("https://en.wikipedia.org/w/api.php");
  api.searchParams.set("action", "parse");
  api.searchParams.set("page", page);
  api.searchParams.set("prop", "wikitext");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  const result = await json(fetchImpl, api);
  return typeof result?.parse?.wikitext === "string" ? result.parse.wikitext : null;
}

function wikipediaSearchScore(page, title) {
  const candidate = normalize(page);
  const requested = normalize(englishSearchTitle(title));
  const exact = normalize(`List of ${englishSearchTitle(title)} chapters`);
  if (candidate === exact) return 1_000;
  if (candidate.startsWith("list of ") && candidate.includes(requested) && candidate.includes("chapter")) return 500;
  if (candidate.includes(requested) && candidate.includes("chapter")) return 250;
  return 0;
}

async function resolveWikipediaVolume({ fetchImpl, title, chapterNumber }) {
  const directPage = `List of ${englishSearchTitle(title)} chapters`;
  const direct = await wikipediaWikitext(fetchImpl, directPage);
  if (direct) {
    const volume = volumeFromWikipediaWikitext(direct, title, chapterNumber);
    if (volume) return volume;
  }

  const api = new URL("https://en.wikipedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("list", "search");
  api.searchParams.set("srsearch", `intitle:${JSON.stringify(englishSearchTitle(title))} chapters`);
  api.searchParams.set("srnamespace", "0");
  api.searchParams.set("srlimit", "10");
  api.searchParams.set("srprop", "");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  const results = await json(fetchImpl, api);
  const pages = (results?.query?.search || [])
    .map((entry) => ({ title: entry?.title, score: wikipediaSearchScore(entry?.title, title) }))
    .filter((entry) => entry.title && entry.score > 0 && entry.title !== directPage)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
  for (const page of pages) {
    const wikitext = await wikipediaWikitext(fetchImpl, page.title);
    const volume = volumeFromWikipediaWikitext(wikitext, title, chapterNumber);
    if (volume) return volume;
  }
  return null;
}

export async function resolveMangaVolume({ fetchImpl = fetch, title, chapterNumber }) {
  const searchTitle = englishSearchTitle(title);
  try {
    const search = new URL("https://api.mangadex.org/manga");
    search.searchParams.set("title", searchTitle);
    search.searchParams.set("limit", "10");
    const results = await json(fetchImpl, search);
    const manga = selectMangaDexSeries(results.data, searchTitle);
    if (manga?.id) {
      const aggregate = await json(fetchImpl, `https://api.mangadex.org/manga/${encodeURIComponent(manga.id)}/aggregate`);
      const exact = volumeForChapter(aggregate, chapterNumber);
      if (exact) return exact;
    }
  } catch {
    // MangaDex metadata is often incomplete or temporarily unavailable.
  }
  try {
    return await resolveWikipediaVolume({ fetchImpl, title, chapterNumber });
  } catch {
    return null;
  }
}

export async function resolveEnglishVolumeCover({ fetchImpl = fetch, title, volume }) {
  const candidates = [];
  candidates.push(...await appleBooksCandidates({ fetchImpl, title, volume }));
  try {
    const kodansha = await kodanshaCandidate({ fetchImpl, title, volume });
    if (kodansha) candidates.push(kodansha);
  } catch {
    // Other publishers normally return 404 here; continue with the English catalog.
  }
  try {
    candidates.push(...await openLibraryCandidates({ fetchImpl, title, volume }));
  } catch {
    // A catalog outage should not prevent the series-cover fallback.
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 16);
  let best = null;
  for (const candidate of unique) {
    try {
      const image = await downloadImage(fetchImpl, candidate.url);
      const highResolution = image.info.width >= HIGH_RESOLUTION_COVER_WIDTH &&
        image.info.height >= HIGH_RESOLUTION_COVER_HEIGHT;
      const qualityTier = highResolution ? 3
        : image.info.width >= 700 && image.info.height >= 1_000 ? 2
          : image.info.width >= 500 && image.info.height >= 750 ? 1
            : 0;
      const rank = qualityTier * 1_000_000_000_000_000 +
        candidate.score * 1_000_000_000 + image.info.width * image.info.height;
      if (!best || rank > best.rank) best = { ...candidate, ...image, rank };
      if (highResolution) break;
    } catch {
      // Try the next exact English-edition cover.
    }
  }
  return best;
}

export async function resolveEnglishChapterCover({
  fetchImpl = fetch,
  title,
  chapterLabel,
  fallbackCoverPath,
  destinationDir,
  index = 0,
  lookup = true
}) {
  const chapterNumber = parseChapterLabel(chapterLabel);
  if (!lookup || !chapterNumber) {
    return { coverPath: fallbackCoverPath, source: "series fallback", volume: null, chapterNumber };
  }
  try {
    const volume = await resolveMangaVolume({ fetchImpl, title, chapterNumber });
    if (!volume) return { coverPath: fallbackCoverPath, source: "series fallback", volume: null, chapterNumber };
    const cover = await resolveEnglishVolumeCover({ fetchImpl, title, volume });
    if (!cover) return { coverPath: fallbackCoverPath, source: "series fallback", volume, chapterNumber };
    const outputPath = path.join(
      destinationDir,
      `.cover-${String(index + 1).padStart(4, "0")}.${cover.info.extension}`
    );
    await fs.writeFile(outputPath, cover.bytes, { mode: 0o600 });
    return { coverPath: outputPath, source: cover.source, volume, chapterNumber, temporary: true };
  } catch (error) {
    console.warn(`English cover lookup failed for ${title} ${chapterLabel}: ${error.message}`);
    return { coverPath: fallbackCoverPath, source: "series fallback", volume: null, chapterNumber };
  }
}
