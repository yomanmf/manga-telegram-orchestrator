import crypto from "node:crypto";

const SOURCE_IDS = new Set(["my_news_kindle_bot", "my_books_kindle_bot", "my_manga_kindle_bot", "tetra", "rekindle"]);
const STATUSES = new Set(["received", "accepted", "success", "error", "cancelled"]);

export function registerAnalyticsRoutes(app, { store, ingestToken, dashboardUsername, dashboardPassword }) {
  app.post("/analytics/events", (req, res) => {
    if (!ingestToken || !secureEqual(req.get("Authorization"), `Bearer ${ingestToken}`)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const event = validateEvent(req.body || {});
      store.upsertAnalyticsEvent(event);
      res.status(202).json({ ok: true, eventId: event.eventId });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/analytics", (req, res) => {
    if (!dashboardAuthorized(req, dashboardUsername, dashboardPassword)) {
      res.set("WWW-Authenticate", 'Basic realm="Kindle bot analytics", charset="UTF-8"');
      res.status(401).send("Authentication required");
      return;
    }
    const botId = SOURCE_IDS.has(String(req.query.bot || "")) ? String(req.query.bot) : "";
    const days = boundedInteger(req.query.days, 30, 1, 365);
    const events = store.listAnalyticsEvents({ botId, days, limit: 1_000 });
    res.type("html").send(renderDashboard({ events, botId, days }));
  });
}

export function validateEvent(input) {
  const eventId = requiredString(input.eventId, "eventId", 200);
  const botId = requiredString(input.botId, "botId", 80);
  if (!SOURCE_IDS.has(botId)) throw new Error("botId is not supported");
  const status = requiredString(input.status, "status", 24);
  if (!STATUSES.has(status)) throw new Error("status is not supported");
  const startedAt = optionalDate(input.startedAt, "startedAt") || new Date().toISOString();
  const finishedAt = optionalDate(input.finishedAt, "finishedAt");
  const durationMs = optionalInteger(input.durationMs, "durationMs", 0, 86_400_000);
  return {
    eventId,
    botId,
    status,
    requestType: optionalString(input.requestType, "requestType", 80),
    userId: optionalUserIdentifier(input.userId, "userId"),
    telegramUserId: optionalIdentifier(input.telegramUserId, "telegramUserId"),
    username: optionalString(input.username, "username", 64),
    chatId: optionalIdentifier(input.chatId, "chatId"),
    requestText: optionalString(input.requestText, "requestText", 20_000),
    resultText: optionalString(input.resultText, "resultText", 50_000),
    errorText: optionalString(input.errorText, "errorText", 20_000),
    startedAt,
    finishedAt,
    durationMs,
    metadata: plainObject(input.metadata, "metadata")
  };
}

function renderDashboard({ events, botId, days }) {
  const total = events.length;
  const users = new Set(events.map((event) => event.userId || event.telegramUserId).filter(Boolean)).size;
  const errors = events.filter((event) => event.status === "error").length;
  const completed = events.filter((event) => event.status === "success");
  const averageDuration = completed.length
    ? Math.round(completed.reduce((sum, event) => sum + (event.durationMs || 0), 0) / completed.length)
    : 0;
  const daily = aggregateDaily(events, days);
  const byBot = aggregate(events, (event) => event.botId);
  const byType = aggregate(events, (event) => event.requestType || "other").slice(0, 10);
  const rows = events.map((event) => `
    <tr>
      <td class="nowrap">${escapeHtml(formatDate(event.startedAt))}</td>
      <td>${escapeHtml(botLabel(event.botId))}</td>
      <td>${escapeHtml(userLabel(event))}</td>
      <td>${escapeHtml(event.requestType || "—")}</td>
      <td class="wrap">${escapeHtml(event.requestText || "—")}</td>
      <td class="wrap">${escapeHtml(event.resultText || event.errorText || "—")}</td>
      <td><span class="status ${escapeHtml(event.status)}">${escapeHtml(event.status)}</span></td>
      <td class="nowrap">${event.durationMs == null ? "—" : `${event.durationMs} ms`}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kindle services analytics</title>
<style>
:root{color-scheme:dark;--bg:#0c1220;--panel:#151d2f;--muted:#8d9bb8;--line:#27334e;--accent:#7aa2ff;--ok:#43d17f;--bad:#ff6b7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#f1f5ff;font:14px/1.45 system-ui,sans-serif}
main{max-width:1500px;margin:auto;padding:28px}h1{margin:0 0 4px;font-size:28px}h2{font-size:17px;margin:0 0 18px}.muted{color:var(--muted)}
form{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}select,button{background:var(--panel);border:1px solid var(--line);color:inherit;padding:9px 12px;border-radius:8px}button{background:var(--accent);color:#081126;border:0;font-weight:700}
.cards{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:14px}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}.metric{font-size:28px;font-weight:750;margin-top:4px}
.charts{display:grid;grid-template-columns:2fr 1fr 1fr;gap:14px;margin:14px 0}.chart{min-height:230px}.bars{display:flex;align-items:end;gap:4px;height:160px;border-bottom:1px solid var(--line)}.bar{background:linear-gradient(#7aa2ff,#537ad7);min-width:5px;flex:1;border-radius:4px 4px 0 0;position:relative}.bar:hover:after{content:attr(data-tip);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);padding:4px 6px;background:#000;border-radius:4px;white-space:nowrap;z-index:2}
.hbar{display:grid;grid-template-columns:110px 1fr 35px;gap:8px;align-items:center;margin:8px 0}.track{height:9px;background:#26324b;border-radius:5px;overflow:hidden}.fill{height:100%;background:var(--accent)}
.table-wrap{overflow:auto;max-height:650px}table{width:100%;border-collapse:collapse;min-width:1100px}th{position:sticky;top:0;background:#1b253a;text-align:left;color:#b7c4de}th,td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}.wrap{white-space:pre-wrap;max-width:340px;overflow-wrap:anywhere}.nowrap{white-space:nowrap}.status{font-size:12px;padding:3px 7px;border-radius:999px;background:#313d57}.status.success{color:var(--ok)}.status.error{color:var(--bad)}
@media(max-width:900px){main{padding:16px}.cards{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Аналитика Kindle-сервисов</h1><div class="muted">Запросы, результаты и активность пользователей</div>
<form method="get"><select name="bot"><option value="">Все сервисы</option>${sourceOptions(botId)}</select><select name="days">${dayOptions(days)}</select><button type="submit">Применить</button></form>
<section class="cards"><div class="card"><div class="muted">Запросов</div><div class="metric">${total}</div></div><div class="card"><div class="muted">Пользователей</div><div class="metric">${users}</div></div><div class="card"><div class="muted">Ошибок</div><div class="metric">${errors}</div></div><div class="card"><div class="muted">Среднее время</div><div class="metric">${formatDuration(averageDuration)}</div></div></section>
<section class="charts"><div class="panel chart"><h2>Запросы по дням</h2>${verticalBars(daily)}</div><div class="panel chart"><h2>По сервисам</h2>${horizontalBars(byBot, botLabel)}</div><div class="panel chart"><h2>Типы запросов</h2>${horizontalBars(byType)}</div></section>
<section class="panel"><h2>История запросов</h2><div class="table-wrap"><table><thead><tr><th>Время</th><th>Сервис</th><th>Пользователь</th><th>Тип</th><th>Запрос</th><th>Результат</th><th>Статус</th><th>Время</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">Событий пока нет</td></tr>'}</tbody></table></div></section>
</main></body></html>`;
}

function aggregateDaily(events, days) {
  const values = new Map();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
    values.set(date, 0);
  }
  for (const event of events) {
    const date = event.startedAt.slice(0, 10);
    if (values.has(date)) values.set(date, values.get(date) + 1);
  }
  return [...values].map(([label, value]) => ({ label, value }));
}

function aggregate(events, key) {
  const values = new Map();
  for (const event of events) {
    const label = key(event);
    values.set(label, (values.get(label) || 0) + 1);
  }
  return [...values].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function verticalBars(items) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return `<div class="bars">${items.map((item) => `<div class="bar" data-tip="${escapeHtml(`${item.label}: ${item.value}`)}" style="height:${Math.max(item.value / max * 100, item.value ? 4 : 0)}%"></div>`).join("")}</div>`;
}

function horizontalBars(items, labeler = (value) => value) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return items.map((item) => `<div class="hbar"><span>${escapeHtml(labeler(item.label))}</span><div class="track"><div class="fill" style="width:${item.value / max * 100}%"></div></div><b>${item.value}</b></div>`).join("") || '<span class="muted">Нет данных</span>';
}

