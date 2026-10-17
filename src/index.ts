export interface Env {
  TELEGRAM_TOKEN: string;
  WEBHOOK_SECRET: string;
  AI: any; // Встроенная нейросеть Cloudflare
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string };
    text?: string;
  };
};

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/set-webhook") {
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      const r = await fetch(
        `${TG_API(env.TELEGRAM_TOKEN)}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      );
      return new Response(await r.text());
    }

    if (
      url.pathname === `/webhook/${env.WEBHOOK_SECRET}` &&
      request.method === "POST"
    ) {
      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch {
        return new Response("bad json", { status: 400 });
      }

      if (update.message?.text && update.message.chat) {
        ctx.waitUntil(handleMessage(update, env).catch(console.error));
      }
      return new Response("ok");
    }

    return new Response("AI Telegram Bot is running");
  },
};

async function handleMessage(update: TelegramUpdate, env: Env) {
  const msg = update.message!;
  const chatId = msg.chat.id;
  const text = msg.text!.trim();

  if (text === "/start" || text === "/help") {
    await sendMessage(env, chatId, "Привет! Я работаю на бесплатной нейросети Cloudflare. Напиши сообщение!");
    return;
  }

  await sendChatAction(env, chatId, "typing");

  try {
    // Запрос к встроенной нейросети Cloudflare (модель Llama 3.1 8B)
    const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "Ты полезный и дружелюбный ассистент. Отвечай на языке пользователя." },
        { role: "user", content: text }
      ]
    });

    const answer = aiResp.response || "Не удалось получить ответ.";
    await sendMessage(env, chatId, answer);

  } catch (e) {
    console.error("Cloudflare AI error:", e);
    await sendMessage(env, chatId, "⚠️ Ошибка нейросети Cloudflare.");
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
