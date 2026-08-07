import { describe, expect, it } from "vitest";

import { csvEscape, csvLine } from "./csv";

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
