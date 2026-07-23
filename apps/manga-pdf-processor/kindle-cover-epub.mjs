import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import sharp from "sharp";

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;"
  })[character]);
}

function runPdfToPpm(pdfPath, outputPrefix) {
  return new Promise((resolve, reject) => {
    const child = spawn("pdftoppm", [
      "-jpeg",
      "-r", "72",
      "-jpegopt", "quality=92,optimize=y,progressive=n",
      pdfPath,
      outputPrefix
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", (error) => {
      reject(error?.code === "ENOENT"
        ? new Error("pdftoppm is required to create covered Kindle EPUB files")
        : error);
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `PDF page rendering failed (${signal || code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      ));
    });
  });
}

function pageDocument(title, page, number) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>${escapeXml(title)} — ${number}</title>
<meta name="viewport" content="width=${page.width},height=${page.height}"/><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}img{display:block;width:100%;height:100%;object-fit:contain}</style></head>
<body epub:type="bodymatter"><img src="images/page-${number}.jpg" width="${page.width}" height="${page.height}" alt="${escapeXml(title)} — page ${Number(number)}"/></body></html>`;
}

function packageDocument({ identifier, title, coverExtension, pages, rightToLeft }) {
  const pageManifest = pages.map((_page, index) => {
    const number = String(index + 1).padStart(4, "0");
    return `<item id="page-image-${number}" href="images/page-${number}.jpg" media-type="image/jpeg"/><item id="page-${number}" href="page-${number}.xhtml" media-type="application/xhtml+xml"/>`;
  }).join("\n    ");
  const spine = pages.map((_page, index) =>
    `<itemref idref="page-${String(index + 1).padStart(4, "0")}" properties="page-spread-center"/>`
  ).join("\n    ");
  const direction = rightToLeft ? "rtl" : "ltr";
  const writingMode = rightToLeft ? "rl" : "lr";
  const width = Math.max(...pages.map((page) => page.width));
  const height = Math.max(...pages.map((page) => page.height));
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>Comics</dc:creator><dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">auto</meta><meta property="rendition:spread">none</meta><meta name="fixed-layout" content="true"/><meta name="original-resolution" content="${width}x${height}"/><meta name="primary-writing-mode" content="horizontal-${writingMode}"/><meta name="book-type" content="comic"/><meta name="cover" content="cover-image"/>
  </metadata>
  <manifest><item id="cover-image" href="images/cover.${coverExtension}" media-type="image/${coverExtension === "jpg" ? "jpeg" : "png"}" properties="cover-image"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${pageManifest}
  </manifest>
  <spine toc="ncx" page-progression-direction="${direction}">${spine}</spine>
  <guide><reference type="text" title="Beginning" href="page-0001.xhtml"/></guide>
</package>`;
}

export async function buildCoveredKindleEpub({
  pdfBytes,
  coverBytes,
  coverContentType,
  title,
  rightToLeft = true
}) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "manga-web-epub-"));
  try {
    const pdfPath = path.join(workDir, "document.pdf");
    const outputPrefix = path.join(workDir, "page");
    await fs.writeFile(pdfPath, pdfBytes, { mode: 0o600 });
    await runPdfToPpm(pdfPath, outputPrefix);
    const pageNames = (await fs.readdir(workDir))
      .filter((name) => /^page-\d+[.]jpg$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (pageNames.length === 0) throw new Error("PDF page rendering produced no images");

    const pages = [];
    for (const name of pageNames) {
      const bytes = await fs.readFile(path.join(workDir, name));
      const metadata = await sharp(bytes, { animated: false }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("Rendered PDF page dimensions are invalid");
      pages.push({ bytes, width: metadata.width, height: metadata.height });
    }

    const coverExtension = coverContentType === "image/png" ? "png" : "jpg";
    const identifier = `urn:uuid:${crypto.randomUUID()}`;
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file("OEBPS/content.opf", packageDocument({ identifier, title, coverExtension, pages, rightToLeft }));
    zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>${escapeXml(title)}</title></head><body><nav epub:type="toc"><h1>${escapeXml(title)}</h1><ol><li><a href="page-0001.xhtml">Start</a></li></ol></nav><nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="bodymatter" href="page-0001.xhtml">Beginning</a></li></ol></nav></body></html>`);
    zip.file("OEBPS/toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(identifier)}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap><navPoint id="start" playOrder="1"><navLabel><text>Start</text></navLabel><content src="page-0001.xhtml"/></navPoint></navMap></ncx>`);
    zip.file(`OEBPS/images/cover.${coverExtension}`, coverBytes, { compression: "STORE" });
    pages.forEach((page, index) => {
      const number = String(index + 1).padStart(4, "0");
      zip.file(`OEBPS/page-${number}.xhtml`, pageDocument(title, page, number));
      zip.file(`OEBPS/images/page-${number}.jpg`, page.bytes, { compression: "STORE" });
    });
    return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
