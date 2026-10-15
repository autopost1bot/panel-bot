import { escapeHtml, extractEmojiId, iconButton, plainLabel } from "./tg";
import { colorExtra, parseButtonColors, type ButtonColors } from "./colors";

export const EMOJI_ICONS = ["🛍", "🏛", "🚀", "🔧", "📦", "📊", "➕", "📂", "👤", "💰", "📣", "👋", "🙈", "👁", "🤖", "🔑", "🧾", "📜", "⬅️", "✖️", "✅", "📝", "⏱", "💵", "🛒", "🔢", "🏠", "✏️", "🗑", "📋", "🔐", "❌", "⚠️", "⭐", "📅", "🟢", "🔍", "🔓", "➖", "📄", "💲", "🎉", "🛠", "⛔️", "✉️", "👥", "🏷", "🔎", "📈", "📉", "💳", "💸", "🔄", "🔙", "📌", "👉", "➡️"];
// Display names only: saved settings and callback indexes keep using EMOJI_ICONS.
export const EMOJI_LABELS: Record<string, string> = {
  "🛍": "Buy keys", "🏛": "Account", "🚀": "Log out", "🔧": "Manage",
  "📦": "Stock / Products", "📊": "Statistics", "➕": "Add product / key type",
  "📂": "Categories", "👤": "Add account", "💰": "Balance", "📣": "Broadcast",
  "👋": "Welcome text", "🙈": "Hide prices", "👁": "Show prices", "🤖": "My Own Bot / Reseller bots",
  "🔑": "Keys", "🧾": "Purchase receipt", "📜": "Purchase History", "⬅️": "Go back",
  "✖️": "Cancel", "✅": "Save / Confirm", "📝": "Position name", "⏱": "Duration",
  "💵": "Price", "🛒": "Buy one / Buy multiple", "🔢": "Quantity", "🏠": "Main menu",
  "✏️": "Rename / Edit", "🗑": "Delete", "📋": "Order details", "🔐": "Login / Password",
  "❌": "Reject / Error", "⚠️": "Warning", "⭐": "Featured", "📅": "Date / Expiry",
  "🟢": "Active status", "🔍": "Search", "🔓": "Access", "➖": "Deduct balance",
  "📄": "Details", "💲": "Pricing", "🎉": "Purchase completed", "🛠": "Admin tools",
  "⛔️": "Subscription expired", "✉️": "Messages", "👥": "Manage accounts",
  "🏷": "Product label", "🔎": "Look at purchases", "📈": "Profit", "📉": "Expenses",
  "💳": "Payments", "💸": "Top up / Deduct", "🔄": "Refresh / Renew",
  "🔙": "Back", "📌": "Notice", "👉": "Continue", "➡️": "Next",
};
export type EmojiTheme = { enabled: boolean; icons: Record<string, string>; buttons?: ButtonColors };
export function parseEmojiTheme(raw: string | null): EmojiTheme {
  try {
    const value = JSON.parse(raw ?? "{}");
    const icons: Record<string, string> = {};
    for (const icon of EMOJI_ICONS) {
      if (typeof value.icons?.[icon] === "string" && extractEmojiId(value.icons[icon])) icons[icon] = value.icons[icon];
    }
    return { enabled: value.enabled !== false, icons, buttons: parseButtonColors(value.buttons) };
  } catch { return { enabled: true, icons: {} }; }
}
export function emojiTag(text: string, entities: { type: string; offset: number; length: number; custom_emoji_id?: string }[]): string | null {
  const entity = entities.find(e => e.type === "custom_emoji" && /^\d+$/.test(e.custom_emoji_id ?? ""));
  if (!entity?.custom_emoji_id) return null;
  const fallback = text.slice(entity.offset, entity.offset + entity.length);
  if (!fallback) return null;
  return `<tg-emoji emoji-id="${entity.custom_emoji_id}">${escapeHtml(fallback)}</tg-emoji>`;
}
export function replaceNameIcon(name: string, tag: string | null): string {
  const without = name.replace(/<tg-emoji\s+emoji-id="\d+">[\s\S]*?<\/tg-emoji>/g, "").trim()
    .replace(/^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*\s*)+/u, "").trim();
  return tag ? `${tag} ${without}` : without;
}
// Empty prefix when the name already starts with its own emoji, so titles never show two icons side by side.
export function titlePrefix(icon: string, name: string): string {
  if (/^\s*<tg-emoji\s+emoji-id="\d+"/.test(name)) return "";
  return /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*\s*)/u.test(name) ? "" : `${icon} `;
}
export function themeHtml(html: string, theme: EmojiTheme): string {
  if (!theme.enabled) return html.replace(/<tg-emoji\s+emoji-id="\d+">([\s\S]*?)<\/tg-emoji>/g, "$1");
  // Never touch keys, usernames or existing custom emoji entities.
  return html.split(/(<code\b[^>]*>[\s\S]*?<\/code>|<pre\b[^>]*>[\s\S]*?<\/pre>|<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>|<[^>]+>)/g)
    .map(part => part.startsWith("<") ? part : part.replace(/(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F)?/gu, icon => theme.icons[icon] ?? icon)).join("");
}
export function themeExtra(extra: Record<string, any>, theme: EmojiTheme): Record<string, any> {
  extra = colorExtra(extra, theme.buttons);
  const markup = extra['reply_markup'];
  if (!markup) return extra;
  const key = markup.inline_keyboard ? "inline_keyboard" : markup.keyboard ? "keyboard" : null;
  if (!key) return extra;
  return { ...extra, reply_markup: { ...markup, [key]: markup[key].map((row: any[]) => row.map(button => {
    if (typeof button === "string") return iconButton(themeHtml(button, theme));
    const { text, icon_custom_emoji_id, ...rest } = button;
    if (!theme.enabled) return { ...rest, text };
    if (icon_custom_emoji_id) return button;
    return iconButton(themeHtml(text, theme), rest);
  })) } };
}
