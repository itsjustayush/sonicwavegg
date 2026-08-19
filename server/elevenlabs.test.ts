import { describe, expect, it } from "vitest";
import { sanitizeVoiceReadout } from "./elevenlabs";

describe("voice readout validation", () => {
  it("normalizes safe decoded text before it reaches the provider", () => {
    expect(sanitizeVoiceReadout("  Sonic\n\u0000Morse  ")).toBe("Sonic Morse");
  });

  it("rejects empty and excessively long text", () => {
    expect(() => sanitizeVoiceReadout("  \n \t ")).toThrow("readable");
    expect(() => sanitizeVoiceReadout("x".repeat(281))).toThrow("280");
  });
});
