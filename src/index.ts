export interface Env {
  TELEGRAM_TOKEN: string;
  OPENAI_KEY: string;
  WEBHOOK_SECRET: string;
  CHAT_HISTORY?: KVNamespace;
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

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

const TG_API = (token: string) => `https://api.telegram.org/bot${token}`;

const SYSTEM_PROMPT =
  "Ты полезный и дружелюбный ассистент. Отвечай кратко, по делу, на языке пользователя.";

const MAX_HISTORY = 10; // храним последние 10 сообщений (5 пар user/assistant)

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // --- Установка webhook (открыть один раз в браузере) ---
    if (url.pathname === "/set-webhook") {
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      const r = await fetch(
        `${TG_API(env.TELEGRAM_TOKEN)}/setWebhook?url=${encodeURIComponent(
          webhookUrl
        )}`
      );
      return new Response(await r.text());
    }

    // --- Сброс webhook (для отладки) ---
    if (url.pathname === "/del-webhook") {
      const r = await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/deleteWebhook`);
      return new Response(await r.text());
    }

    // --- Приём апдейтов от Telegram ---
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
        // Отвечаем Telegram сразу (важно: < 1 сек),
        // а обработку делаем в фоне через waitUntil
        ctx.waitUntil(handleMessage(update, env).catch(console.error));
      }
      return new Response("ok");
    }

    return new Response("AI Telegram Bot is running", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

async function handleMessage(update: TelegramUpdate, env: Env) {
  const msg = update.message!;
  const chatId = msg.chat.id;
  const text = msg.text!.trim();

  // --- Команды ---
  if (text === "/start" || text === "/help") {
    await sendMessage(
      env,
      chatId,
      "Привет! Я ИИ-бот. Напиши сообщение — отвечу.\n\n" +
        "Команды:\n" +
        "/start — начать\n" +
        "/reset — очистить историю диалога"
    );
    return;
  }

  if (text === "/reset") {
    if (env.CHAT_HISTORY) await env.CHAT_HISTORY.delete(`chat:${chatId}`);
    await sendMessage(env, chatId, "История очищена ✅");
    return;
  }

  // Индикатор "печатает…"
  await sendChatAction(env, chatId, "typing");

  // --- История диалога ---
  const historyKey = `chat:${chatId}`;
  let history: ChatMessage[] = [];
  if (env.CHAT_HISTORY) {
    const stored = await env.CHAT_HISTORY.get(historyKey);
    if (stored) {
      try {
        history = JSON.parse(stored) as ChatMessage[];
      } catch {
        history = [];
      }
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: text },
  ];

  // --- Запрос к OpenAI ---
  let answer = "";
  try {
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.7,
        max_tokens: 800,
      }),
    });

    if (!aiResp.ok) {
      console.error("OpenAI error:", aiResp.status, await aiResp.text());
      await sendMessage(env, chatId, "⚠️ Ошибка ИИ. Попробуй позже.");
      return;
    }

    const data = (await aiResp.json()) as {
      choices: { message: { content: string } }[];
    };
    answer = data.choices?.[0]?.message?.content?.trim() || "…";
  } catch (e) {
    console.error("OpenAI fetch failed:", e);
    await sendMessage(env, chatId, "⚠️ Не удалось связаться с ИИ.");
    return;
  }

  // --- Отправка ответа ---
  await sendMessage(env, chatId, answer);

  // --- Сохранение истории ---
  if (env.CHAT_HISTORY) {
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: answer });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    await env.CHAT_HISTORY.put(historyKey, JSON.stringify(history), {
      expirationTtl: 60 * 60 * 24 * 7, // 7 дней
    });
  }
}

async function sendMessage(env: Env, chatId: number, text: string) {
  // Telegram лимит: 4096 символов на сообщение — режем, если длиннее
  const MAX_LEN = 4000;
  const chunk = text.length > MAX_LEN ? text.slice(0, MAX_LEN) + "…" : text;

  const resp = await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) {
    // Если HTML сломался — пробуем без parse_mode
    console.error("sendMessage failed:", await resp.text());
    await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
  }
}

async function sendChatAction(env: Env, chatId: number, action: string) {
  await fetch(`${TG_API(env.TELEGRAM_TOKEN)}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
    }
