export interface Env {
  TELEGRAM_TOKEN: string;
  OPENAI_KEY: string; // Ключ от Zveno
  WEBHOOK_SECRET: string;
  CHAT_HISTORY?: KVNamespace; // Наша база данных
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

// Дефолтные модели
const DEFAULT_CHAT = "dots-studio/dots-3-note-preview:free";
// Вместо упавшей Poolside используем надежную бесплатную модель от Meta (Llama 3 8B)
const DEFAULT_CODE = "dots-studio/dots-3-note-preview:free";

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
  // --- Обработка кнопок ---
  if (update.callback_query) {
    const chatId = update.callback_query.message.chat.id;
    const data = update.callback_query.data;

    if (data === "mode_chat") {
      await env.CHAT_HISTORY?.put(`mode:${chatId}`, "chat");
      await sendMessage(env, chatId, "Режим переключен: <b>💬 Общение</b>\nМодель: Dots 3");
    } else if (data === "mode_code") {
      await env.CHAT_HISTORY?.put(`mode:${chatId}`, "code");
      await sendMessage(env, chatId, "Режим переключен: <b>💻 Кодинг</b>\nМодель: Llama 3 8B");
    }
    return;
  }

  // --- Обработка текста ---
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

  // Получаем режим из базы (если нет — ставим "chat")
  let mode = await env.CHAT_HISTORY?.get(`mode:${chatId}`) || "chat";
  const modelToUse = mode === "code" ? DEFAULT_CODE : DEFAULT_CHAT;

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
              ? "Ты опытный программист. Отвечай кодом с комментариями, объясняй ошибки." 
              : "Ты полезный и дружелюбный ассистент. Отвечай кратко." 
          },
          { role: "user", content: text }
        ],
        temperature: 0.7,
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error("Zveno error:", aiResp.status, errText);
      // Если модель перегружена, просто подскажем пользователю
      if (aiResp.status === 429) {
         await sendMessage(env, chatId, `⏳ Модель перегружена. Подожди 5-10 секунд и отправь сообщение снова!`);
      } else {
         await sendMessage(env, chatId, `⚠️ Ошибка API (${aiResp.status}): ${errText.slice(0, 100)}`);
      }
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