function sourceOptions(selected) {
  return [...SOURCE_IDS].map((id) => `<option value="${id}"${selected === id ? " selected" : ""}>${escapeHtml(botLabel(id))}</option>`).join("");
}

function dayOptions(selected) {
  return [7, 30, 90, 365].map((value) => `<option value="${value}"${selected === value ? " selected" : ""}>${value} дней</option>`).join("");
}

function botLabel(id) {
  return ({ my_news_kindle_bot: "Новости", my_books_kindle_bot: "Книги", my_manga_kindle_bot: "Манга", tetra: "TETRA", rekindle: "ReKindle" })[id] || id;
}

function userLabel(event) {
  if (!event.telegramUserId && !event.username) return event.userId || "аноним";
  const username = event.username ? `@${event.username}` : "без username";
  return `${username} (${event.telegramUserId || "—"})`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Moscow" }).format(new Date(value));
}

function formatDuration(milliseconds) {
  if (!milliseconds) return "—";
  if (milliseconds < 1_000) return `${milliseconds} мс`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} с`;
  return `${(milliseconds / 60_000).toFixed(1)} мин`;
}

function dashboardAuthorized(req, username, password) {
  if (!username || !password) return false;
  const [scheme, encoded] = String(req.get("Authorization") || "").split(" ", 2);
  if (scheme !== "Basic" || !encoded) return false;
  let decoded;
  try { decoded = Buffer.from(encoded, "base64").toString("utf8"); } catch { return false; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return secureEqual(decoded.slice(0, separator), username) && secureEqual(decoded.slice(separator + 1), password);
}

function secureEqual(actual, expected) {
  const actualHash = crypto.createHash("sha256").update(String(actual || "")).digest();
  const expectedHash = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function requiredString(value, name, max) {
  const result = optionalString(value, name, max);
  if (!result) throw new Error(`${name} is required`);
  return result;
}
function optionalString(value, name, max) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value.trim() || null;
}
function optionalIdentifier(value, name) {
  if (value == null || value === "") return null;
  const result = String(value);
  if (!/^-?\d{1,20}$/.test(result)) throw new Error(`${name} must be a Telegram numeric id`);
  return result;
}
function optionalUserIdentifier(value, name) {
  if (value == null || value === "") return null;
  const result = String(value);
  if (!/^[a-zA-Z0-9._:@-]{1,200}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function optionalDate(value, name) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${name} must be an ISO date`);
  return date.toISOString();
}
function optionalInteger(value, name, min, max) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} is invalid`);
  return number;
}
function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}
function plainObject(value, name) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const encoded = JSON.stringify(value);
  if (encoded.length > 20_000) throw new Error(`${name} is too large`);
  return value;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
