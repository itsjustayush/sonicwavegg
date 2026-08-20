import { describe, expect, it } from "vitest";
import { encodeTransmission, SonicSettings } from "../client/src/lib/sonicCodec";
import { ReceivedSonicMessage, SonicReceiver } from "../client/src/lib/sonicReceiver";

const settings: SonicSettings = { band: "audible", profile: "balanced", volume: 0.7 };

function feedInUnevenChunks(receiver: SonicReceiver, samples: Float32Array) {
  const chunkSizes = [383, 911, 547, 1379, 701];
  let offset = 0;
  let turn = 0;
  while (offset < samples.length) {
    const size = chunkSizes[turn % chunkSizes.length];
    receiver.push(samples.slice(offset, Math.min(offset + size, samples.length)));
    offset += size;
    turn += 1;
  }
}

function roomLikeCapture(samples: Float32Array, leadingSamples: number) {
  const captured = new Float32Array(samples.length + leadingSamples + 620);
  for (let index = 0; index < captured.length; index += 1) {
    const direct = index >= leadingSamples && index - leadingSamples < samples.length ? samples[index - leadingSamples] * 0.58 : 0;
    const reflectionIndex = index - leadingSamples - 174;
    const reflection = reflectionIndex >= 0 && reflectionIndex < samples.length ? samples[reflectionIndex] * 0.13 : 0;
    const ambient = Math.sin(index * 0.071) * 0.0025 + Math.sin(index * 0.013) * 0.0015;
    captured[index] = direct + reflection + ambient;
  }
  return captured;
}

function slightlyTimeStretched(samples: Float32Array, factor: number) {
  const stretched = new Float32Array(Math.ceil(samples.length * factor));
  for (let index = 0; index < stretched.length; index += 1) {
    const source = index / factor;
    const left = Math.floor(source);
    const right = Math.min(samples.length - 1, left + 1);
    const mix = source - left;
    stretched[index] = (samples[left] ?? 0) * (1 - mix) + (samples[right] ?? 0) * mix;
  }
  return stretched;
}

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

  it("acquires an offset frame with mild room reflection and uneven microphone chunks", () => {
    const received: ReceivedSonicMessage[] = [];
    const receiver = new SonicReceiver(48_000, settings, message => received.push(message));
    const transmission = encodeTransmission("LOCK", settings, 48_000, 19);

    feedInUnevenChunks(receiver, roomLikeCapture(transmission.samples, 739));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ text: "LOCK", sequence: 19 });
    expect(received[0]?.quality).toBeGreaterThan(35);
  });

  it("tracks a mildly time-stretched frame without losing payload alignment", () => {
    const received: ReceivedSonicMessage[] = [];
    const receiver = new SonicReceiver(48_000, settings, message => received.push(message));
    const transmission = encodeTransmission("DRIFT", settings, 48_000, 31);

    feedInUnevenChunks(receiver, roomLikeCapture(slightlyTimeStretched(transmission.samples, 1.004), 441));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ text: "DRIFT", sequence: 31 });
  });

  it("does not emit a frame from deterministic low-level ambient noise", () => {
    const received: ReceivedSonicMessage[] = [];
    const receiver = new SonicReceiver(48_000, settings, message => received.push(message));
    const ambient = new Float32Array(48_000 * 2);
    for (let index = 0; index < ambient.length; index += 1) ambient[index] = Math.sin(index * 0.071) * 0.002;

    feedInUnevenChunks(receiver, ambient);

    expect(received).toHaveLength(0);
  });
});
