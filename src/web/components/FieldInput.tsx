import type { Field, Person } from "../types.ts";

interface Props {
  field: Field;
  value: unknown;
  people: Person[];
  error?: string;
  onChange: (value: unknown) => void;
}

/** Renders the right input for a custom field type. */
export function FieldInput({ field, value, people, error, onChange }: Props) {
  const id = `f-${field.key}`;
  const label = (
    <span>
      {field.label}
      {field.required && <span className="req"> *</span>}
    </span>
  );
  let input;
  switch (field.type) {
    case "long_text":
      input = <textarea id={id} rows={4} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "number":
    case "currency":
      input = (
        <input
          id={id}
          type="number"
          step={field.type === "currency" ? "0.01" : field.options.integer ? "1" : "any"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
      break;
    case "date":
      input = <input id={id} type="date" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "select":
      input = (
        <select id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(field.options.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
      break;
    case "multi_select": {
      const selected = new Set((value as string[]) ?? []);
      input = (
        <div className="checks">
          {(field.options.choices ?? []).map((c) => (
            <label key={c.value} className="inline">
              <input
                type="checkbox"
                checked={selected.has(c.value)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(c.value);
                  else next.delete(c.value);
                  onChange([...next]);
                }}
              />
              {c.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "user":
      input = (
        <select id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      );
      break;
    case "checkbox":
      return (
        <label className="inline field">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
          {error && <span className="error small">{error}</span>}
        </label>
      );
    case "url":
      input = <input id={id} type="url" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    default:
      input = <input id={id} type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <label className="field" htmlFor={id}>
      {label}
      {input}
      {field.helpText && <span className="muted small">{field.helpText}</span>}
      {error && <span className="error small">{error}</span>}
    </label>
  );
}

/** Read-only display of a custom value. */
export function formatValue(field: Field, value: unknown, people: Person[]): string {
  if (value === undefined || value === null || value === "") return "—";
  switch (field.type) {
    case "select":
      return field.options.choices?.find((c) => c.value === value)?.label ?? String(value);
    case "multi_select":
      return (value as string[]).map((v) => field.options.choices?.find((c) => c.value === v)?.label ?? v).join(", ") || "—";
    case "user":
      return people.find((p) => p.id === value)?.displayName ?? "Someone";
    case "checkbox":
      return value ? "Yes" : "No";
    case "currency":
      return new Intl.NumberFormat(undefined, { style: "currency", currency: field.options.currency ?? "USD" }).format(
        value as number,
      );
    default:
      return String(value);
  }
}
