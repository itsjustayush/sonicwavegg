import { getToneFrequency, SONIC_PROTOCOL, SonicSettings, symbolDuration, validatePacket } from "./sonicCodec";

export type ReceiverState = "idle" | "scanning" | "syncing" | "decoding";

export type ReceiverDiagnostics = {
  state: ReceiverState;
  confidence: number;
  noiseFloor: number;
  frameProgress: number;
};

export type ReceivedSonicMessage = {
  text: string;
  sequence: number;
  quality: number;
  receivedAt: number;
};

type DecodedSymbol = { codes: number[]; quality: number; rms: number };

function goertzelPower(samples: Float32Array, frequency: number, sampleRate: number) {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  const length = samples.length;

  for (let index = 0; index < length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, length - 1));
    q0 = samples[index] * window + coefficient * q1 - q2;
    q2 = q1;
    q1 = q0;
  }
  return Math.max(0, q1 * q1 + q2 * q2 - coefficient * q1 * q2);
}

function rms(samples: Float32Array) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function tolerantTonePower(samples: Float32Array, frequency: number, sampleRate: number) {
  // A small tolerance covers clock drift and practical speaker/microphone response without crossing the 70 Hz tone grid.
  return Math.max(
    goertzelPower(samples, frequency, sampleRate),
    goertzelPower(samples, frequency - 14, sampleRate),
    goertzelPower(samples, frequency + 14, sampleRate),
  );
}

function decodeSymbol(samples: Float32Array, sampleRate: number, settings: SonicSettings): DecodedSymbol {
  const codes: number[] = [];
  const confidence: number[] = [];
  const inputRms = rms(samples);

  for (let group = 0; group < SONIC_PROTOCOL.groups; group += 1) {
    const powers = Array.from({ length: SONIC_PROTOCOL.tonesPerGroup }, (_, code) =>
      goertzelPower(samples, getToneFrequency(settings.band, group, code), sampleRate),
    );
    let highestIndex = 0;
    let highest = 0;
    let second = 0;
    powers.forEach((power, index) => {
      if (power > highest) {
        second = highest;
        highest = power;
        highestIndex = index;
      } else if (power > second) {
        second = power;
      }
    });

    // The strongest exact-grid carrier identifies the nearest symbol reliably. Probe only
    // that candidate at small offsets rather than tripling all 64 carrier calculations.
    highest = Math.max(highest, tolerantTonePower(samples, getToneFrequency(settings.band, group, highestIndex), sampleRate));
    const separation = (highest - second) / Math.max(1e-9, highest);
    const carrierStrength = highest / Math.max(1e-9, inputRms * inputRms * samples.length * 0.026);
    codes.push(highestIndex);
    confidence.push(Math.min(1, Math.max(0, separation * 0.72 + Math.min(1, carrierStrength) * 0.28)));
  }

  return { codes, quality: confidence.reduce((sum, value) => sum + value, 0) / confidence.length, rms: inputRms };
}

function appendSamples(existing: Float32Array, incoming: Float32Array) {
  const combined = new Float32Array(existing.length + incoming.length);
  combined.set(existing);
  combined.set(incoming, existing.length);
  return combined;
}

export class SonicReceiver {
  private settings: SonicSettings;
  private sampleRate: number;
  private buffer = new Float32Array(0);
  private offset = 0;
  private state: ReceiverState = "scanning";
  private packetBytes: number[] = [];
  private nibbles: number[] = [];
  private expectedPacketBytes: number | null = null;
  private quality: number[] = [];
  private noiseFloor = 0.001;
  private lockConfidence = 0;
  private frameProgress = 0;
  private lastDiagnosticAt = 0;
  private readonly onMessage: (message: ReceivedSonicMessage) => void;
  private readonly onDiagnostics?: (diagnostics: ReceiverDiagnostics) => void;

  constructor(
    sampleRate: number,
    settings: SonicSettings,
    onMessage: (message: ReceivedSonicMessage) => void,
    onDiagnostics?: (diagnostics: ReceiverDiagnostics) => void,
  ) {
    this.sampleRate = sampleRate;
    this.settings = settings;
    this.onMessage = onMessage;
    this.onDiagnostics = onDiagnostics;
  }

  updateSettings(settings: SonicSettings) {
    const needsReset = settings.band !== this.settings.band || settings.profile !== this.settings.profile;
    this.settings = settings;
    if (needsReset) this.reset();
  }

  reset() {
    this.state = "scanning";
    this.packetBytes = [];
    this.nibbles = [];
    this.expectedPacketBytes = null;
    this.quality = [];
    this.lockConfidence = 0;
    this.frameProgress = 0;
    this.emitDiagnostics(true);
  }

  push(input: Float32Array) {
    if (input.length === 0) return;
    const unread = this.buffer.slice(this.offset);
    this.buffer = appendSamples(unread, input);
    this.offset = 0;
    this.process();
  }

  private symbolSamples() {
    return Math.max(64, Math.round(this.sampleRate * symbolDuration(this.settings)));
  }

  private emitDiagnostics(force = false) {
    const now = Date.now();
    if (!force && now - this.lastDiagnosticAt < 80) return;
    this.lastDiagnosticAt = now;
    this.onDiagnostics?.({
      state: this.state,
      confidence: this.lockConfidence,
      noiseFloor: this.noiseFloor,
      frameProgress: this.frameProgress,
    });
  }

  private isLikely(symbol: DecodedSymbol, code: number, threshold = 0.31) {
    const gate = Math.max(0.00045, this.noiseFloor * 1.32);
    return symbol.quality >= threshold && symbol.rms >= gate && symbol.codes.every(value => value === code);
  }

