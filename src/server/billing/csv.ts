/** CSV escaping: quote fields containing , " \n \r or leading =+-\t@ (injection). */
export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const dangerous =
    /^[=+\-@\t]/.test(text) ||
    /[",\r\n]/.test(text);
  if (!dangerous) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvLine(fields: unknown[]): string {
  return fields.map(csvEscape).join(",") + "\r\n";
}
