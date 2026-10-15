export type ButtonColor = "default" | "primary" | "success" | "danger";
export type ButtonColors = { inline: ButtonColor; keyboard: ButtonColor; items?: Record<string, ButtonColor> };
// Stable action IDs keep preferences independent of translated/custom-emoji labels.
export const COLOR_BUTTONS = [
  { id: "buy", label: "Buy keys", aliases: ["View shop"], actions: ["c:shop"] },
  { id: "account", label: "Account", actions: ["c:me"] },
  { id: "logout", label: "Log out" },
  { id: "manage", label: "Manage", aliases: ["Admin Panel"], actions: ["a:manage"] },
  { id: "login", label: "Login" },
  { id: "buy_one", label: "Buy one", actions: ["c:buy:"] },
  { id: "buy_multiple", label: "Buy multiple", actions: ["c:bm:"] },
  { id: "save", label: "Save", aliases: ["Confirm"], actions: ["a:vsave"] },
  { id: "finish", label: "Finish" },
  { id: "cancel", label: "Cancel", actions: ["x:cancel", "a:vcancel"] },
  { id: "back", label: "Go back", aliases: ["Back", "Menu", "Category", "Product", "Back to accounts", "Products", "Categories", "Reseller bots"] },
  { id: "history", label: "Purchase History", aliases: ["My orders", "Look at purchases"], actions: ["c:orders", "a:mo:", "a:purch"] },
  { id: "stock", label: "Stock", actions: ["a:stock"] },
  { id: "stats", label: "Statistics", aliases: ["Orders & profit"], actions: ["a:stats"] },
  { id: "own_bot", label: "My Own Bot" },
  { id: "add_product", label: "Add product", aliases: ["Add product here", "Add position"], actions: ["a:add", "a:addc:"] },
  { id: "products", label: "Products", actions: ["a:list"] },
  { id: "categories", label: "Categories", actions: ["a:cats"] },
  { id: "add_account", label: "Add account", actions: ["a:acc"] },
  { id: "add_balance", label: "Add balance", actions: ["a:bal"] },
  { id: "add_crypto", label: "Add balance with Crypto", aliases: ["Add balance (USDT)"], actions: ["pay:top"] },
  { id: "support", label: "Support", aliases: ["Support username"], actions: ["a:sup"] },
  { id: "broadcast", label: "Broadcast", actions: ["a:bc"] },
  { id: "welcome", label: "Welcome text", actions: ["a:wel"] },
  { id: "hide", label: "Hide / Show prices", aliases: ["Hide prices", "Show prices"], actions: ["a:hide"] },
  { id: "emoji", label: "Premium emoji", actions: ["a:emoji"] },
  { id: "colors", label: "Button colors", actions: ["a:colors"] },
  { id: "tenants", label: "Reseller bots", actions: ["a:tb", "a:tb:"] },
  { id: "users", label: "Logged-in users", actions: ["a:users:"] },
  { id: "accounts", label: "Manage accounts", actions: ["a:accs", "a:m:"] },
  { id: "topup", label: "Top up", actions: ["a:mt:"] },
  { id: "deduct", label: "Deduct", actions: ["a:md:"] },
  { id: "custom_prices", label: "Custom prices", actions: ["a:cp:", "a:cps:"] },
  { id: "add_keys", label: "Add keys", aliases: ["Add more"], actions: ["a:k:"] },
  { id: "price", label: "Price", actions: ["a:sp:"] },
  { id: "cost", label: "Cost", actions: ["a:sc:"] },
  { id: "name", label: "Name", aliases: ["Rename"], actions: ["a:sn:", "a:cn:"] },
  { id: "description", label: "Description", actions: ["a:sd:"] },
  { id: "delete", label: "Delete", aliases: ["Delete position", "Delete product", "Delete category", "Yes, delete"], actions: ["a:del:", "a:delok:", "a:cdel:", "a:cdelok:"] },
  { id: "new_category", label: "New category", actions: ["a:catnew:"] },
  { id: "duration", label: "Add key type", aliases: ["Add variants", "Add another duration"], actions: ["a:v:"] },
  { id: "category_select", label: "Category selection", actions: ["c:cat:", "a:c:", "a:pcs:"] },
  { id: "product_select", label: "Product / duration selection", actions: ["c:p:", "a:p:"] },
  { id: "previous", label: "Previous" },
  { id: "next", label: "Next" },
  { id: "emoji_icons", label: "Button & message icons", actions: ["a:emoji:icons", "a:emoji:icon:"] },
  { id: "emoji_products", label: "Product & duration emoji", actions: ["a:emoji:products"] },
  { id: "emoji_categories", label: "Category emoji", actions: ["a:emoji:categories"] },
  { id: "emoji_toggle", label: "Premium: ON / OFF", actions: ["a:emoji:toggle"] },
] as { id: string; label: string; aliases?: string[]; actions?: string[] }[];
export const BUTTON_COLORS: { value: ButtonColor; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "primary", label: "🔵 Blue" },
  { value: "success", label: "🟢 Green" },
  { value: "danger", label: "🔴 Red" },
];
export function isButtonColor(value: unknown): value is ButtonColor {
  return BUTTON_COLORS.some(color => color.value === value);
}
export function parseButtonColors(value: unknown): ButtonColors {
  const raw = value as Partial<ButtonColors> | null;
  const items: Record<string, ButtonColor> = {};
  for (const button of COLOR_BUTTONS) {
    const color = raw?.items?.[button.id];
    if (isButtonColor(color)) items[button.id] = color;
  }
  return {
    inline: isButtonColor(raw?.inline) ? raw.inline : "default",
    keyboard: isButtonColor(raw?.keyboard) ? raw.keyboard : "default",
    ...(Object.keys(items).length ? { items } : {}),
  };
}
export function buttonColorId(button: Record<string, any>): string | undefined {
  const text = String(button.text ?? "").replace(/<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/g, "").replace(/^[^A-Za-z]+/, "").trim().toLowerCase();
  const callback = String(button.callback_data ?? "");
  if (/^(back\b|go back\b|menu$)/.test(text) || /^[⬅🔙]/u.test(String(button.text ?? ""))) return "back";
  const label = COLOR_BUTTONS.find(item => [item.label, ...(item.aliases ?? [])].some(name => name.toLowerCase() === text));
  if (label) return label.id;
  return COLOR_BUTTONS.find(item => item.actions?.some(action => action.endsWith(":") ? callback.startsWith(action) : callback === action))?.id;
}
export function colorExtra(extra: Record<string, any>, colors?: ButtonColors): Record<string, any> {
  // Picker lists ("choose an icon / product / category") hold data rows whose
  // display names deliberately reuse button labels, so they must never inherit
  // saved button colors. The marker is removed before anything is sent.
  const { noButtonColors, ...rest } = extra;
  if (noButtonColors) return rest;
  const markup = rest.reply_markup;
  if (!markup || !colors) return rest;
  const key = markup.inline_keyboard ? "inline_keyboard" : markup.keyboard ? "keyboard" : null;
  if (!key) return rest;
  const fallback = key === "inline_keyboard" ? colors.inline : colors.keyboard;
  return { ...rest, reply_markup: { ...markup, [key]: markup[key].map((row: any[]) => row.map(button => {
    const result = typeof button === "string" ? { text: button } : { ...button };
    const id = buttonColorId(result);
    const color = (id ? colors.items?.[id] : undefined) ?? fallback;
    // Explicit styles are swatch previews, not the shop-wide preference.
    if (result.style === undefined && color !== "default" && !String(result.callback_data ?? "").startsWith("a:colors:")) result.style = color;
    return result;
  })) } };
}