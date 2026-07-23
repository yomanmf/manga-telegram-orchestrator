import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const EPUB_NAMESPACE = "http://www.idpf.org/2007/ops";
const EPUB_MIMETYPE = "application/epub+zip";

const CRC_TABLE = Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ data[index]) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  const valid = Number.isFinite(parsed.getTime());
  const year = valid ? Math.max(1980, parsed.getUTCFullYear()) : 1980;
  const month = valid ? parsed.getUTCMonth() + 1 : 1;
  const day = valid ? parsed.getUTCDate() : 1;
  return { date: ((year - 1980) << 9) | (month << 5) | day, time: 0 };
}

async function writeZip(entries, outputPath, timestamp) {
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  const prepared = [];
  const { date, time } = zipDate(timestamp);
  let offset = 0;
  const output = await fs.open(temporaryPath, "w", 0o600);

  async function write(buffer) {
    let bufferOffset = 0;
    while (bufferOffset < buffer.length) {
      const { bytesWritten } = await output.write(
        buffer,
        bufferOffset,
        buffer.length - bufferOffset,
        offset + bufferOffset
      );
      if (bytesWritten <= 0) throw new Error("Could not finish writing the EPUB archive");
      bufferOffset += bytesWritten;
    }
    offset += buffer.length;
  }

  try {
    for (const entry of entries) {
      const data = entry.data ?? await fs.readFile(entry.filePath);
      const name = Buffer.from(entry.name, "utf8");
      const method = entry.compress === false ? 0 : 8;
      const compressed = method === 0 ? data : deflateRawSync(data, { level: 9 });
      const checksum = crc32(data);
      const entryOffset = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      await write(header);
      await write(name);
      await write(compressed);
      prepared.push({
        name,
        method,
        checksum,
        compressedSize: compressed.length,
        size: data.length,
        offset: entryOffset
      });
    }

    const centralOffset = offset;
    for (const entry of prepared) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(entry.checksum, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);
      await write(header);
      await write(entry.name);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(prepared.length, 8);
    end.writeUInt16LE(prepared.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await write(end);
    await output.sync();
    await output.close();
    await fs.rename(temporaryPath, outputPath);
    return offset;
  } catch (error) {
    await output.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;"
  })[character] ?? character);
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && length >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

export function imageInfo(buffer) {
  const png = pngDimensions(buffer);
  if (png) return { ...png, extension: "png", mediaType: "image/png" };
  const jpeg = jpegDimensions(buffer);
  if (jpeg) return { ...jpeg, extension: "jpg", mediaType: "image/jpeg" };
  throw new Error("The Kindle cover is not a valid JPEG or PNG image");
}

function pageImageFileName(page, pageIndex, imageIndex) {
  const pageNumber = String(pageIndex + 1).padStart(4, "0");
  const imageNumber = page.images.length === 1
    ? ""
    : `-${String(imageIndex + 1).padStart(2, "0")}`;
  return `page-${pageNumber}${imageNumber}.${page.images[imageIndex].extension}`;
}

