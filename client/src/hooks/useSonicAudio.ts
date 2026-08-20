import { useCallback, useEffect, useRef, useState } from "react";
import { downsampleWaveform, encodeTransmission, SonicSettings } from "@/lib/sonicCodec";
import { ReceivedSonicMessage, ReceiverDiagnostics, ReceiverState, SonicReceiver } from "@/lib/sonicReceiver";

type AudioDevice = { deviceId: string; label: string };
type PermissionState = "idle" | "requesting" | "granted" | "denied" | "unsupported" | "error";

export type SonicAudioState = {
  permission: PermissionState;
  listening: boolean;
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
  selectedInputId: string;
  selectedOutputId: string;
  inputLevel: number;
  inputWaveform: number[];
  inputSpectrum: number[];
  outputWaveform: number[];
  receiverState: ReceiverState;
  receiverConfidence: number;
  receiverNoiseFloor: number;
  receiverFrameProgress: number;
  lastError: string | null;
  outputDeviceSupported: boolean;
};

function toWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    Array.from(value).forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  return new Blob([buffer], { type: "audio/wav" });
}

function listDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string) {
  return devices
    .filter(device => device.kind === kind)
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `${fallback} ${index + 1}` }));
}

export function useSonicAudio(settings: SonicSettings, onMessage: (message: ReceivedSonicMessage) => void) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mutedGainRef = useRef<GainNode | null>(null);
  const receiverRef = useRef<SonicReceiver | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const latestSettings = useRef(settings);
  const messageHandler = useRef(onMessage);
  const [state, setState] = useState<SonicAudioState>({
    permission: typeof navigator === "undefined" || !navigator.mediaDevices ? "unsupported" : "idle",
    listening: false,
    inputDevices: [],
    outputDevices: [],
    selectedInputId: "",
    selectedOutputId: "",
    inputLevel: 0,
    inputWaveform: Array.from({ length: 96 }, () => 0),
    inputSpectrum: Array.from({ length: 32 }, () => 0),
    outputWaveform: Array.from({ length: 108 }, () => 0),
    receiverState: "idle",
    receiverConfidence: 0,
    receiverNoiseFloor: 0,
    receiverFrameProgress: 0,
    lastError: null,
    outputDeviceSupported: typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
  });

  useEffect(() => {
    latestSettings.current = settings;
    receiverRef.current?.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    messageHandler.current = onMessage;
  }, [onMessage]);

  const ensureAudioElement = useCallback(() => {
    if (!audioRef.current) {
      const element = new Audio();
      element.preload = "auto";
      audioRef.current = element;
    }
    return audioRef.current;
  }, []);

  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputDevices = listDevices(devices, "audioinput", "Microphone");
    const outputDevices = listDevices(devices, "audiooutput", "Speaker");
    setState(current => ({
      ...current,
      inputDevices,
      outputDevices,
      selectedInputId: current.selectedInputId || inputDevices[0]?.deviceId || "",
      selectedOutputId: current.selectedOutputId || outputDevices[0]?.deviceId || "",
    }));
  }, []);

  const stopListening = useCallback(() => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    processorRef.current?.disconnect();
    mutedGainRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach(track => track.stop());
    processorRef.current = null;
    mutedGainRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    receiverRef.current = null;
    setState(current => ({ ...current, listening: false, inputLevel: 0, receiverState: "idle", receiverConfidence: 0, receiverFrameProgress: 0 }));
  }, []);

  const beginAnimation = useCallback(() => {
    const tick = () => {
      const analyser = analyserRef.current;
      if (!analyser) return;
      const timeDomain = new Uint8Array(analyser.fftSize);
      const frequency = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(timeDomain);
      analyser.getByteFrequencyData(frequency);
      const wave = Array.from({ length: 96 }, (_, index) => (timeDomain[Math.floor((index / 96) * timeDomain.length)] - 128) / 128);
      const bands = Array.from({ length: 32 }, (_, index) => {
        const start = Math.floor((index / 32) * frequency.length);
        const end = Math.max(start + 1, Math.floor(((index + 1) / 32) * frequency.length));
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += frequency[i];
        return sum / Math.max(1, end - start) / 255;
      });
      const rms = Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length);
      setState(current => ({ ...current, inputWaveform: wave, inputSpectrum: bands, inputLevel: Math.min(1, rms * 3.6) }));
      animationFrameRef.current = requestAnimationFrame(tick);
    };
    animationFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const startListening = useCallback(async (preferredDeviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState(current => ({ ...current, permission: "unsupported", lastError: "This browser does not support microphone capture." }));
      return false;
    }

    stopListening();
    setState(current => ({ ...current, permission: "requesting", lastError: null }));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: preferredDeviceId ? { exact: preferredDeviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = audioContextRef.current ?? new AudioContextClass({ latencyHint: "interactive" });
      audioContextRef.current = context;
      if (context.state === "suspended") await context.resume();

      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.56;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(1024, 1, 1);
      const mutedGain = context.createGain();
      mutedGain.gain.value = 0;
      const receiver = new SonicReceiver(
        context.sampleRate,
        latestSettings.current,
        message => messageHandler.current(message),
        (diagnostics: ReceiverDiagnostics) => {
          setState(current => ({
            ...current,
            receiverState: diagnostics.state,
            receiverConfidence: diagnostics.confidence,
            receiverNoiseFloor: diagnostics.noiseFloor,
            receiverFrameProgress: diagnostics.frameProgress,
          }));
        },
      );

      source.connect(analyser);
      source.connect(processor);
      processor.connect(mutedGain);
      mutedGain.connect(context.destination);
      processor.onaudioprocess = event => receiver.push(new Float32Array(event.inputBuffer.getChannelData(0)));

      streamRef.current = stream;
      sourceRef.current = source;
      analyserRef.current = analyser;
      processorRef.current = processor;
      mutedGainRef.current = mutedGain;
      receiverRef.current = receiver;
      setState(current => ({ ...current, permission: "granted", listening: true, lastError: null, selectedInputId: stream.getAudioTracks()[0]?.getSettings().deviceId || preferredDeviceId || current.selectedInputId }));
      await enumerateDevices();
      beginAnimation();
      return true;
    } catch (error) {
      const message = error instanceof DOMException && error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser settings, then try again." : "The microphone could not be started. Check the selected input device and try again.";
      setState(current => ({ ...current, permission: message.includes("denied") ? "denied" : "error", listening: false, lastError: message }));
      return false;
    }
  }, [beginAnimation, enumerateDevices, stopListening]);

  const selectInput = useCallback(async (deviceId: string) => {
    setState(current => ({ ...current, selectedInputId: deviceId }));
    if (state.listening) await startListening(deviceId);
  }, [startListening, state.listening]);

  const selectOutput = useCallback(async (deviceId: string) => {
    setState(current => ({ ...current, selectedOutputId: deviceId }));
    const element = ensureAudioElement() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (element.setSinkId) {
      try {
        await element.setSinkId(deviceId);
      } catch {
        setState(current => ({ ...current, lastError: "The selected speaker could not be activated. Your browser may require a secure device-selection permission." }));
      }
    }
  }, [ensureAudioElement]);

  const transmit = useCallback(async (text: string) => {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = audioContextRef.current ?? new AudioContextClass({ latencyHint: "interactive" });
      audioContextRef.current = context;
      if (context.state === "suspended") await context.resume();
      const transmission = encodeTransmission(text, latestSettings.current, context.sampleRate);
      setState(current => ({ ...current, outputWaveform: downsampleWaveform(transmission.samples), lastError: null }));
      const url = URL.createObjectURL(toWav(transmission.samples, context.sampleRate));
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      const element = ensureAudioElement() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (element.setSinkId && state.selectedOutputId) await element.setSinkId(state.selectedOutputId);
      element.src = url;
      await element.play();
      return transmission;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The waveform could not be transmitted.";
      setState(current => ({ ...current, lastError: message }));
      throw error;
    }
  }, [ensureAudioElement, state.selectedOutputId]);

  useEffect(() => {
    void enumerateDevices();
    const handleDeviceChange = () => void enumerateDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
      stopListening();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      void audioContextRef.current?.close();
    };
  }, [enumerateDevices, stopListening]);

  return { ...state, startListening, stopListening, selectInput, selectOutput, transmit, refreshDevices: enumerateDevices };
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
