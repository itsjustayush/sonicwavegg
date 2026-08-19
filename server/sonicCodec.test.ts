import { describe, expect, it } from "vitest";
import { createPacket, estimateTransmission, packetToSymbols, SonicSettings, validatePacket } from "../client/src/lib/sonicCodec";

const balanced: SonicSettings = { band: "audible", profile: "balanced", volume: 0.7 };

describe("Sonic Morse packet framing", () => {
  it("encodes and validates a UTF-8 payload with integrity bytes", () => {
    const packet = createPacket("sonic hello", 42);
    const decoded = validatePacket(packet.bytes);

    expect(decoded).toMatchObject({ valid: true, sequence: 42, text: "sonic hello" });
  });

  it("rejects modified frames", () => {
    const packet = createPacket("stable", 12);
    const tampered = packet.bytes.slice();
    tampered[4] ^= 0x01;

    expect(validatePacket(tampered)).toMatchObject({ valid: false });
  });

  it("maps packet bytes to four tone codes per symbol", () => {
    const packet = createPacket("A", 1);
    const symbols = packetToSymbols(packet.bytes);

    expect(symbols.length).toBe(Math.ceil(packet.bytes.length / 2));
    expect(symbols[0]).toHaveLength(4);
    expect(symbols.flat().every(code => code >= 0 && code < 16)).toBe(true);
  });

  it("targets sub-second balanced modulation for a short message", () => {
    const estimate = estimateTransmission("Sonic Morse", balanced);

    expect(estimate.durationMs).toBeLessThan(1000);
  });
});
