import { describe, expect, it } from "vitest";
import { coerceValue, validateCustom, validateOptions, type FieldDef } from "../src/worker/config/fields.ts";

const def = (over: Partial<FieldDef>): FieldDef => ({
  id: "00000000-0000-0000-0000-000000000000",
  key: "f",
  label: "F",
  type: "text",
  required: false,
  options: {},
  defaultValue: null,
  helpText: "",
  position: 0,
  archivedAt: null,
  ...over,
});

describe("coerceValue", () => {
  const cases: [Partial<FieldDef>, unknown, unknown | Error][] = [
    [{ type: "text" }, "  hello ", "hello"],
    [{ type: "text", options: { maxLength: 3 } }, "toolong", new Error()],
    [{ type: "long_text" }, "line1\nline2", "line1\nline2"],
    [{ type: "number" }, "42", 42],
    [{ type: "number", options: { integer: true } }, 1.5, new Error()],
    [{ type: "number", options: { min: 0 } }, -1, new Error()],
    [{ type: "currency", options: { currency: "USD" } }, 19.99, 19.99],
    [{ type: "currency", options: { currency: "USD" } }, 19.999, new Error()],
    [{ type: "date" }, "2026-02-28", "2026-02-28"],
    [{ type: "date" }, "2026-02-30", new Error()],
    [{ type: "select", options: { choices: [{ value: "a", label: "A" }] } }, "a", "a"],
    [{ type: "select", options: { choices: [{ value: "a", label: "A" }] } }, "b", new Error()],
    [{ type: "multi_select", options: { choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }, ["a", "a", "b"], ["a", "b"]],
    [{ type: "user" }, "11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111111"],
    [{ type: "user" }, "bob", new Error()],
    [{ type: "checkbox" }, true, true],
    [{ type: "checkbox" }, "yes", new Error()],
    [{ type: "url" }, "https://fernhollow.test/po/1", "https://fernhollow.test/po/1"],
    [{ type: "url" }, "javascript:alert(1)", new Error()],
  ];
  for (const [d, input, expected] of cases) {
    it(`${d.type} ${JSON.stringify(input)}`, () => {
      const r = coerceValue(def(d), input);
      if (expected instanceof Error) expect(r.ok).toBe(false);
      else expect(r).toEqual({ ok: true, value: expected });
    });
  }
});

describe("validateCustom", () => {
  const defs = [
    def({ key: "vendor", required: true }),
    def({ key: "reason", type: "select", options: { choices: [{ value: "price", label: "Price" }] }, defaultValue: "price" }),
    def({ key: "old", archivedAt: new Date() }),
  ];

  it("applies defaults and enforces required fields on create", () => {
    expect(validateCustom(defs, {}, "create").issues).toEqual([{ field: "custom.vendor", message: "Required" }]);
    expect(validateCustom(defs, { vendor: "Acme" }, "create")).toMatchObject({
      values: { vendor: "Acme", reason: "price" },
      issues: [],
    });
  });

  it("treats whitespace-only text as empty", () => {
    expect(validateCustom(defs, { vendor: "   " }, "create").issues).toEqual([{ field: "custom.vendor", message: "Required" }]);
    const longDefs = [def({ key: "notes", type: "long_text", required: true })];
    expect(validateCustom(longDefs, { notes: "\n  \n" }, "create").issues).toHaveLength(1);
  });

  it("enforces required fields whose key collides with an Object prototype property", () => {
    const protoDefs = [def({ key: "constructor", required: true })];
    expect(validateCustom(protoDefs, {}, "create").issues).toEqual([{ field: "custom.constructor", message: "Required" }]);
  });

  it("rejects unknown and archived fields", () => {
    const r = validateCustom(defs, { vendor: "Acme", nope: 1, old: "x" }, "create");
    expect(r.issues.map((i) => i.field).sort()).toEqual(["custom.nope", "custom.old"]);
  });

  it("merges patches on update and refuses to clear a required field", () => {
    const existing = { vendor: "Acme", reason: "price" };
    expect(validateCustom(defs, { reason: null }, "update", existing).values).toEqual({ vendor: "Acme" });
    expect(validateCustom(defs, { vendor: null }, "update", existing).issues).toHaveLength(1);
  });
});

describe("validateOptions", () => {
  it("requires unique choice values", () => {
    const r = validateOptions("select", { choices: [{ value: "a", label: "A" }, { value: "a", label: "B" }] });
    expect(r.issues.length).toBeGreaterThan(0);
  });
  it("requires an ISO currency", () => {
    expect(validateOptions("currency", { currency: "usd" }).issues.length).toBeGreaterThan(0);
    expect(validateOptions("currency", { currency: "USD" }).issues).toEqual([]);
  });
});
