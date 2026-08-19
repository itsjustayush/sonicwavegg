import { describe, expect, it } from "vitest";

describe("ElevenLabs credential", () => {
  it("authenticates against the provider account endpoint", async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    expect(apiKey, "ELEVENLABS_API_KEY must be configured").toBeTruthy();

    const response = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": apiKey! },
    });

    expect(response.ok, `ElevenLabs rejected the configured credential with HTTP ${response.status}`).toBe(true);
  }, 20_000);
});
