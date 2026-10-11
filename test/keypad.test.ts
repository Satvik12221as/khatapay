import { describe, it, expect } from "vitest";
import { Keypad, fatFingerCheck, type Key } from "../src/keypad/keypad";

// helper: type a string like "30+40+20" on the keypad ("*" -> ×, "/" -> ÷)
const type = (s: string, kp = new Keypad()) => {
  let v = kp.view();
  for (const ch of s) v = kp.press((ch === "*" ? "×" : ch === "/" ? "÷" : ch) as Key);
  return v;
};

describe("Keypad", () => {
  it("adds items: 30 + 40 + 20 = 90", () => {
    const v = type("30+40+20");
    expect(v.totalCents).toBe(9000);
    expect(v.totalFormatted).toBe("90.00");
    expect(v.display).toBe("30 + 40 + 20");
    expect(v.lines.map(l => l.cents)).toEqual([3000, 4000, 2000]);
    expect(v.canPay).toBe(true);
  });
  it("multiplication binds tighter than addition", () => {
    expect(type("40+3*25").totalCents).toBe(11500);   // not (40+3)*25
    expect(type("3*25+40").totalCents).toBe(11500);
  });
  it("subtracts (discount)", () => expect(type("100-15").totalCents).toBe(8500));
  it("divides and rounds to cents", () => {
    expect(type("100/4").totalCents).toBe(2500);
    expect(type("100/3").totalCents).toBe(3333);
    expect(type("200/3").totalCents).toBe(6667);
  });
  it("exact decimal money, no float drift", () => {
    expect(type("0.1+0.2").totalCents).toBe(30);
    expect(type("12.50+7.25").totalCents).toBe(1975);
    expect(type("2.5*45.50").totalCents).toBe(11375);
  });
  it("limits to 2 decimals and 7 integer digits", () => {
    expect(type("1.999").display).toBe("1.99");
    expect(type("123456789").display).toBe("1234567");
  });
  it("handles leading zero and bare dot", () => {
    expect(type("007").display).toBe("7");
    expect(type(".5+.25").totalCents).toBe(75);
  });
  it("replaces a repeated operator", () => expect(type("30+-*40").display).toBe("30 × 40"));
  it("cannot start with an operator", () => expect(type("+-*/").display).toBe(""));
  it("incomplete sum cannot be paid", () => {
    const v = type("30+");
    expect(v.totalCents).toBeNull(); expect(v.canPay).toBe(false);
    expect(type("").canPay).toBe(false);
  });
  it("zero or negative totals cannot be paid", () => {
    expect(type("10-10").canPay).toBe(false);
    expect(type("10-20").canPay).toBe(false);
    expect(type("10-20").totalCents).toBe(-1000);
  });
  it("division by zero shows an error and blocks payment", () => {
    const v = type("50/0");
    expect(v.error).toBe("Can't divide by zero"); expect(v.canPay).toBe(false);
  });
  it("backspace and clear work", () => {
    const kp = new Keypad(); type("30+40", kp);
    expect(kp.press("back").display).toBe("30 + 4");
    expect(kp.press("back").display).toBe("30 +");
    expect(kp.press("back").display).toBe("30");
    expect(kp.press("clear").display).toBe("");
  });
  it("trailing dot is dropped when an operator follows", () => expect(type("5.+3").display).toBe("5 + 3"));
  it("receipt lines always add up to the total", () => {
    const v = type("10/3+10/3+10/3");
    expect(v.lines.reduce((a, l) => a + l.cents, 0)).toBe(v.totalCents);
  });
  it("rejects absurdly large totals", () => expect(type("9999999*9999999").error).toBe("Amount too large"));
  it("fat-finger guard flags 5x spikes", () => {
    expect(fatFingerCheck(1200000, 120000).suspicious).toBe(true);
    expect(fatFingerCheck(130000, 120000).suspicious).toBe(false);
    expect(fatFingerCheck(5000, null).suspicious).toBe(false);
  });
});