  private refineSync(candidate: number, samplesPerSymbol: number) {
    const radius = Math.max(12, Math.floor(samplesPerSymbol / 5));
    const step = Math.max(8, Math.floor(samplesPerSymbol / 128));
    let best: { offset: number; symbol: DecodedSymbol } | null = null;

    for (let shift = -radius; shift <= radius; shift += step) {
      const start = candidate + shift;
      if (start < 0 || start + samplesPerSymbol > this.buffer.length) continue;
      const symbol = decodeSymbol(this.buffer.subarray(start, start + samplesPerSymbol), this.sampleRate, this.settings);
      if (!symbol.codes.every(value => value === SONIC_PROTOCOL.syncCode)) continue;
      if (!best || symbol.quality > best.symbol.quality) best = { offset: start, symbol };
    }

    if (!best || !this.isLikely(best.symbol, SONIC_PROTOCOL.syncCode, 0.34)) return null;
    // The sync chord uses the furthest code in every group. It is unique in the frame,
    // while packet magic and CRC reject any accidental lock more safely than a second,
    // timing-sensitive preamble check would.
    return best;
  }

  private startPayload(syncOffset: number, symbol: DecodedSymbol, samplesPerSymbol: number) {
    this.state = "decoding";
    this.packetBytes = [];
    this.nibbles = [];
    this.expectedPacketBytes = null;
    this.quality = [];
    this.lockConfidence = symbol.quality;
    this.frameProgress = 0;
    this.offset = syncOffset + samplesPerSymbol;
    this.emitDiagnostics(true);
  }

  private refinePayloadSymbol(samplesPerSymbol: number) {
    const radius = Math.max(12, Math.floor(samplesPerSymbol / 32));
    const step = Math.max(6, Math.floor(radius / 3));
    let best: { offset: number; symbol: DecodedSymbol } | null = null;

    for (let shift = -radius; shift <= radius; shift += step) {
      const start = this.offset + shift;
      if (start < 0 || start + samplesPerSymbol > this.buffer.length) continue;
      const symbol = decodeSymbol(this.buffer.subarray(start, start + samplesPerSymbol), this.sampleRate, this.settings);
      if (!best || symbol.quality > best.symbol.quality) best = { offset: start, symbol };
    }
    return best;
  }

  private processPayload(symbol: DecodedSymbol, symbolOffset: number, samplesPerSymbol: number, searchHop: number) {
    if (symbol.quality < 0.17 || symbol.rms < Math.max(0.00035, this.noiseFloor * 1.08)) {
      this.reset();
      this.offset += searchHop;
      return;
    }

    this.quality.push(symbol.quality);
    this.lockConfidence = this.quality.reduce((sum, value) => sum + value, 0) / this.quality.length;
    this.nibbles.push(...symbol.codes);
    this.offset = symbolOffset + samplesPerSymbol;

    while (this.nibbles.length >= 4) {
      const byteA = (this.nibbles[0] << 4) | this.nibbles[1];
      const byteB = (this.nibbles[2] << 4) | this.nibbles[3];
      this.packetBytes.push(byteA, byteB);
      this.nibbles.splice(0, 4);

      if (this.packetBytes.length >= 3 && this.expectedPacketBytes === null) {
        const payloadLength = this.packetBytes[2];
        if (payloadLength > SONIC_PROTOCOL.maxPayloadBytes || this.packetBytes[0] !== SONIC_PROTOCOL.magic) {
          this.reset();
          return;
        }
        this.expectedPacketBytes = 3 + payloadLength + 3;
      }

      if (this.expectedPacketBytes !== null) {
        this.frameProgress = Math.min(1, this.packetBytes.length / this.expectedPacketBytes);
      }

      if (this.expectedPacketBytes !== null && this.packetBytes.length >= this.expectedPacketBytes) {
        const result = validatePacket(new Uint8Array(this.packetBytes.slice(0, this.expectedPacketBytes)));
        if (result.valid) {
          this.onMessage({
            text: result.text,
            sequence: result.sequence,
            quality: Math.round(this.lockConfidence * 100),
            receivedAt: Date.now(),
          });
        }
        this.reset();
        return;
      }
    }
  }

  private process() {
    const samplesPerSymbol = this.symbolSamples();
    const searchHop = Math.max(32, Math.floor(samplesPerSymbol / 6));
    let safety = 0;

    while (this.buffer.length - this.offset >= samplesPerSymbol && safety < 180) {
      safety += 1;
      const symbol = decodeSymbol(this.buffer.subarray(this.offset, this.offset + samplesPerSymbol), this.sampleRate, this.settings);

      if (this.state === "decoding") {
        const tracked = this.refinePayloadSymbol(samplesPerSymbol);
        if (!tracked) break;
        this.processPayload(tracked.symbol, tracked.offset, samplesPerSymbol, searchHop);
        continue;
      }

      if (symbol.quality < 0.2) this.noiseFloor = this.noiseFloor * 0.94 + symbol.rms * 0.06;
      this.state = "scanning";
      this.lockConfidence = symbol.quality;
      this.emitDiagnostics();

      if (this.isLikely(symbol, SONIC_PROTOCOL.syncCode, 0.3)) {
        this.state = "syncing";
        this.emitDiagnostics(true);
        const lock = this.refineSync(this.offset, samplesPerSymbol);
        if (lock) {
          this.startPayload(lock.offset, lock.symbol, samplesPerSymbol);
          continue;
        }
      }

      this.offset += searchHop;
    }

    const keepFrom = Math.max(0, this.offset - samplesPerSymbol * 6);
    if (keepFrom > 0) {
      this.buffer = this.buffer.slice(keepFrom);
      this.offset -= keepFrom;
    }
  }
}
