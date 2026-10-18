export interface Env {
  TELEGRAM_TOKEN: string;
  OPENAI_KEY: string; // Ключ от Zveno
  WEBHOOK_SECRET: string;
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
};

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

// Модели
const MODEL_CHAT = "dots-studio/dots-3-note-preview:free";
const MODEL_CODE = "poolside/laguna-xs-2.1:free";

// Хранилище выбора пользователя (в памяти воркера)
// (Для простоты используем Map, но учти: при перезапуске воркера выбор сбросится на "Общение")
const userModes = new Map<number, "chat" | "code">();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/set-webhook") {
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      const r = await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      return new Response(await r.text());
    }

    if (url.pathname === `/webhook/${env.WEBHOOK_SECRET}` && request.method === "POST") {
      const update = (await request.json()) as TelegramUpdate;
      ctx.waitUntil(handleUpdate(update, env).catch(console.error));
      return new Response("ok");
    }

    return new Response("AI Telegram Bot is running");
  },
};

async function handleUpdate(update: TelegramUpdate, env: Env) {
  // --- Обработка нажатий на кнопки ---
  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id;
    const data = update.callback_query.data;

    if (data === "mode_chat") {
      userModes.set(chatId, "chat");
      await sendMessage(env, chatId, "Режим переключен: <b>💬 Общение</b>\nМодель: Dots 3");
    } else if (data === "mode_code") {
      userModes.set(chatId, "code");
      await sendMessage(env, chatId, "Режим переключен: <b>💻 Кодинг</b>\nМодель: Poolside Laguna");
    }
    return;
  }

  // --- Обработка текстовых сообщений ---
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help" || text === "/menu") {
    const keyboard = {
      inline_keyboard: [
        [
          { text: "💬 Общение", callback_data: "mode_chat" },
          { text: "💻 Кодинг", callback_data: "mode_code" }
        ]
      ]
    };

    await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Привет! Выбери режим, в котором я буду отвечать:",
        reply_markup: keyboard
      }),
    });
    return;
  }

  // Определяем текущий режим (по умолчанию "chat")
  const mode = userModes.get(chatId) || "chat";
  const modelToUse = mode === "code" ? MODEL_CODE : MODEL_CHAT;

  await sendChatAction(env, chatId, "typing");

  try {
    const aiResp = await fetch("https://api.zveno.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: modelToUse,
        messages: [
          { 
            role: "system", 
            content: mode === "code" 
              ? "Ты опытный программист. Отвечай кодом с комментариями, объясняй ошибки. Пиши на языке пользователя." 
              : "Ты полезный и дружелюбный ассистент. Отвечай кратко и по делу." 
          },
          { role: "user", content: text }
        ],
        temperature: 0.7,
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error("Zveno error:", aiResp.status, errText);
      await sendMessage(env, chatId, `⚠️ Ошибка API (${aiResp.status}): ${errText.slice(0, 100)}`);
      return;
    }

    const data = (await aiResp.json()) as any;
    const answer = data.choices?.[0]?.message?.content?.trim() || "Пустой ответ.";
    await sendMessage(env, chatId, answer);

  } catch (e) {
    console.error("Zveno fetch failed:", e);
    await sendMessage(env, chatId, "⚠️ Ошибка соединения с ИИ.");
  }
}

async function sendMessage(env: Env, chatId: number, text: string) {
  const MAX_LEN = 4000;
  const chunk = text.length > MAX_LEN ? text.slice(0, MAX_LEN) + "…" : text;
  
  await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

async function sendChatAction(env: Env, chatId: number, action: string) {
  await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}
