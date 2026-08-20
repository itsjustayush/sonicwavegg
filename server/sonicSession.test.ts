import { describe, expect, it } from "vitest";
import { initialSonicSession, sessionActionLabel, sessionTimeline, sonicSessionReducer } from "../client/src/lib/sonicSession";

describe("Sonic session orchestration", () => {
  it("moves from arming to carrier watch and transmission", () => {
    const arming = sonicSessionReducer(initialSonicSession, { type: "ARM" });
    const armed = sonicSessionReducer(arming, { type: "ARMED" });
    const sending = sonicSessionReducer(armed, { type: "SEND" });
    const returned = sonicSessionReducer(sending, { type: "SENT" });

    expect(arming.state).toBe("arming");
    expect(armed).toMatchObject({ state: "armed", notice: "Carrier watch active" });
    expect(sending.state).toBe("sending");
    expect(returned.state).toBe("armed");
  });

  it("surfaces received handoffs and resets cleanly", () => {
    const received = sonicSessionReducer(initialSonicSession, { type: "RECEIVED", message: "capsule accepted" });

    expect(received).toMatchObject({ state: "received", lastMessage: "capsule accepted" });
    expect(sessionActionLabel(received.state)).toBe("Continue Session");
    expect(sonicSessionReducer(received, { type: "STOP" })).toEqual(initialSonicSession);
  });

  it("exposes a packet timeline from arming through verified handoff", () => {
    expect(sessionTimeline("arming", "scanning")[0]).toMatchObject({ id: "arm", state: "active" });
    expect(sessionTimeline("armed", "syncing")[1]).toMatchObject({ id: "sync", state: "active" });
    expect(sessionTimeline("sending", "decoding")[2]).toMatchObject({ id: "emit", state: "active" });
    expect(sessionTimeline("received", "scanning")[3]).toMatchObject({ id: "verify", state: "complete" });
  });
});
