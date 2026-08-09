import { describe, expect, it } from "vitest";

import { csvEscape, csvLine, parseCsv } from "./csv";

describe("csv escaping", () => {
  it("quotes fields with separators and newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });

  it("neutralizes formula injection", () => {
    expect(csvEscape("=cmd()")).toBe('"=cmd()"');
    expect(csvEscape("+1")).toBe('"+1"');
    expect(csvEscape("-2")).toBe('"-2"');
    expect(csvEscape("@x")).toBe('"@x"');
  });

  it("builds CRLF lines", () => {
    expect(csvLine(["a", "b", 1])).toBe("a,b,1\r\n");
  });
});

describe("csv parsing", () => {
  it("parses plain rows with CRLF and LF", () => {
    expect(parseCsv("a,b\r\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("unescapes quoted fields, separators and newlines", () => {
    expect(parseCsv('"a,b","say ""hi""","line\nbreak"')).toEqual([
      ["a,b", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("strips a leading BOM", () => {
    expect(parseCsv("\uFEFFname,price\r\nNetflix,138\r\n")).toEqual([
      ["name", "price"],
      ["Netflix", "138"],
    ]);
  });

  it("keeps empty trailing fields and skips the phantom row after a final newline", () => {
    expect(parseCsv("a,\r\n")).toEqual([["a", ""]]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });

  it("round-trips formula-injection quoting back to the original text", () => {
    const fields = ["=cmd()", "+1", "-2", "@x", "\tINDIRECT()", "plain"];
    expect(parseCsv(csvLine(fields))[0]).toEqual(fields);
  });

  it("round-trips multi-line export output", () => {
    const text =
      csvLine(["name", "notes"]) +
      csvLine(["Netflix", "line1\nline2"]) +
      csvLine(["Acme, Inc", 'say "hi"']);
    expect(parseCsv(text)).toEqual([
      ["name", "notes"],
      ["Netflix", "line1\nline2"],
      ["Acme, Inc", 'say "hi"'],
    ]);
  });
});