function imagePageDocument(title, page, pageIndex, type) {
  const images = page.images.map((image, imageIndex) => {
    const href = `images/${pageImageFileName(page, pageIndex, imageIndex)}`;
    return `<image x="${image.x}" y="${image.y}" width="${image.width}" height="${image.height}" preserveAspectRatio="none" xlink:href="${escapeXml(href)}" href="${escapeXml(href)}"/>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="${XHTML_NAMESPACE}" xmlns:epub="${EPUB_NAMESPACE}" lang="en"><head><title>${escapeXml(title)}</title>
<meta name="viewport" content="width=${page.width},height=${page.height}"/><style>html,body,svg{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}</style></head>
<body${type ? ` epub:type="${type}"` : ""}><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${page.width} ${page.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeXml(title)}">
<rect width="${page.width}" height="${page.height}" fill="#fff"/>
${images}</svg></body></html>`;
}

function navDocument(title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="${XHTML_NAMESPACE}" xmlns:epub="${EPUB_NAMESPACE}" lang="en"><head><title>${escapeXml(title)}</title></head><body>
<nav epub:type="toc" id="toc"><h1>${escapeXml(title)}</h1><ol><li><a href="page-0001.xhtml">Start</a></li></ol></nav>
<nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="cover" href="page-0001.xhtml">Cover</a></li><li><a epub:type="bodymatter" href="page-0001.xhtml">Beginning</a></li></ol></nav>
</body></html>`;
}

function ncxDocument(identifier, title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(identifier)}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap><navPoint id="start" playOrder="1"><navLabel><text>Start</text></navLabel><content src="page-0001.xhtml"/></navPoint></navMap></ncx>`;
}

function packageDocument({ identifier, title, modifiedDate, cover, pages }) {
  const originalWidth = Math.max(...pages.map((page) => page.width));
  const originalHeight = Math.max(...pages.map((page) => page.height));
  const pageManifest = pages.map((page, index) => {
    const number = String(index + 1).padStart(4, "0");
    const images = page.images.map((image, imageIndex) => {
      const imageNumber = page.images.length === 1
        ? number
        : `${number}-${String(imageIndex + 1).padStart(2, "0")}`;
      return `<item id="page-image-${imageNumber}" href="images/${pageImageFileName(page, index, imageIndex)}" media-type="${image.mediaType}"/>`;
    }).join("");
    return `${images}<item id="page-${number}" href="page-${number}.xhtml" media-type="application/xhtml+xml" properties="svg"/>`;
  }).join("\n    ");
  const spine = pages.map((_page, index) => `<itemref idref="page-${String(index + 1).padStart(4, "0")}" properties="page-spread-center"/>`).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>Manga</dc:creator><dc:language>en</dc:language><dc:publisher>manga-telegram-orchestrator</dc:publisher>
    <meta property="dcterms:modified">${escapeXml(`${modifiedDate}T00:00:00Z`)}</meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">auto</meta><meta property="rendition:spread">none</meta><meta name="fixed-layout" content="true"/><meta name="original-resolution" content="${originalWidth}x${originalHeight}"/><meta name="primary-writing-mode" content="horizontal-rl"/><meta name="book-type" content="comic"/><meta name="cover" content="cover-image"/>
  </metadata>
  <manifest><item id="cover-image" href="images/cover.${cover.extension}" media-type="${cover.mediaType}" properties="cover-image"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${pageManifest}
  </manifest>
  <spine toc="ncx" page-progression-direction="rtl">${spine}
  </spine>
  <guide><reference type="cover" title="Cover" href="page-0001.xhtml"/><reference type="text" title="Beginning" href="page-0001.xhtml"/></guide>
</package>`;
}

async function renderPdfPages(pdfPath, destinationDir) {
  const prefix = path.join(destinationDir, "page");
  await new Promise((resolve, reject) => {
    const child = spawn("pdftoppm", [
      "-jpeg",
      "-r", "72",
      "-jpegopt", "quality=92,optimize=y,progressive=n",
      pdfPath,
      prefix
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
    child.once("error", (error) => {
      if (error?.code === "ENOENT") reject(new Error("pdftoppm is required to create Kindle EPUB files"));
      else reject(error);
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`PDF page rendering failed (${signal || code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
  const files = (await fs.readdir(destinationDir))
    .filter((name) => /^page-\d+[.]jpg$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (files.length === 0) throw new Error("PDF page rendering produced no JPEG files");
  return files.map((name) => path.join(destinationDir, name));
}

export async function buildFixedLayoutMangaEpub({
  outputPath,
  title,
  coverPath,
  pagePaths,
  pageInfos = null,
  pageLayouts = null,
  modifiedDate = new Date().toISOString().slice(0, 10)
}) {
  if ((!Array.isArray(pagePaths) || pagePaths.length === 0) && (!Array.isArray(pageLayouts) || pageLayouts.length === 0)) {
    throw new Error("Cannot create an empty manga EPUB");
  }
  if (pageLayouts && pagePaths) throw new Error("Manga EPUB pages must use paths or layouts, not both");
  const coverBytes = await fs.readFile(coverPath);
  const cover = imageInfo(coverBytes);
  const pages = [];
  if (pageLayouts) {
    for (const layout of pageLayouts) {
      if (
        !Number.isSafeInteger(layout?.width) || !Number.isSafeInteger(layout?.height) ||
        layout.width <= 0 || layout.height <= 0 ||
        !Array.isArray(layout.images) || layout.images.length === 0
      ) {
        throw new Error("Manga EPUB page layout is invalid");
      }
      const images = [];
      for (const image of layout.images) {
        const info = image.info || imageInfo(await fs.readFile(image.filePath));
        const validFormat =
          (info.extension === "jpg" && info.mediaType === "image/jpeg") ||
          (info.extension === "png" && info.mediaType === "image/png");
        if (
          !validFormat || !image.filePath ||
          !Number.isSafeInteger(image.x) || !Number.isSafeInteger(image.y) ||
          !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
          image.x < 0 || image.y < 0 || image.width <= 0 || image.height <= 0 ||
          image.x + image.width > layout.width || image.y + image.height > layout.height
        ) {
          throw new Error("Manga EPUB page image layout is invalid");
        }
        images.push({
          filePath: image.filePath,
          x: image.x,
          y: image.y,
          width: image.width,
          height: image.height,
          extension: info.extension,
          mediaType: info.mediaType
        });
      }
      pages.push({ width: layout.width, height: layout.height, images });
    }
  } else {
    if (pageInfos && pageInfos.length !== pagePaths.length) {
      throw new Error("Manga EPUB page metadata does not match the page list");
    }
    for (let index = 0; index < pagePaths.length; index += 1) {
      const pagePath = pagePaths[index];
      const info = pageInfos?.[index] || imageInfo(await fs.readFile(pagePath));
      if (info.mediaType !== "image/jpeg") throw new Error("Rendered manga pages must be JPEG images");
      if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width <= 0 || info.height <= 0) {
        throw new Error("Rendered manga page dimensions are invalid");
      }
      pages.push({
        width: info.width,
        height: info.height,
        images: [{
          filePath: pagePath,
          x: 0,
          y: 0,
          width: info.width,
          height: info.height,
          extension: info.extension,
          mediaType: info.mediaType
        }]
      });
    }
  }
  const identifier = `urn:uuid:${crypto.randomUUID()}`;
  const entries = [
    { name: "mimetype", data: Buffer.from(EPUB_MIMETYPE), compress: false },
    { name: "META-INF/container.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/content.opf", data: Buffer.from(packageDocument({ identifier, title, modifiedDate, cover, pages })) },
    { name: "OEBPS/nav.xhtml", data: Buffer.from(navDocument(title)) },
    { name: "OEBPS/toc.ncx", data: Buffer.from(ncxDocument(identifier, title)) },
    { name: `OEBPS/images/cover.${cover.extension}`, filePath: coverPath, compress: false },
    ...pages.flatMap((page, index) => {
      const number = String(index + 1).padStart(4, "0");
      return [
        { name: `OEBPS/page-${number}.xhtml`, data: Buffer.from(imagePageDocument(`${title} - page ${index + 1}`, page, index, index === 0 ? "cover bodymatter" : "bodymatter")) },
        ...page.images.map((image, imageIndex) => ({
          name: `OEBPS/images/${pageImageFileName(page, index, imageIndex)}`,
          filePath: image.filePath,
          compress: false
        }))
      ];
    })
  ];
  return writeZip(entries, outputPath, modifiedDate);
}

export async function buildMangaEpubFromPdf({ pdfPath, outputPath, title, coverPath, modifiedDate = new Date().toISOString().slice(0, 10) }) {
  const renderDir = await fs.mkdtemp(path.join(path.dirname(outputPath), ".epub-pages-"));
  try {
    const pagePaths = await renderPdfPages(pdfPath, renderDir);
    return await buildFixedLayoutMangaEpub({ outputPath, title, coverPath, pagePaths, modifiedDate });
  } finally {
    await fs.rm(renderDir, { recursive: true, force: true });
  }
}
