export type ButtonColor = "default" | "primary" | "success" | "danger";
export type ButtonColors = { inline: ButtonColor; keyboard: ButtonColor };
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
  return {
    inline: isButtonColor(raw?.inline) ? raw.inline : "default",
    keyboard: isButtonColor(raw?.keyboard) ? raw.keyboard : "default",
  };
}
export function colorExtra(extra: Record<string, any>, colors?: ButtonColors): Record<string, any> {
  const markup = extra.reply_markup;
  if (!markup || !colors) return extra;
  const key = markup.inline_keyboard ? "inline_keyboard" : markup.keyboard ? "keyboard" : null;
  if (!key) return extra;
  const color = key === "inline_keyboard" ? colors.inline : colors.keyboard;
  return { ...extra, reply_markup: { ...markup, [key]: markup[key].map((row: any[]) => row.map(button => {
    const result = typeof button === "string" ? { text: button } : { ...button };
    // Explicit styles are swatch previews, not the shop-wide preference.
    if (result.style === undefined && color !== "default" && !String(result.callback_data ?? "").startsWith("a:colors:")) result.style = color;
    return result;
  })) } };
}