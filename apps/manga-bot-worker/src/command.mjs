const SEND_PATTERNS = [
  /^(?:отправь|пришли|скинь)\s+(?:мне\s+)?(?:на\s+kindle\s+)?(.+?)\s+с\s+(?:главы\s+)?([\d.,]+)\s+(?:до|по)\s+(?:самой\s+)?((?:последней(?:\s+главы)?)|latest|[\d.,]+)$/i,
  /^(?:send)\s+(.+?)\s+(?:from)\s+(?:chapter\s+)?([\d.]+)\s+(?:to)\s+((?:latest|last)|[\d.]+)$/i
];

export function parseCommand(text) {
  const input = String(text || "").trim().replace(/\s+/g, " ");

  for (const pattern of SEND_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      const fromChapter = normalizeChapterNumber(match[2]);
      const toChapter = /^(?:последней(?:\s+главы)?|latest|last)$/i.test(match[3])
        ? "latest"
        : normalizeChapterNumber(match[3]);
      if (toChapter !== "latest" && Number(toChapter) < Number(fromChapter)) {
        throw new Error("Конечная глава не может быть меньше начальной");
      }
      return {
        type: "send",
        titleQuery: cleanTitle(match[1]),
        fromChapter,
        toChapter
      };
    }
  }

  if (/^\/status(?:\s|$)/i.test(input) || /^статус$/i.test(input)) {
    return { type: "status" };
  }
  if (/^\/cancel(?:\s|$)/i.test(input) || /^отмена$/i.test(input)) {
    return { type: "cancel" };
  }
  if (/^\/retry(?:\s|$)/i.test(input) || /^повтори$/i.test(input)) {
    return { type: "retry" };
  }
  if (/^\/kindle(?:\s|$)/i.test(input) || /^kindle$/i.test(input)) {
    return { type: "kindle" };
  }
  const merge = input.match(/^\/merge(?:\s+(on|off))?$/i);
  if (merge) {
    return { type: "merge", enabled: merge[1] ? merge[1].toLowerCase() === "on" : null };
  }
  if (/^\/start(?:\s|$)/i.test(input) || /^помощь$/i.test(input)) {
    return { type: "help" };
  }

  return { type: "unknown", input };
}

export function normalizeChapterNumber(value) {
  const normalized = String(value || "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Номер главы должен быть числом, например 201 или 201.5");
  }
  return normalized;
}

export function cleanTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  if (title.length < 2 || title.length > 140) {
    throw new Error("Название манги должно содержать от 2 до 140 символов");
  }
  return title;
}

export function normalizeTitle(value) {
  return String(value || "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function helpText() {
  return [
    "Я собираю мангу в PDF и отправляю её на Kindle.",
    "",
    "Пример:",
    "Отправь Fable с 201 до последней",
    "Отправь One Piece (Color) с 23 до 100",
    "",
    "Команды: /status, /cancel, /retry, /kindle, /merge [on|off]"
  ].join("\n");
}
