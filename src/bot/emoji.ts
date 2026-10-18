import { escapeHtml, extractEmojiId, iconButton, plainLabel } from "./tg";
import { colorExtra, parseButtonColors, type ButtonColors } from "./colors";

export const EMOJI_ICONS = ["🛍", "🏛", "🚀", "🔧", "📦", "📊", "➕", "📂", "👤", "💰", "📣", "👋", "🙈", "👁", "🤖", "🔑", "🧾", "📜", "⬅️", "✖️", "✅", "📝", "⏱", "💵", "🛒", "🔢", "🏠", "✏️", "🗑", "📋", "🔐", "❌", "⚠️", "⭐", "📅", "🟢", "🔍", "🔓", "➖", "📄", "💲", "🎉", "🛠", "⛔️", "✉️", "👥", "🏷", "🔎", "📈", "📉", "💳", "💸", "🔄", "🔙", "📌", "👉", "➡️", "💬", "🎁", "🔗", "📤", "🚫", "⏳", "ℹ️", "⌛"];
// Display names only: saved settings and callback indexes keep using EMOJI_ICONS.
export const EMOJI_LABELS: Record<string, string> = {
  "🎁": "Affiliate commission", "🔗": "Affiliate link", "📤": "Share link", "🚫": "Remove user",
  "🛍": "Buy keys", "🏛": "Account", "🚀": "Log out", "🔧": "Reseller",
  "📦": "Stock / Products", "📊": "Statistics", "➕": "Add product / key type",
  "📂": "Categories", "👤": "Add account", "💰": "Balance", "📣": "Broadcast",
  "👋": "Welcome text", "🙈": "Hide prices", "👁": "Show prices", "🤖": "My Own Bot / Reseller bots",
  "🔑": "Keys", "🧾": "Purchase receipt", "📜": "Purchase History", "⬅️": "Go back",
  "✖️": "Cancel", "✅": "Save / Confirm", "📝": "Product name", "⏱": "Duration",
  "💵": "Price", "🛒": "Buy one / Buy multiple", "🔢": "Quantity", "🏠": "Main menu",
  "✏️": "Rename / Edit", "🗑": "Delete", "📋": "Order details", "🔐": "Login / Password",
  "❌": "Reject / Error", "⚠️": "Warning", "⭐": "Featured", "📅": "Date / Expiry",
  "🟢": "Active status", "🔍": "Search", "🔓": "Access", "➖": "Deduct balance",
  "📄": "Details", "💲": "Pricing", "🎉": "Purchase completed", "🛠": "Admin tools",
  "⛔️": "Subscription expired", "✉️": "Messages", "👥": "Logged-in users / Accounts",
  "🏷": "Product label", "🔎": "Look at purchases", "📈": "Profit", "📉": "Expenses",
  "💳": "Payments", "💬": "Support", "💸": "Top up / Deduct", "🔄": "Refresh / Renew",
  "🔙": "Back", "📌": "Notice", "👉": "Continue", "➡️": "Next",
  "⏳": "Order timer", "ℹ️": "Info note", "⌛": "Expired",
};
export type EmojiTheme = { enabled: boolean; icons: Record<string, string>; buttons?: ButtonColors; removedIcons?: string[] };
export function parseEmojiTheme(raw: string | null): EmojiTheme {
  try {
    const value = JSON.parse(raw ?? "{}");
    const icons: Record<string, string> = {};
    for (const icon of EMOJI_ICONS) {
      if (typeof value.icons?.[icon] === "string" && extractEmojiId(value.icons[icon])) icons[icon] = value.icons[icon];
    }
    const removedIcons = EMOJI_ICONS.filter(icon => Array.isArray(value.removedIcons) && value.removedIcons.includes(icon));
    return { enabled: value.enabled !== false, icons, buttons: parseButtonColors(value.buttons), ...(removedIcons.length ? { removedIcons } : {}) };
  } catch { return { enabled: true, icons: {} }; }
}
// Inherit only icons: button colors and Premium ON/OFF remain tenant-owned.
export function resolveEmojiTheme(own: EmojiTheme, defaults: EmojiTheme): EmojiTheme {
  const icons = { ...(defaults.enabled ? defaults.icons : {}), ...own.icons };
  for (const icon of own.removedIcons ?? []) delete icons[icon];
  return { ...own, icons };
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
