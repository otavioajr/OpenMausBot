import { describe, expect, it } from "vitest";

import { __testing } from "./grok.ts";

const { makeThinkStripper, stripThink } = __testing;

describe("stripThink", () => {
  it("removes a think block and trims", () => {
    expect(stripThink("<think>scratch</think>Hello")).toBe("Hello");
  });

  it("removes an empty think block", () => {
    expect(stripThink("<think></think>Sou o bot.")).toBe("Sou o bot.");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripThink("just a normal answer")).toBe("just a normal answer");
  });

  it("drops an unterminated think block", () => {
    expect(stripThink("<think>never closed")).toBe("");
  });

  it("handles several blocks", () => {
    expect(stripThink("<think>a</think>one<think>b</think>two")).toBe("onetwo");
  });

  it("keeps inequality signs that are not tags", () => {
    expect(stripThink("if a < b and c > d then")).toBe("if a < b and c > d then");
  });
});

describe("makeThinkStripper (streaming)", () => {
  /** Feed a whole string one character at a time — the worst case for tags
   * straddling chunk boundaries. */
  function drainCharByChar(input: string): string {
    const s = makeThinkStripper();
    let out = "";
    for (const ch of input) out += s.push(ch);
    return out + s.flush();
  }

  it("strips a block split across single-character chunks", () => {
    expect(drainCharByChar("<think>hidden</think>visible")).toBe("visible");
  });

  it("never emits a partial opening tag", () => {
    const s = makeThinkStripper();
    // "<thi" could still become "<think>" — it must be held back, not emitted
    expect(s.push("abc<thi")).toBe("abc");
    expect(s.push("nk>secret</think>done")).toBe("done");
  });

  it("emits a dangling '<' that turns out to be ordinary text", () => {
    const s = makeThinkStripper();
    expect(s.push("5 <")).toBe("5 ");
    expect(s.push(" 6")).toBe("< 6");
  });

  it("flush releases held-back text when no tag materialises", () => {
    const s = makeThinkStripper();
    expect(s.push("value <thin")).toBe("value ");
    expect(s.flush()).toBe("<thin");
  });

  it("flush drops text inside an unterminated block", () => {
    const s = makeThinkStripper();
    expect(s.push("<think>partial reasoning")).toBe("");
    expect(s.flush()).toBe("");
  });

  it("streams plain content through unchanged", () => {
    expect(drainCharByChar("no tags at all")).toBe("no tags at all");
  });
});
