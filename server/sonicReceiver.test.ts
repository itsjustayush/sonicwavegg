import { describe, expect, it } from "vitest";
import { encodeTransmission, SonicSettings } from "../client/src/lib/sonicCodec";
import { ReceivedSonicMessage, SonicReceiver } from "../client/src/lib/sonicReceiver";

const settings: SonicSettings = { band: "audible", profile: "balanced", volume: 0.7 };

describe("Sonic Morse streaming receiver", () => {
  it("detects framing and decodes an encoder-produced payload from microphone-style chunks", () => {
    const received: ReceivedSonicMessage[] = [];
    const receiver = new SonicReceiver(48_000, settings, message => received.push(message));
    const transmission = encodeTransmission("GO", settings, 48_000, 7);

    for (let offset = 0; offset < transmission.samples.length; offset += 1024) {
      receiver.push(transmission.samples.slice(offset, Math.min(offset + 1024, transmission.samples.length)));
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ text: "GO", sequence: 7 });
    expect(received[0]?.quality).toBeGreaterThan(70);
  });
});
