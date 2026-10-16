// ─── Telegram API + Premium (custom) emoji helpers ──────────────────────────
// Storage format: <tg-emoji emoji-id="5776121926627888870">ℹ️</tg-emoji> Info key
// Message text -> send with parse_mode "HTML" (tag renders as premium emoji).
// Button labels -> Telegram does NOT render HTML in buttons, so the tag is
// stripped and the id goes to `icon_custom_emoji_id` on the button object.

export type TgEntity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
  url?: string;
  language?: string;
};

const TG_EMOJI_RE = /<tg-emoji\s+emoji-id="(\d+)">([\s\S]*?)<\/tg-emoji>/;
const TG_EMOJI_RE_G = new RegExp(TG_EMOJI_RE.source, "g");

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert a Telegram message (text + entities) into HTML, keeping premium
 *  emojis as <tg-emoji> tags. Offsets are UTF-16 code units, so we slice the
 *  raw JS string directly. */
export function entitiesToHtml(text: string, entities: TgEntity[] = []): string {
  const units = Array.from({ length: text.length }, (_, i) => text[i]);
  const open: string[][] = units.map(() => []);
  const close: string[][] = units.map(() => []);

  const wrap = (e: TgEntity): [string, string] | null => {
    switch (e.type) {
      case "custom_emoji":
        return e.custom_emoji_id ? [`<tg-emoji emoji-id="${e.custom_emoji_id}">`, "</tg-emoji>"] : null;
      case "bold": return ["<b>", "</b>"];
      case "italic": return ["<i>", "</i>"];
      case "underline": return ["<u>", "</u>"];
      case "strikethrough": return ["<s>", "</s>"];
      case "spoiler": return ["<tg-spoiler>", "</tg-spoiler>"];
      case "code": return ["<code>", "</code>"];
      case "pre": return [e.language ? `<pre><code class="language-${e.language}">` : "<pre>", e.language ? "</code></pre>" : "</pre>"];
      case "text_link": return e.url ? [`<a href="${e.url}">`, "</a>"] : null;
      case "blockquote": return ["<blockquote>", "</blockquote>"];
      default: return null;
    }
  };

  for (const e of entities) {
    const tags = wrap(e);
    if (!tags) continue;
    const start = e.offset;
    const end = e.offset + e.length - 1;
    if (start < 0 || end >= units.length) continue;
    open[start]!.push(tags[0]);
    close[end]!.unshift(tags[1]);
  }

  let out = "";
  for (let i = 0; i < units.length; i++) {
    out += open[i]!.join("");
    out += escapeHtml(units[i]!);
    out += close[i]!.join("");
  }
  return out;
}

/** Remove <tg-emoji> tags, keeping the fallback emoji character. */
export function stripTgEmoji(label: string): string {
  return label.replace(TG_EMOJI_RE_G, "$2").trim();
}

/** Remove <tg-emoji> tags completely (no fallback) — used for button text. */
export function plainLabel(label: string): string {
  return label
    .replace(TG_EMOJI_RE_G, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** First custom emoji id inside the label, if any. */
export function extractEmojiId(label: string): string | null {
  const m = label.match(TG_EMOJI_RE);
  return m?.[1] ?? null;
}

/** Build a keyboard button from a stored label; premium emoji becomes
 *  `icon_custom_emoji_id` (the only way Telegram shows it on a button). */
export function iconButton<T extends Record<string, unknown>>(
  label: string,
  extra?: T,
): { text: string; icon_custom_emoji_id?: string } & T {
  const id = extractEmojiId(label);
  if (id) {
    const text = plainLabel(label) || stripTgEmoji(label) || " ";
    return { text, icon_custom_emoji_id: id, ...(extra ?? ({} as T)) };
  }
  return { text: plainLabel(label) || stripTgEmoji(label) || label, ...(extra ?? ({} as T)) };
}

// ─── Bot API calls ───────────────────────────────────────────────────────────

// Reuse warm TLS connections to Telegram: fetch drops idle sockets after ~4s,
// so every tap after a pause paid a fresh TCP+TLS handshake from the VPS.
import { Agent, request as httpsRequest } from "node:https";
const tgAgent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 64, family: 4 } as any);
function keepAlivePost(url: string, payload: string): Promise<{ status: number; ok: boolean; j: any }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "POST", agent: tgAgent, timeout: 30_000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let j: any = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, j });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Telegram request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

