import { getToneFrequency, SONIC_PROTOCOL, SonicSettings, symbolDuration, validatePacket } from "./sonicCodec";

export type ReceivedSonicMessage = {
  text: string;
  sequence: number;
  quality: number;
  receivedAt: number;
};

type DecodedSymbol = { codes: number[]; quality: number };

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
  return q1 * q1 + q2 * q2 - coefficient * q1 * q2;
}

function decodeSymbol(samples: Float32Array, sampleRate: number, settings: SonicSettings): DecodedSymbol {
  const codes: number[] = [];
  const quality: number[] = [];

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
    codes.push(highestIndex);
    quality.push(Math.min(1, Math.max(0, (highest / Math.max(1, second) - 1) / 3)));
  }

  return { codes, quality: quality.reduce((sum, value) => sum + value, 0) / quality.length };
}

function matches(symbol: DecodedSymbol, code: number) {
  return symbol.quality > 0.22 && symbol.codes.every(value => value === code);
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
  private state: "seek" | "preamble" | "sync" | "payload" = "seek";
  private candidateStart = 0;
  private preambleCount = 0;
  private packetBytes: number[] = [];
  private nibbles: number[] = [];
  private expectedPacketBytes: number | null = null;
  private quality: number[] = [];
  private readonly onMessage: (message: ReceivedSonicMessage) => void;

  constructor(sampleRate: number, settings: SonicSettings, onMessage: (message: ReceivedSonicMessage) => void) {
    this.sampleRate = sampleRate;
    this.settings = settings;
    this.onMessage = onMessage;
  }

  updateSettings(settings: SonicSettings) {
    const needsReset = settings.band !== this.settings.band || settings.profile !== this.settings.profile;
    this.settings = settings;
    if (needsReset) this.reset();
  }

  reset() {
    this.state = "seek";
    this.candidateStart = 0;
    this.preambleCount = 0;
    this.packetBytes = [];
    this.nibbles = [];
    this.expectedPacketBytes = null;
    this.quality = [];
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

  private process() {
    const samplesPerSymbol = this.symbolSamples();
    const searchHop = Math.max(32, Math.floor(samplesPerSymbol / 4));
    let safety = 0;

    while (this.buffer.length - this.offset >= samplesPerSymbol && safety < 120) {
      safety += 1;
      const symbol = decodeSymbol(this.buffer.subarray(this.offset, this.offset + samplesPerSymbol), this.sampleRate, this.settings);

      if (this.state === "seek") {
        if (matches(symbol, 0)) {
          this.state = "preamble";
          this.candidateStart = this.offset;
          this.preambleCount = 1;
          this.offset += samplesPerSymbol;
        } else {
          this.offset += searchHop;
        }
        continue;
      }

      if (this.state === "preamble") {
        if (matches(symbol, 0)) {
          this.preambleCount += 1;
          this.offset += samplesPerSymbol;
          if (this.preambleCount >= SONIC_PROTOCOL.preambleSymbols) this.state = "sync";
        } else {
          this.state = "seek";
          this.offset = this.candidateStart + searchHop;
        }
        continue;
      }

      if (this.state === "sync") {
        if (matches(symbol, SONIC_PROTOCOL.syncCode)) {
          this.state = "payload";
          this.packetBytes = [];
          this.nibbles = [];
          this.expectedPacketBytes = null;
          this.quality = [];
          this.offset += samplesPerSymbol;
        } else {
          this.state = "seek";
          this.offset = this.candidateStart + searchHop;
        }
        continue;
      }

      this.quality.push(symbol.quality);
      this.nibbles.push(...symbol.codes);
      this.offset += samplesPerSymbol;
      while (this.nibbles.length >= 4) {
        const byteA = (this.nibbles[0] << 4) | this.nibbles[1];
        const byteB = (this.nibbles[2] << 4) | this.nibbles[3];
        this.packetBytes.push(byteA, byteB);
        this.nibbles.splice(0, 4);
        if (this.packetBytes.length >= 3 && this.expectedPacketBytes === null) {
          const payloadLength = this.packetBytes[2];
          if (payloadLength > SONIC_PROTOCOL.maxPayloadBytes || this.packetBytes[0] !== SONIC_PROTOCOL.magic) {
            this.reset();
            break;
          }
          this.expectedPacketBytes = 3 + payloadLength + 3;
        }
        if (this.expectedPacketBytes !== null && this.packetBytes.length >= this.expectedPacketBytes) {
          const result = validatePacket(new Uint8Array(this.packetBytes.slice(0, this.expectedPacketBytes)));
          if (result.valid) {
            this.onMessage({
              text: result.text,
              sequence: result.sequence,
              quality: Math.round((this.quality.reduce((sum, value) => sum + value, 0) / Math.max(1, this.quality.length)) * 100),
              receivedAt: Date.now(),
            });
          }
          this.reset();
          break;
        }
      }
    }

    const keepFrom = Math.max(0, this.offset - samplesPerSymbol * 4);
    if (keepFrom > 0) {
      this.buffer = this.buffer.slice(keepFrom);
      this.offset -= keepFrom;
    }
  }
}
