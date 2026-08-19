export type SonicBand = "audible" | "ultrasonic";
export type SonicProfile = "turbo" | "balanced" | "robust";

export type SonicSettings = {
  band: SonicBand;
  profile: SonicProfile;
  volume: number;
};

export const SONIC_PROTOCOL = {
  magic: 0x53,
  maxPayloadBytes: 48,
  groups: 4,
  tonesPerGroup: 16,
  preambleSymbols: 3,
  syncCode: 15,
} as const;

const profileDurations: Record<SonicProfile, number> = {
  robust: 0.052,
  balanced: 0.032,
  turbo: 0.024,
};

export const sonicProfiles: Record<SonicProfile, { label: string; durationMs: number; rate: string }> = {
  robust: { label: "Robust", durationMs: 52, rate: "38 B/s" },
  balanced: { label: "Balanced", durationMs: 32, rate: "63 B/s" },
  turbo: { label: "Turbo", durationMs: 24, rate: "83 B/s" },
};

export type SonicPacket = {
  sequence: number;
  payload: Uint8Array;
  bytes: Uint8Array;
};

export type EncodedTransmission = {
  samples: Float32Array;
  durationMs: number;
  packetBytes: number;
  payloadBytes: number;
  symbols: number;
  sequence: number;
};

export function symbolDuration(settings: Pick<SonicSettings, "profile">) {
  return profileDurations[settings.profile];
}

export function getToneFrequency(band: SonicBand, group: number, code: number) {
  const base = band === "audible" ? 1700 : 14500;
  const groupSpacing = band === "audible" ? 1350 : 1400;
  const toneSpacing = band === "audible" ? 70 : 70;
  return base + group * groupSpacing + code * toneSpacing;
}

export function crc8(input: Uint8Array) {
  let crc = 0;
  for (const byte of Array.from(input)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function xorParity(input: Uint8Array) {
  return input.reduce((value, byte) => value ^ byte, 0);
}

function sumParity(input: Uint8Array) {
  return input.reduce((value, byte) => (value + byte) & 0xff, 0);
}

export function createPacket(text: string, sequence = Math.floor(Math.random() * 256)): SonicPacket {
  const payload = new TextEncoder().encode(text);
  if (payload.byteLength === 0) throw new Error("Enter a message before transmitting.");
  if (payload.byteLength > SONIC_PROTOCOL.maxPayloadBytes) {
    throw new Error(`Messages are limited to ${SONIC_PROTOCOL.maxPayloadBytes} UTF-8 bytes in this profile.`);
  }

  const core = new Uint8Array(3 + payload.byteLength);
  core[0] = SONIC_PROTOCOL.magic;
  core[1] = sequence & 0xff;
  core[2] = payload.byteLength;
  core.set(payload, 3);

  const bytes = new Uint8Array(core.byteLength + 3);
  bytes.set(core);
  bytes[core.byteLength] = crc8(core);
  bytes[core.byteLength + 1] = xorParity(core);
  bytes[core.byteLength + 2] = sumParity(core);
  return { sequence, payload, bytes };
}

export function validatePacket(bytes: Uint8Array): { valid: true; sequence: number; text: string; payload: Uint8Array } | { valid: false; reason: string } {
  if (bytes.byteLength < 6) return { valid: false, reason: "Frame was too short." };
  if (bytes[0] !== SONIC_PROTOCOL.magic) return { valid: false, reason: "Unexpected frame magic." };

  const length = bytes[2];
  const expectedLength = 3 + length + 3;
  if (length > SONIC_PROTOCOL.maxPayloadBytes || bytes.byteLength !== expectedLength) {
    return { valid: false, reason: "Frame length was invalid." };
  }

  const core = bytes.slice(0, 3 + length);
  const crc = bytes[3 + length];
  const xor = bytes[4 + length];
  const sum = bytes[5 + length];
  if (crc8(core) !== crc || xorParity(core) !== xor || sumParity(core) !== sum) {
    return { valid: false, reason: "Frame integrity checks did not match." };
  }

  try {
    return { valid: true, sequence: bytes[1], text: new TextDecoder("utf-8", { fatal: true }).decode(core.slice(3)), payload: core.slice(3) };
  } catch {
    return { valid: false, reason: "Payload was not valid UTF-8." };
  }
}

export function packetToSymbols(packet: Uint8Array) {
  const paddedLength = Math.ceil(packet.byteLength / 2) * 2;
  const padded = new Uint8Array(paddedLength);
  padded.set(packet);
  const symbols: number[][] = [];

  for (let index = 0; index < padded.byteLength; index += 2) {
    const first = padded[index];
    const second = padded[index + 1];
    symbols.push([first >> 4, first & 0x0f, second >> 4, second & 0x0f]);
  }
  return symbols;
}

export function estimateTransmission(text: string, settings: SonicSettings) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength === 0) return { durationMs: 0, packetBytes: 0, symbols: 0 };
  const packetBytes = Math.min(bytes.byteLength, SONIC_PROTOCOL.maxPayloadBytes) + 6;
  const symbols = Math.ceil(packetBytes / 2);
  const totalSymbols = SONIC_PROTOCOL.preambleSymbols + 1 + symbols;
  return {
    durationMs: Math.round(totalSymbols * symbolDuration(settings) * 1000),
    packetBytes,
    symbols: totalSymbols,
  };
}

export function encodeTransmission(text: string, settings: SonicSettings, sampleRate: number, sequence?: number): EncodedTransmission {
  const packet = createPacket(text, sequence);
  const symbols = [
    ...Array.from({ length: SONIC_PROTOCOL.preambleSymbols }, () => [0, 0, 0, 0]),
    [SONIC_PROTOCOL.syncCode, SONIC_PROTOCOL.syncCode, SONIC_PROTOCOL.syncCode, SONIC_PROTOCOL.syncCode],
    ...packetToSymbols(packet.bytes),
  ];
  const duration = symbolDuration(settings);
  const samplesPerSymbol = Math.max(64, Math.round(sampleRate * duration));
  const samples = new Float32Array(samplesPerSymbol * symbols.length);
  const fadeSamples = Math.max(12, Math.min(Math.round(sampleRate * 0.0015), Math.floor(samplesPerSymbol / 8)));
  const amplitude = 0.9 * Math.min(1, Math.max(0.05, settings.volume)) / SONIC_PROTOCOL.groups;

  symbols.forEach((symbol, symbolIndex) => {
    const start = symbolIndex * samplesPerSymbol;
    for (let frame = 0; frame < samplesPerSymbol; frame += 1) {
      const edge = Math.min(1, frame / fadeSamples, (samplesPerSymbol - frame - 1) / fadeSamples);
      const t = (start + frame) / sampleRate;
      let value = 0;
      for (let group = 0; group < SONIC_PROTOCOL.groups; group += 1) {
        const frequency = getToneFrequency(settings.band, group, symbol[group]);
        value += Math.sin(2 * Math.PI * frequency * t + group * 0.73);
      }
      samples[start + frame] = value * amplitude * Math.max(0, edge);
    }
  });

  return {
    samples,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    packetBytes: packet.bytes.byteLength,
    payloadBytes: packet.payload.byteLength,
    symbols: symbols.length,
    sequence: packet.sequence,
  };
}

export function downsampleWaveform(samples: Float32Array, points = 108) {
  if (samples.length === 0) return Array.from({ length: points }, () => 0);
  const step = samples.length / points;
  return Array.from({ length: points }, (_, index) => samples[Math.min(samples.length - 1, Math.floor(index * step))] ?? 0);
}