export async function tgCall(token: string, method: string, body: Record<string, unknown> = {}): Promise<any> {
  // "main" = the admin bot; its token comes from ADMIN_BOT_TOKEN.
  if (token === "main") token = process.env["ADMIN_BOT_TOKEN"] ?? "";
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const payload = JSON.stringify(body);
  let status: number, ok: boolean, j: any;
  if (process.env["VITEST"]) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    status = res.status; ok = res.ok; j = await res.json().catch(() => ({}));
  } else {
    ({ status, ok, j } = await keepAlivePost(url, payload));
  }
  if (!ok || j.ok === false) {
    throw new Error(`TG ${method} ${status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  return j.result;
}

const toPlain = (html: string) =>
  stripTgEmoji(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();

/** Strip rejected appearance fields on retry, preserving keyboard actions. */
const ordinaryExtra = (extra: Record<string, any>) => {
  const markup = extra['reply_markup'];
  if (!markup) return extra;
  const key = markup.inline_keyboard ? "inline_keyboard" : markup.keyboard ? "keyboard" : null;
  if (!key) return extra;
  return { ...extra, reply_markup: { ...markup, [key]: markup[key].map((row: any[]) => row.map(button => {
    if (typeof button === "string") return button;
    const { icon_custom_emoji_id, style, ...rest } = button;
    return rest;
  })) } };
};

/** Send HTML (premium emoji aware); if Telegram rejects it, retry as plain text. */
export async function sendHtml(token: string, chatId: number, html: string, extra: Record<string, unknown> = {}) {
  try {
    return await tgCall(token, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", ...extra });
  } catch {
    try {
      return await tgCall(token, "sendMessage", { chat_id: chatId, text: stripTgEmoji(html), parse_mode: "HTML", ...ordinaryExtra(extra) });
    } catch {
      return null;
    }
  }
}

/**
 * Edit an existing bot message in place (premium emoji aware).
 * Returns "ok" when edited, "same" when the content was already identical,
 * and "fail" when the message cannot be edited (caller should send fresh).
 */
export async function editHtml(token: string, chatId: number, messageId: number, html: string, extra: Record<string, unknown> = {}): Promise<"ok" | "same" | "fail"> {
  const attempt = (text: string, parse?: string, options = extra) =>
    tgCall(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...(parse ? { parse_mode: parse } : {}), ...options });
  try {
    await attempt(html, "HTML");
    return "ok";
  } catch (err) {
    const desc = String((err as Error)?.message ?? err);
    if (desc.includes("message is not modified")) return "same";
    try {
      await attempt(stripTgEmoji(html), "HTML", ordinaryExtra(extra));
      return "ok";
    } catch (err2) {
      const desc2 = String((err2 as Error)?.message ?? err2);
      return desc2.includes("message is not modified") ? "same" : "fail";
    }
  }
}

export const btn = (label: string, data: string) => iconButton(label, { callback_data: data });
export const urlBtn = (label: string, url: string) => iconButton(label, { url });
export const kb = (...rows: any[][]) => ({ reply_markup: { inline_keyboard: rows } });
export const money = (n: number) => `${Number(Number(n).toFixed(2))}$`;
export const fmtDate = (d: any) => new Date(d).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Webhook secret derived from the bot token (both sides can compute it). */
export async function webhookSecret(token: string): Promise<string> {
  const data = new TextEncoder().encode(`tg-webhook:${token}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
