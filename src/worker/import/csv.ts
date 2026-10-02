// RFC 4180 CSV parsing (quoted fields, doubled quotes, embedded newlines, CRLF, a UTF-8 BOM).
// Good enough for exports from spreadsheets and other ticketing tools; no dependency.

export function parseCsv(text: string, opts: { maxRows?: number } = {}): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const max = opts.maxRows ?? Infinity;
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length > max) throw new Error(`Too many rows: at most ${max - 1} per import`);
    } else field += ch;
  }
  if (quoted) throw new Error("A quoted value is never closed");
  if (field !== "" || row.length) endRow();
  if (rows.length > max) throw new Error(`Too many rows: at most ${max - 1} per import`);
  return rows;
}

/** Rows as objects keyed by the (trimmed, lowercased) header row. */
export function csvObjects(text: string, maxRows: number): { headers: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text, { maxRows: maxRows + 1 });
  const [header, ...body] = table;
  if (!header) throw new Error("The file is empty");
  const headers = header.map((h) => h.trim());
  return {
    headers,
    rows: body.map((cells) => Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), (cells[i] ?? "").trim()]))),
  };
}
