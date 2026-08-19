const MAX_READOUT_CHARACTERS = 280;
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

export function sanitizeVoiceReadout(text: string) {
  const normalized = text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) throw new Error("A readable decoded message is required.");
  if (normalized.length > MAX_READOUT_CHARACTERS) throw new Error(`Voice readout is limited to ${MAX_READOUT_CHARACTERS} characters.`);
  return normalized;
}

export async function createVoiceReadout(text: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Voice readout is not configured on this project.");

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}?output_format=mp3_22050_32`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: sanitizeVoiceReadout(text),
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.58,
        similarity_boost: 0.72,
        style: 0.12,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ElevenLabs could not create the voice readout (${response.status}): ${detail.slice(0, 180)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { audioDataUrl: `data:audio/mpeg;base64,${audio}` };
}
