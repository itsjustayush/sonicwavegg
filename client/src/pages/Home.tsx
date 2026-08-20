import { useCallback, useMemo, useState } from "react";
import {
  Activity,
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Ear,
  Gauge,
  History,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  Waves,
} from "lucide-react";
import { toast } from "sonner";
import { useSonicAudio } from "@/hooks/useSonicAudio";
import { estimateTransmission, SonicBand, SonicProfile, SonicSettings, sonicProfiles } from "@/lib/sonicCodec";
import { ReceivedSonicMessage } from "@/lib/sonicReceiver";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";

type HistoryItem = {
  id: string;
  kind: "sent" | "received";
  message: string;
  createdAt: number;
  quality: number;
  durationMs?: number;
  sequence?: number;
};

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function Oscilloscope({ data, color = "#89F2BE", dimmed = false }: { data: number[]; color?: string; dimmed?: boolean }) {
  const points = data.map((value, index) => `${(index / Math.max(1, data.length - 1)) * 100},${50 - value * 42}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-label="Live audio waveform" role="img">
      <defs>
        <linearGradient id={`wave-${color.slice(1)}`} x1="0" x2="1">
          <stop stopColor={color} stopOpacity={dimmed ? "0.28" : "0.45"} />
          <stop offset="0.55" stopColor={color} stopOpacity={dimmed ? "0.38" : "1"} />
          <stop offset="1" stopColor={color} stopOpacity={dimmed ? "0.22" : "0.55"} />
        </linearGradient>
      </defs>
      <path d="M0 50 H100" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      <polyline points={points} fill="none" stroke={`url(#wave-${color.slice(1)})`} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Spectrum({ values, active }: { values: number[]; active: boolean }) {
  return (
    <div className="flex h-full items-end gap-[3px]" aria-label="Incoming frequency spectrum" role="img">
      {values.map((value, index) => (
        <span
          key={index}
          className="spectrum-bar flex-1 rounded-t-[2px]"
          style={{ height: `${Math.max(7, value * 100)}%`, opacity: active ? 0.45 + value * 0.55 : 0.16 }}
        />
      ))}
    </div>
  );
}

function SegmentedToggle<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-white/[0.08] bg-black/20 p-1">
      {options.map(option => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-[9px] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition ${value === option.value ? "bg-white text-[#111817] shadow-sm" : "text-white/45 hover:text-white/75"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DeviceSelect({ value, devices, onChange, icon: Icon, disabled = false }: { value: string; devices: { deviceId: string; label: string }[]; onChange: (id: string) => void; icon: typeof Mic; disabled?: boolean }) {
  return (
    <label className={`device-select ${disabled ? "opacity-55" : ""}`}>
      <Icon size={15} strokeWidth={1.8} />
      <select value={value} onChange={event => onChange(event.target.value)} disabled={disabled} aria-label="Select audio device">
        {devices.length === 0 ? <option value="">No device detected</option> : devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
      </select>
      <ChevronDown size={13} className="pointer-events-none shrink-0 opacity-50" />
    </label>
  );
}

export default function Home() {
  const [message, setMessage] = useState("Meet on sonic channel 7");
  const [band, setBand] = useState<SonicBand>("audible");
  const [profile, setProfile] = useState<SonicProfile>("balanced");
  const [volume, setVolume] = useState(0.68);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [lastDecoded, setLastDecoded] = useState<ReceivedSonicMessage | null>(null);
  const [isSending, setIsSending] = useState(false);
  const voiceReadout = trpc.voice.read.useMutation();
  const { isAuthenticated } = useAuth();
  const settings = useMemo<SonicSettings>(() => ({ band, profile, volume }), [band, profile, volume]);
  const estimate = useMemo(() => estimateTransmission(message, settings), [message, settings]);

  const handleReceived = useCallback((received: ReceivedSonicMessage) => {
    setLastDecoded(received);
    setHistory(current => [{ id: `${received.receivedAt}-${received.sequence}`, kind: "received" as const, message: received.text, createdAt: received.receivedAt, quality: received.quality, sequence: received.sequence }, ...current].slice(0, 10));
    toast.success("Message detected", { description: `Decoded at ${received.quality}% signal confidence.` });
    if (voiceEnabled && isAuthenticated) {
      void voiceReadout.mutateAsync({ text: received.text })
        .then(({ audioDataUrl }) => new Audio(audioDataUrl).play())
        .catch(() => toast.error("Voice readout could not be generated."));
    }
  }, [voiceEnabled, voiceReadout]);

  const audio = useSonicAudio(settings, handleReceived);
  const receiverCue = audio.receiverState === "decoding"
    ? { label: "Frame locked", copy: `Reading payload · ${Math.round(audio.receiverFrameProgress * 100)}% complete` }
    : audio.receiverState === "syncing"
      ? { label: "Sync candidate", copy: "Refining a repeated preamble and sync chord…" }
      : audio.listening
        ? { label: "Scanning", copy: "Listening for the sender’s sync chord. Keep both sides on the same band and profile." }
        : { label: "Receiver idle", copy: "Arm the microphone, then place the sender within clear speaker range." };

  const send = async () => {
    if (!message.trim()) {
      toast.error("Add a short message first.");
      return;
    }
    setIsSending(true);
    try {
      const transmission = await audio.transmit(message.trim());
      setHistory(current => [{ id: `${Date.now()}-${transmission.sequence}`, kind: "sent" as const, message: message.trim(), createdAt: Date.now(), quality: 100, durationMs: transmission.durationMs, sequence: transmission.sequence }, ...current].slice(0, 10));
      toast.success("Sonic frame transmitted", { description: `${transmission.packetBytes} bytes · ${transmission.durationMs} ms modulation.` });
      window.setTimeout(() => setIsSending(false), transmission.durationMs + 260);
    } catch {
      setIsSending(false);
    }
  };

  const copyMessage = async () => {
    if (!lastDecoded) return;
    await navigator.clipboard.writeText(lastDecoded.text);
    toast.success("Decoded message copied.");
  };

  const speedValue = profile === "robust" ? 0 : profile === "balanced" ? 50 : 100;
  const setSpeed = (next: number) => setProfile(next < 30 ? "robust" : next > 70 ? "turbo" : "balanced");

  return (
    <div className="min-h-screen overflow-hidden bg-[#07110f] text-[#f6fff9]">
      <div className="noise-layer" />
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <main className="relative mx-auto flex min-h-screen max-w-[1540px] flex-col px-4 pb-8 pt-5 sm:px-6 lg:px-10 lg:pb-10">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
          <div className="flex items-center gap-3.5">
            <div className="brand-mark"><Waves size={22} /></div>
            <div>
              <div className="flex items-baseline gap-2"><h1 className="font-display text-lg font-extrabold tracking-[-0.04em]">Sonic Morse</h1><span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#89f2be]">fsk / 01</span></div>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.15em] text-white/38">High-speed acoustic link</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-[10px] font-semibold tracking-wide text-white/48 sm:flex"><Sparkles size={13} className="text-[#e6d581]" /> Custom 4-tone FSK</div>
            <div className={`rounded-full border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.13em] ${audio.listening ? "border-[#89f2be]/30 bg-[#89f2be]/10 text-[#89f2be]" : "border-white/[0.09] bg-white/[0.035] text-white/45"}`}><span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${audio.listening ? "live-dot bg-[#89f2be]" : "bg-white/25"}`} />{audio.listening ? "Listening" : "Standby"}</div>
          </div>
        </header>

        <section className="grid flex-1 gap-4 py-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_295px]">
          <div className="glass-panel sender-panel min-h-[480px] p-5 sm:p-6">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <div className="eyebrow"><Send size={12} /> Sender</div>
                <h2 className="panel-title">Compose a sonic frame</h2>
                <p className="panel-copy">Short packets, four simultaneous tones, locally rendered.</p>
              </div>
              <div className="protocol-chip"><Activity size={13} /> {sonicProfiles[profile].rate}</div>
            </div>

            <div className="message-box">
              <label htmlFor="sonic-message" className="sr-only">Message to transmit</label>
              <textarea id="sonic-message" value={message} onChange={event => setMessage(event.target.value)} maxLength={48} spellCheck={false} placeholder="Write a short message…" />
              <div className="message-meta"><span>{new TextEncoder().encode(message).byteLength}/48 bytes</span><span>{estimate.packetBytes ? `${estimate.packetBytes} byte frame` : "Waiting for data"}</span></div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
              <button onClick={send} disabled={isSending || !message.trim()} className="transmit-button"><span className="transmit-icon"><Send size={17} /></span><span>{isSending ? "Transmitting…" : "Encode & transmit"}</span><span className="ml-auto rounded-md bg-black/15 px-2 py-1 font-mono text-[10px] font-medium">{estimate.durationMs ? `${estimate.durationMs} ms` : "—"}</span></button>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-black/15 px-4 py-3 sm:min-w-[160px] sm:block"><span className="text-[9px] font-bold uppercase tracking-[0.15em] text-white/37">Frame profile</span><p className="mt-1 font-mono text-xs font-semibold text-white/80">{estimate.symbols || "—"} symbols</p></div>
            </div>

            <div className="visualizer-card mt-6">
              <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><span className="signal-point signal-green" /><span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/52">Outgoing waveform</span></div><span className="font-mono text-[10px] text-[#89f2be]/70">{band === "audible" ? "1.7—6.8 kHz" : "14.5—19.8 kHz"}</span></div>
              <div className="h-[115px]"><Oscilloscope data={audio.outputWaveform} /></div>
              <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3"><span className="font-mono text-[10px] text-white/34">SYN → {profile.toUpperCase()} → CRC+2P</span><span className="text-[10px] font-semibold text-white/46">{isSending ? "WAVE EMITTING" : "READY TO EMIT"}</span></div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-[11px] text-white/46"><span className="inline-flex items-center gap-2"><Check size={13} className="text-[#89f2be]" />CRC-8 checked</span><span className="inline-flex items-center gap-2"><Check size={13} className="text-[#89f2be]" />Dual parity</span><span className="inline-flex items-center gap-2"><Check size={13} className="text-[#89f2be]" />{estimate.durationMs < 1000 && estimate.durationMs > 0 ? "Sub-second target" : "Short packets only"}</span></div>
          </div>

          <div className="glass-panel receiver-panel min-h-[480px] p-5 sm:p-6">
            <div className="mb-7 flex items-start justify-between gap-4">
              <div>
                <div className="eyebrow"><Ear size={13} /> Receiver</div>
                <h2 className="panel-title">Listen for a frame</h2>
                <p className="panel-copy">Adaptive carrier lock with timing refinement and live confidence.</p>
              </div>
              <button onClick={() => audio.listening ? audio.stopListening() : void audio.startListening(audio.selectedInputId)} className={`listen-button ${audio.listening ? "is-live" : ""}`}><span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-current/10">{audio.listening ? <MicOff size={14} /> : <Mic size={14} />}</span><span>{audio.listening ? "Stop" : "Start"}</span></button>
            </div>

            <div className="receiver-stage">
              <div className="stage-topline"><div className="flex items-center gap-2"><span className={`signal-point ${audio.listening ? "signal-mint" : "signal-idle"}`} /><span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/52">Input oscillator</span></div><span className="font-mono text-[10px] text-white/40">{Math.round(audio.receiverConfidence * 100)}% lock</span></div>
              <div className="h-[95px]"><Oscilloscope data={audio.inputWaveform} color="#73D6FF" dimmed={!audio.listening} /></div>
              <div className="mt-2 flex h-[53px] items-end"><Spectrum values={audio.inputSpectrum} active={audio.listening} /></div>
              <div className="receiver-probe" aria-label={`Receiver status: ${receiverCue.label}`}><span className={audio.receiverState !== "idle" ? "active" : ""}>01 SCAN</span><i /><span className={audio.receiverState === "syncing" || audio.receiverState === "decoding" ? "active" : ""}>02 SYNC</span><i /><span className={audio.receiverState === "decoding" ? "active" : ""}>03 FRAME</span></div>
            </div>

            <div className="decoded-card mt-5">
              <div className="flex items-center justify-between gap-4"><span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/43">Decoded payload</span>{lastDecoded && <button onClick={copyMessage} className="copy-button"><Copy size={12} />Copy</button>}</div>
              {lastDecoded ? <div className="decoded-message"><p>{lastDecoded.text}</p><div><span>SEQ {String(lastDecoded.sequence).padStart(3, "0")}</span><span>QUALITY {lastDecoded.quality}%</span><span>{formatTime(lastDecoded.receivedAt)}</span></div></div> : <div className="empty-decode"><Radio size={22} /><strong>{receiverCue.label}</strong><p>{receiverCue.copy}</p></div>}
            </div>

            <div className="mt-5 flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5"><div className="level-meter"><span style={{ height: `${Math.max(6, audio.inputLevel * 100)}%` }} /></div><div className="min-w-0 flex-1"><p className="text-[11px] font-semibold text-white/68">Signal diagnostics</p><p className="mt-0.5 text-[10px] text-white/36">{audio.listening ? `${receiverCue.label} · noise floor ${Math.round(audio.receiverNoiseFloor * 1000) / 1000}` : "Waiting for microphone permission"}</p></div><span className={`text-[10px] font-bold ${audio.receiverConfidence > 0.58 ? "text-[#89f2be]" : audio.inputLevel > 0.65 ? "text-[#e6d581]" : "text-[#73d6ff]"}`}>{audio.receiverConfidence > 0.58 ? "LOCK" : audio.inputLevel > 0.65 ? "HIGH" : "CLEAR"}</span></div>
          </div>

          <aside className="flex flex-col gap-4">
            <div className="settings-card p-5">
              <div className="mb-5 flex items-center justify-between"><div className="eyebrow"><Settings2 size={13} /> Link settings</div><button onClick={() => void audio.refreshDevices()} className="icon-button" aria-label="Refresh audio devices"><RefreshCw size={13} /></button></div>

              <div className="settings-group"><label>Frequency band</label><SegmentedToggle value={band} options={[{ value: "audible", label: "Audible" }, { value: "ultrasonic", label: "Near-US" }]} onChange={setBand} /><p>{band === "audible" ? "Clear, compatible 1.7–6.8 kHz." : "Quieter 14.5–19.8 kHz; test your hardware."} Match this setting on the sender.</p></div>
              <div className="settings-group"><label className="flex justify-between"><span>Speed / robustness</span><strong>{sonicProfiles[profile].label}</strong></label><input type="range" min="0" max="100" value={speedValue} onChange={event => setSpeed(Number(event.target.value))} className="sonic-range" /><div className="range-labels"><span>Robust</span><span>Turbo</span></div><p>Match this profile on both devices. Start with Robust for longer rooms or phone speakers.</p></div>
              <div className="settings-group"><label className="flex justify-between"><span>Output volume</span><strong>{Math.round(volume * 100)}%</strong></label><input type="range" min="0.1" max="1" step="0.05" value={volume} onChange={event => setVolume(Number(event.target.value))} className="sonic-range volume-range" /></div>
              <div className="settings-group"><label>Microphone</label><DeviceSelect value={audio.selectedInputId} devices={audio.inputDevices} onChange={id => void audio.selectInput(id)} icon={Mic} /><button onClick={() => void audio.startListening(audio.selectedInputId)} className="permission-button"><Mic size={13} />{audio.permission === "granted" ? "Refresh microphone" : "Allow microphone"}</button></div>
              <div className="settings-group"><label>Speaker</label><DeviceSelect value={audio.selectedOutputId} devices={audio.outputDevices} onChange={id => void audio.selectOutput(id)} icon={Volume2} disabled={!audio.outputDeviceSupported} /><p>{audio.outputDeviceSupported ? "Output routing is supported in this browser." : "Browser uses the system default speaker."}</p></div>
              <button onClick={() => { if (!isAuthenticated) { toast.info("Sign in to enable ElevenLabs readout."); startLogin(); return; } setVoiceEnabled(value => !value); }} className={`voice-row ${voiceEnabled ? "voice-on" : ""}`} aria-pressed={voiceEnabled}><span className="voice-icon"><AudioLines size={15} /></span><span className="min-w-0 flex-1 text-left"><b>AI voice readout</b><small>{voiceReadout.isPending ? "Generating readout…" : isAuthenticated ? "ElevenLabs server-side TTS" : "Sign in required for secure TTS"}</small></span><span className={`toggle ${voiceEnabled ? "active" : ""}`}><i /></span></button>
            </div>

            {audio.lastError && <div className="error-card"><CircleAlert size={16} /><p>{audio.lastError}</p></div>}

            <div className="history-card flex min-h-[200px] flex-1 flex-col p-5"><div className="mb-4 flex items-center justify-between"><div className="eyebrow"><History size={13} /> Activity</div><span className="rounded-md bg-white/[0.05] px-1.5 py-1 font-mono text-[9px] text-white/38" aria-label={`${history.length} frame${history.length === 1 ? "" : "s"} in activity history`}>{history.length}</span></div>{history.length === 0 ? <div className="m-auto text-center"><div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03]"><Gauge size={17} className="text-white/36" /></div><p className="text-[11px] text-white/38">Frames will appear here.</p></div> : <ul className="history-list" role="log" aria-live="polite" aria-label="Transmission activity">{history.map(item => <li key={item.id} className="history-row"><span className={`history-kind ${item.kind}`} aria-hidden="true">{item.kind === "sent" ? <Send size={11} /> : <Ear size={11} />}</span><div className="min-w-0 flex-1"><p title={item.message}>{item.message}</p><div className="history-meta"><span>{formatTime(item.createdAt)}</span><span className={`history-badge ${item.kind}`}>{item.kind === "sent" ? `Sent · ${item.durationMs} ms` : `Received · ${item.quality}% quality`}</span></div><span className="sr-only">{item.kind === "sent" ? `Sent message in ${item.durationMs} milliseconds at ${formatTime(item.createdAt)}` : `Received message with ${item.quality} percent signal quality at ${formatTime(item.createdAt)}`}</span></div></li>)}</ul>}</div>
          </aside>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-5 text-[10px] font-medium uppercase tracking-[0.13em] text-white/28"><p>Custom multi-tone FSK · Local DSP · Short frames only</p><p className="font-mono normal-case tracking-normal">Receiver status: {audio.permission === "granted" ? "microphone permitted" : audio.permission === "denied" ? "permission needed" : "not armed"}</p></footer>
      </main>
    </div>
  );
}
