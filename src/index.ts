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
};

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

// Единственная рабочая модель
const MODEL = "dots-studio/dots-3-note-preview:free";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/set-webhook") {
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      const r = await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      return new Response(await r.text());
    }

    if (url.pathname === `/webhook/${env.WEBHOOK_SECRET}` && request.method === "POST") {
      try {
        const update = (await request.json()) as TelegramUpdate;
        ctx.waitUntil(handleMessage(update, env).catch(console.error));
      } catch (e) {
        console.error("Webhook error:", e);
      }
      return new Response("ok");
    }

    return new Response("AI Telegram Bot is running");
  },
};

async function handleMessage(update: TelegramUpdate, env: Env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await sendMessage(env, chatId, "Привет! Я твой ИИ-ассистент. Пиши любой вопрос (или проси написать код).");
    return;
  }

  await sendChatAction(env, chatId, "typing");

  try {
    const aiResp = await fetch("https://api.zveno.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "Ты полезный и умный ассистент. Отвечай на языке пользователя." },
          { role: "user", content: text }
        ],
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      await sendMessage(env, chatId, `⚠️ Ошибка API (${aiResp.status}): ${errText.slice(0, 100)}`);
      return;
    }

    const data = (await aiResp.json()) as any;
    const answer = data.choices?.[0]?.message?.content?.trim() || "Пустой ответ.";
    await sendMessage(env, chatId, answer);

  } catch (e) {
    console.error("fetch error:", e);
    await sendMessage(env, chatId, "⚠️ Ошибка соединения с сервером.");
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
