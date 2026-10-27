import { useSyncExternalStore } from "react";

/**
 * Small synthesized sound kit (no audio files). Off by default; the choice is remembered
 * per browser. Every sound is short and quiet so it never gets in the way of play.
 */
export type SoundName = "deal" | "chip" | "check" | "turn" | "win" | "fold" | "chat";

const KEY = "rr:sound";
let enabled = read();
const listeners = new Set<() => void>();
let ctx: AudioContext | null = null;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: keep the in-memory choice */
  }
  if (on) audio()?.resume().catch(() => {});
  listeners.forEach((l) => l());
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled,
  );
}

function audio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  return ctx;
}

function tone(c: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

function noise(c: AudioContext, start: number, dur: number, gain: number, freq: number) {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(c.destination);
  src.start(start);
}

export function play(name: SoundName) {
  if (!enabled) return;
  const c = audio();
  if (!c || c.state === "suspended") return;
  const t = c.currentTime + 0.005;
  switch (name) {
    case "deal":
      noise(c, t, 0.05, 0.35, 3200);
      break;
    case "chip":
      noise(c, t, 0.03, 0.5, 5200);
      noise(c, t + 0.045, 0.03, 0.35, 4600);
      break;
    case "check":
      noise(c, t, 0.04, 0.6, 900);
      noise(c, t + 0.09, 0.04, 0.45, 900);
      break;
    case "fold":
      noise(c, t, 0.08, 0.2, 1800);
      break;
    case "turn":
      tone(c, 660, t, 0.18, 0.06, "triangle");
      tone(c, 880, t + 0.12, 0.25, 0.06, "triangle");
      break;
    case "win":
      [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.08, 0.3, 0.05, "triangle"));
      break;
    case "chat":
      tone(c, 1200, t, 0.08, 0.025);
      break;
  }
}
