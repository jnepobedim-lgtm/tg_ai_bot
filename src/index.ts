export interface Env {
  TELEGRAM_TOKEN: string;
  OPENAI_KEY: string; // Сюда мы положили ключ от Zveno
  WEBHOOK_SECRET: string;
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
    await sendMessage(env, chatId, "Привет! Я работаю на нейросети Zveno. Напиши сообщение!");
    return;
  }

  await sendChatAction(env, chatId, "typing");

  try {
    // Запрос к Zveno API
    const aiResp = await fetch("https://api.zveno.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemma-4-26b-a4b-it:free",
        messages: [
          { role: "system", content: "Ты полезный и дружелюбный ассистент. Отвечай на языке пользователя." },
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
    await sendMessage(env, chatId, "⚠️ Не удалось связаться с Zveno.");
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
