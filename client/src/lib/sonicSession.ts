export type SonicSessionState = "idle" | "arming" | "armed" | "sending" | "received" | "error";

export type SonicSession = {
  state: SonicSessionState;
  lastMessage?: string;
  notice: string;
};

export type SonicSessionEvent =
  | { type: "ARM" }
  | { type: "ARMED" }
  | { type: "SEND" }
  | { type: "SENT" }
  | { type: "RECEIVED"; message: string }
  | { type: "STOP" }
  | { type: "FAIL"; message: string };

export const initialSonicSession: SonicSession = { state: "idle", notice: "Receiver disarmed" };

export function sonicSessionReducer(session: SonicSession, event: SonicSessionEvent): SonicSession {
  switch (event.type) {
    case "ARM":
      return { ...session, state: "arming", notice: "Requesting microphone channel" };
    case "ARMED":
      return { ...session, state: "armed", notice: "Carrier watch active" };
    case "SEND":
      return { ...session, state: "sending", notice: "Emitting Sonic Morse frame" };
    case "SENT":
      return { ...session, state: "armed", notice: "Carrier watch active" };
    case "RECEIVED":
      return { state: "received", lastMessage: event.message, notice: "Verified frame received" };
    case "STOP":
      return initialSonicSession;
    case "FAIL":
      return { ...session, state: "error", notice: event.message };
  }
}

export function sessionActionLabel(state: SonicSessionState) {
  if (state === "idle" || state === "error") return "Arm Sonic Session";
  if (state === "arming") return "Arming channel…";
  if (state === "armed") return "End Session";
  if (state === "sending") return "Frame in flight…";
  return "Continue Session";
}

export type SonicSessionTimelineItem = {
  id: "arm" | "sync" | "emit" | "verify";
  label: string;
  state: "idle" | "active" | "complete" | "error";
};

export function sessionTimeline(state: SonicSessionState, receiverState: "idle" | "scanning" | "syncing" | "decoding"): SonicSessionTimelineItem[] {
  const armed = state === "armed" || state === "sending" || state === "received";
  const syncing = receiverState === "syncing" || receiverState === "decoding";
  const emitting = state === "sending";
  const verified = state === "received";
  const failed = state === "error";

  return [
    { id: "arm", label: "ARM", state: failed ? "error" : armed ? "complete" : state === "arming" ? "active" : "idle" },
    { id: "sync", label: "SYNC", state: failed ? "error" : syncing ? "active" : verified || emitting ? "complete" : "idle" },
    { id: "emit", label: "EMIT", state: failed ? "error" : emitting ? "active" : verified ? "complete" : "idle" },
    { id: "verify", label: "VERIFY", state: failed ? "error" : verified ? "complete" : "idle" },
  ];
}
