/** CSV escaping: quote fields containing , " \n \r or leading =+-\t@ (injection). */
export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const dangerous =
    /^[=+\-@\t]/.test(text) ||
    /[",\r\n]/.test(text);
  if (!dangerous) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvLine(fields: readonly unknown[]): string {
  return fields.map(csvEscape).join(",") + "\r\n";
}

/**
 * CSV parser, symmetric with csvEscape/csvLine: quotes, "" escapes, CRLF or
 * LF, leading BOM stripped. Formula-injection quoting round-trips back to the
 * original text (=cmd() stays =cmd()). Returns rows of raw string fields;
 * a trailing newline does not produce a phantom empty row.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const pushField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
    } else if (ch === ",") {
      pushField();
      i += 1;
    } else if (ch === "\r") {
      i += input[i + 1] === "\n" ? 2 : 1;
      pushRow();
    } else if (ch === "\n") {
      i += 1;
      pushRow();
    } else {
      field += ch;
      fieldStarted = true;
      i += 1;
    }
  }
  if (fieldStarted || field.length > 0 || row.length > 0) pushRow();
  return rows;
}
