const API = "https://api.telegram.org";

export const MENU_COMMANDS = [
  { command: "start", description: "Show help" },
  { command: "status", description: "Show the current job" },
  { command: "cancel", description: "Cancel the active job" },
  { command: "retry", description: "Retry the last failed job" },
  { command: "kindle", description: "Check Kindle connection" },
  { command: "merge", description: "Configure vertical page merging" }
];

export function createTelegram(token) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const baseUrl = `${API}/bot${token}`;

  async function call(method, body) {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} failed (${response.status})`);
    }
    return data.result;
  }

  return {
    sendMessage(chatId, text, options = {}) {
      return call("sendMessage", {
        chat_id: String(chatId),
        text: limitText(text),
        disable_web_page_preview: true,
        ...options
      });
    },
    editMessage(chatId, messageId, text, options = {}) {
      return call("editMessageText", {
        chat_id: String(chatId),
        message_id: Number(messageId),
        text: limitText(text),
        disable_web_page_preview: true,
        ...options
      }).catch((error) => {
        if (/message is not modified/i.test(error.message)) return null;
        throw error;
      });
    },
    answerCallbackQuery(callbackQueryId, text = "") {
      return call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      });
    },
    setWebhook(url, secretToken) {
      return call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false
      });
    },
    async configureMenu() {
      await call("setMyCommands", { commands: MENU_COMMANDS });
      return call("setChatMenuButton", {
        menu_button: { type: "commands" }
      });
    }
  };
}

export function choicesKeyboard(job) {
  return {
    inline_keyboard: job.choiceManifest.slice(0, 8).map((choice, index) => [{
      text: trim(choice.title, 56),
      callback_data: `choose:${job.id}:${index}`
    }])
  };
}

function limitText(value) {
  return String(value || "").slice(0, 4096);
}
function trim(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
