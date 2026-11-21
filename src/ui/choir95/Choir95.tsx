/**
 * Choir 95: a Windows 95 choir keyboard. One key sings a chord on up to four Chimera voices
 * (bass, tenor, alto, soprano). Lyrics advance one syllable per press, as in Sing mode.
 * Record stores the notes and the mixed audio; Play sings the notes again; Export WAV saves the mix.
 */
import { useEffect, useRef, useState } from "react";
import { g2p } from "../speech.ts";
import { lyricsToSyllables } from "../../wasm/engine.ts";
import type { Syllable } from "../../wasm/types.ts";
import { connectMidi, disconnectMidi, midiSupported } from "../midi.ts";
import { ChoirEngine, type RecordedAudio } from "./choirEngine.ts";
import {
  AH, assignVoices, CHORD_LABEL, CHORDS, chordNotes, isBlackKey, KEY_LETTERS, KEYMAP, midiName, octaveBase, parentSyllable, VOICE_NAMES,
  type ChordKind,
} from "./chords.ts";
import { encodeWav } from "./wav.ts";
import "./choir95.css";

const DEFAULT_LYRICS = "hallelujah";

interface TakeEvent {
  t: number;
  kind: "on" | "off";
  /** the key that was pressed; null on note-off */
  root: number | null;
  notes: (number | null)[];
  syl: Syllable;
  parent: Syllable;
  velocity: number;
  skipCoda?: boolean;
}

interface Take extends RecordedAudio {
  events: TakeEvent[];
}

interface Model {
  chord: ChordKind;
  syllables: Syllable[];
  cursor: number;
  octave: number;
}

interface Live {
  notes: (number | null)[];
  syl: Syllable;
  parent: Syllable;
  velocity: number;
  skipCoda: boolean;
}

type MenuId = "file" | "help" | "start" | null;
type MidiState = "off" | "connecting" | "on" | "denied";

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const scopeBuf = new Uint8Array(2048);

function paintWave(
  canvas: HTMLCanvasElement,
  mode: "idle" | "scope" | "peaks" | "take",
  pcm: Float32Array | null,
  peaks: readonly number[],
  analyser: AnalyserNode | null,
  playhead: number | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 64;
  const W = Math.max(1, Math.floor(w * dpr));
  const H = Math.max(1, Math.floor(h * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.strokeStyle = "#00ff00";
  ctx.lineWidth = 1;
  if (mode === "take" && pcm && pcm.length) {
    const step = Math.max(1, Math.floor(pcm.length / w));
    for (let x = 0; x < w; x++) {
      let min = 1;
      let max = -1;
      const i0 = Math.min(pcm.length - 1, Math.floor((x / w) * pcm.length));
      const i1 = Math.min(pcm.length, i0 + step);
      for (let i = i0; i < i1; i++) {
        const s = pcm[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      ctx.moveTo(x + 0.5, (1 - max) * 0.5 * h);
      ctx.lineTo(x + 0.5, Math.max((1 - max) * 0.5 * h + 1, (1 - min) * 0.5 * h));
    }
  } else if (mode === "peaks" && peaks.length) {
    for (let x = 0; x < w; x++) {
      const p = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))];
      ctx.moveTo(x + 0.5, h / 2 - p * (h / 2 - 1));
      ctx.lineTo(x + 0.5, h / 2 + p * (h / 2 - 1));
    }
  } else if (mode === "scope" && analyser) {
    const buf = analyser.fftSize === scopeBuf.length ? scopeBuf : new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    for (let x = 0; x < w; x++) {
      const s = (buf[Math.floor((x / w) * buf.length)] - 128) / 128;
      const y = h / 2 - s * (h / 2 - 1);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
  }
  ctx.stroke();
  if (playhead !== null) {
    ctx.beginPath();
    ctx.strokeStyle = "#fff";
    ctx.moveTo(playhead * w + 0.5, 0);
    ctx.lineTo(playhead * w + 0.5, h);
    ctx.stroke();
  }
}

function Flag() {
  return (
    <span className="flag" aria-hidden="true">
      <i className="r" />
      <i className="g" />
      <i className="b" />
      <i className="y" />
    </span>
  );
}

function Piano({
  base,
  down,
  onDown,
}: {
  base: number;
  down: Set<number>;
  onDown: (midi: number, event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const notes = Array.from({ length: 25 }, (_, i) => base + i);
  const whites = notes.filter((m) => !isBlackKey(m));
  return (
    <div className="piano" data-layout="layered" aria-label="Piano. Computer keys A to semicolon play chords. Z and X change octave.">
      <div className="white-row">
        {whites.map((midi) => {
          const index = midi - base;
          const letter = index >= 0 && index < KEY_LETTERS.length ? KEY_LETTERS[index] : midi % 12 === 0 ? "C" : "";
          return (
            <button key={midi} type="button" className={down.has(midi) ? "key white down" : "key white"} aria-label={midiName(midi)} onPointerDown={(e) => onDown(midi, e)}>
              {letter ? <span className="cap">{letter}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="black-row">
        {whites.map((midi, i) => {
          const black = midi + 1;
          if (!isBlackKey(black) || i >= whites.length - 1) return null;
          const index = black - base;
          const letter = index >= 0 && index < KEY_LETTERS.length ? KEY_LETTERS[index] : "";
          return (
            <button
              key={black}
              type="button"
              className={down.has(black) ? "key black down" : "key black"}
              style={{ left: `calc(${((i + 1) / whites.length) * 100}% - 2%)` }}
              aria-label={midiName(black)}
              onPointerDown={(e) => onDown(black, e)}
            >
              {letter ? <span className="cap">{letter}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Choir95() {
  const engineRef = useRef<ChoirEngine | null>(null);
  const model = useRef<Model | null>(null);
  if (!model.current) model.current = { chord: "major", syllables: lyricsToSyllables(DEFAULT_LYRICS), cursor: 0, octave: 0 };
  const m = model.current;

  const [chord, setChord] = useState<ChordKind>(m.chord);
  const [lyrics, setLyrics] = useState(DEFAULT_LYRICS);
  const [syllables, setSyllables] = useState<Syllable[]>(m.syllables);
  const [cursor, setCursor] = useState(0);
  const [octave, setOctave] = useState(0);
  const [slots, setSlots] = useState<(number | null)[]>([null, null, null, null]);
  const [pressed, setPressed] = useState<number | null>(null);
  const [nowIndex, setNowIndex] = useState(-1);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [playing, setPlaying] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [midi, setMidi] = useState<MidiState>("off");
  const [midiNames, setMidiNames] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuId>(null);
  const [about, setAbout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lyricsRef = useRef(DEFAULT_LYRICS);
  const order = useRef<number[]>([]);
  const counts = useRef(new Map<number, number>());
  const sounding = useRef<number | null>(null);
  const live = useRef<Live>({ notes: [null, null, null, null], syl: AH, parent: AH, velocity: 96, skipCoda: false });
  const recordingRef = useRef(false);
  const playingRef = useRef(false);
  const stopping = useRef(false);
  const eventsRef = useRef<TakeEvent[]>([]);
  const recT0 = useRef(0);
  const takeRef = useRef<Take | null>(null);
  const timersRef = useRef<number[]>([]);
  const playT0 = useRef(0);
  const playDur = useRef(0);
  const pointers = useRef(new Map<number, number>());
  const midiOn = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopRecordRef = useRef<() => Promise<void>>(async () => {});
  const api = useRef({
    press: (_root: number, _velocity: number) => {},
    lift: (_root: number) => {},
    octave: (_delta: number) => {},
    escape: () => {},
    blocked: (): boolean => false,
  });

  takeRef.current = take;

  function ensure(): ChoirEngine {
    if (!engineRef.current) {
      const eng = new ChoirEngine();
      eng.onLimit = () => void stopRecordRef.current();
      engineRef.current = eng;
    }
    return engineRef.current;
  }

  function stopPlayback() {
    playingRef.current = false;
    setPlaying(false);
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current = [];
    engineRef.current?.releaseAll(false);
    sounding.current = null;
    setSlots([null, null, null, null]);
    setPressed(null);
    setNowIndex(-1);
  }

  function applyChord(root: number, velocity: number, advance: boolean) {
    const eng = engineRef.current;
    const modelNow = model.current;
    if (!eng || !modelNow) return;
    const syls = modelNow.syllables.length ? modelNow.syllables : [AH];
    const i = ((modelNow.cursor % syls.length) + syls.length) % syls.length;
    const syl = syls[i];
    const parent = parentSyllable(syls, i);
    const notes = assignVoices(chordNotes(root, modelNow.chord));
    eng.sing(notes, syl, parent, velocity);
    sounding.current = root;
    const nextSyl = syls[(i + 1) % syls.length];
    live.current = { notes, syl, parent, velocity, skipCoda: !!nextSyl?.melisma };
    if (advance) {
      modelNow.cursor = (i + 1) % syls.length;
      setCursor(modelNow.cursor);
    }
    setSlots(notes);
    setPressed(root);
    setNowIndex(i);
    if (recordingRef.current) {
      eventsRef.current.push({
        t: Math.max(0, (eng.ctx?.currentTime ?? 0) - recT0.current),
        kind: "on",
        root,
        notes,
        syl,
        parent,
        velocity,
      });
    }
  }

  async function singRoot(root: number, velocity: number, advance: boolean) {
    if (playingRef.current) stopPlayback();
    const eng = ensure();
    try {
      await eng.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!order.current.includes(root) || order.current[order.current.length - 1] !== root) return;
    if (eng.error) {
      setError(eng.error);
      return;
    }
    setAudioOn(true);
    setError(null);
    applyChord(root, velocity, advance);
  }

  function press(root: number, velocity: number) {
    const n = (counts.current.get(root) ?? 0) + 1;
    counts.current.set(root, n);
    order.current = order.current.filter((note) => note !== root).concat(root);
    if (n !== 1) return;
    void singRoot(root, velocity, true);
  }

  function lift(root: number) {
    const n = (counts.current.get(root) ?? 1) - 1;
    if (n <= 0) counts.current.delete(root);
    else counts.current.set(root, n);
    if (n > 0) return;
    order.current = order.current.filter((note) => note !== root);
    if (sounding.current !== root) return;
    const back = order.current[order.current.length - 1];
    if (back !== undefined) {
      void singRoot(back, 90, false);
      return;
    }
    const eng = engineRef.current;
    const skip = live.current.skipCoda;
    if (recordingRef.current && eng) {
      eventsRef.current.push({
        t: Math.max(0, (eng.ctx?.currentTime ?? 0) - recT0.current),
        kind: "off",
        root: null,
        notes: live.current.notes,
        syl: live.current.syl,
        parent: live.current.parent,
        velocity: live.current.velocity,
        skipCoda: skip,
      });
    }
    eng?.releaseAll(skip);
    sounding.current = null;
    setSlots([null, null, null, null]);
    setPressed(null);
    setNowIndex(-1);
  }

  async function stopRecord() {
    if (!recordingRef.current || stopping.current) return;
    stopping.current = true;
    recordingRef.current = false;
    setRecording(false);
    const eng = engineRef.current;
    if (eng && sounding.current !== null) {
      eventsRef.current.push({
        t: Math.max(0, (eng.ctx?.currentTime ?? 0) - recT0.current),
        kind: "off",
        root: null,
        notes: live.current.notes,
        syl: live.current.syl,
        parent: live.current.parent,
        velocity: live.current.velocity,
        skipCoda: live.current.skipCoda,
      });
    }
    const audio = eng ? await eng.endRecord() : { pcm: new Float32Array(), sampleRate: 48000 };
    const next = { events: eventsRef.current.slice(), pcm: audio.pcm, sampleRate: audio.sampleRate };
    takeRef.current = next;
    setTake(next);
    setRecSeconds(audio.pcm.length / audio.sampleRate);
    stopping.current = false;
  }
  stopRecordRef.current = stopRecord;

  async function onRecord() {
    if (recordingRef.current) {
      await stopRecord();
      return;
    }
    if (playingRef.current) stopPlayback();
    const eng = ensure();
    try {
      await eng.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setAudioOn(true);
    eventsRef.current = [];
    recT0.current = eng.ctx?.currentTime ?? 0;
    if (sounding.current !== null) {
      eventsRef.current.push({ t: 0, kind: "on", root: sounding.current, notes: live.current.notes, syl: live.current.syl, parent: live.current.parent, velocity: live.current.velocity });
    }
    eng.beginRecord();
    recordingRef.current = true;
    setRecording(true);
    setRecSeconds(0);
    setTake(null);
    takeRef.current = null;
  }

  async function onPlay() {
    const current = takeRef.current;
    if (!current || !current.events.length || recordingRef.current) return;
    if (playingRef.current) {
      stopPlayback();
      return;
    }
    const eng = ensure();
    try {
      await eng.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setAudioOn(true);
    eng.releaseAll(false);
    sounding.current = null;
    order.current = [];
    counts.current.clear();
    playingRef.current = true;
    setPlaying(true);
    const ctx = eng.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.06;
    playT0.current = t0;
    const dur = current.pcm.length ? current.pcm.length / current.sampleRate : (current.events[current.events.length - 1]?.t ?? 0) + 0.4;
    playDur.current = Math.max(0.2, dur);
    const timers: number[] = [];
    for (const event of current.events) {
      const delay = Math.max(0, (t0 + event.t - ctx.currentTime) * 1000);
      timers.push(
        window.setTimeout(() => {
          if (!playingRef.current) return;
          if (event.kind === "on") {
            eng.sing(event.notes, event.syl, event.parent, event.velocity);
            setSlots([...event.notes]);
            setPressed(event.root);
          } else {
            eng.releaseAll(!!event.skipCoda);
            setSlots([null, null, null, null]);
            setPressed(null);
          }
        }, delay),
      );
    }
    timers.push(
      window.setTimeout(() => {
        if (playingRef.current) stopPlayback();
      }, Math.max(0, (t0 + playDur.current - ctx.currentTime) * 1000)),
    );
    timersRef.current = timers;
  }

  function onExport() {
    const current = takeRef.current;
    if (!current?.pcm.length) return;
    const bytes = encodeWav(current.pcm, current.sampleRate);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "choir95.wav";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function chooseChord(next: ChordKind) {
    const modelNow = model.current;
    if (!modelNow) return;
    modelNow.chord = next;
    setChord(next);
    // A note already singing follows the new chord. A note still waiting for the first
    // audio start reads `model.chord` when it begins, so it must not be started twice.
    if (sounding.current != null && !playingRef.current && engineRef.current?.ready) applyChord(sounding.current, live.current.velocity, false);
  }

  function shiftOctave(delta: number) {
    const modelNow = model.current;
    if (!modelNow) return;
    modelNow.octave = Math.max(-2, Math.min(2, modelNow.octave + delta));
    setOctave(modelNow.octave);
  }

  function panic() {
    if (playingRef.current) stopPlayback();
    if (recordingRef.current) void stopRecord();
    engineRef.current?.releaseAll(false);
    sounding.current = null;
    order.current = [];
    counts.current.clear();
    setSlots([null, null, null, null]);
    setPressed(null);
    setNowIndex(-1);
  }

  api.current.press = press;
  api.current.lift = lift;
  api.current.octave = shiftOctave;
  api.current.escape = () => {
    setMenu(null);
    setAbout(false);
  };
  api.current.blocked = () => about;

  useEffect(() => {
    const prev = document.title;
    document.title = "Choir 95";
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    let liveLoad = true;
    g2p
      .load()
      .then(() => {
        if (!liveLoad || !model.current) return;
        const syls = lyricsToSyllables(lyricsRef.current);
        model.current.syllables = syls;
        model.current.cursor = Math.min(model.current.cursor, Math.max(0, syls.length - 1));
        setSyllables(syls);
        setCursor(model.current.cursor);
      })
      .catch(() => {});
    return () => {
      liveLoad = false;
    };
  }, []);

  useEffect(() => {
    const down = new Map<string, number>();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === "Escape") {
        api.current.escape();
        return;
      }
      if (api.current.blocked()) return;
      if (key === "z" || key === "x") {
        api.current.octave(key === "x" ? 1 : -1);
        e.preventDefault();
        return;
      }
      if (!(key in KEYMAP) || down.has(key)) return;
      const midi = octaveBase(model.current?.octave ?? 0) + KEYMAP[key];
      down.set(key, midi);
      api.current.press(midi, 96);
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const midi = down.get(key);
      if (midi === undefined) return;
      down.delete(key);
      api.current.lift(midi);
    };
    const onPointerUp = (e: PointerEvent) => {
      const midi = pointers.current.get(e.pointerId);
      if (midi === undefined) return;
      pointers.current.delete(e.pointerId);
      api.current.lift(midi);
    };
    const onBlur = () => {
      for (const midi of down.values()) api.current.lift(midi);
      down.clear();
      for (const midi of pointers.current.values()) api.current.lift(midi);
      pointers.current.clear();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest(".menu-pop, .menu-title, .start, .start-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setRecSeconds(engineRef.current?.capturedSeconds() ?? 0), 200);
    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const canvas = canvasRef.current;
      const eng = engineRef.current;
      if (canvas) {
        const current = takeRef.current;
        const mode = recordingRef.current ? "peaks" : current && (playingRef.current || !audioOn || current.pcm.length) ? "take" : eng?.analyser && audioOn ? "scope" : "idle";
        let playhead: number | null = null;
        if (playingRef.current && playDur.current > 0 && eng?.ctx) {
          playhead = Math.min(1, Math.max(0, (eng.ctx.currentTime - playT0.current) / playDur.current));
        }
        const showTake = mode === "take";
        paintWave(canvas, showTake ? "take" : mode, showTake ? current?.pcm ?? null : null, eng?.peaks ?? [], eng?.analyser ?? null, playhead);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [audioOn]);

  useEffect(() => {
    return () => {
      for (const id of timersRef.current) clearTimeout(id);
      engineRef.current?.dispose();
      engineRef.current = null;
      if (midiOn.current) disconnectMidi();
    };
  }, []);

  async function toggleMidi() {
    if (midi === "on" || midi === "connecting") {
      disconnectMidi();
      midiOn.current = false;
      setMidi("off");
      setMidiNames([]);
      return;
    }
    if (!midiSupported()) {
      setMidi("denied");
      return;
    }
    setMidi("connecting");
    try {
      await connectMidi({
        noteOn: (note, velocity) => api.current.press(note, velocity),
        noteOff: (note) => api.current.lift(note),
        inputs: (names) => setMidiNames(names),
      });
      midiOn.current = true;
      setMidi("on");
    } catch {
      setMidi("denied");
    }
  }

  const base = octaveBase(octave);
  const down = new Set<number>();
  for (const note of slots) if (note != null) down.add(note);
  if (pressed != null) down.add(pressed);
  const sung = nowIndex >= 0 ? syllables[nowIndex]?.text ?? AH.text : "";
  const voiceLine = slots
    .map((note, i) => (note == null ? null : `${VOICE_NAMES[i]} ${midiName(note)}`))
    .filter((part): part is string => !!part)
    .join(", ");
  let status = "Ready — click a key, or press A";
  if (error) status = error;
  else if (recording) status = `Recording ${fmt(recSeconds)}`;
  else if (playing) status = "Playing";
  else if (pressed != null) status = `${midiName(pressed)} ${CHORD_LABEL[chord]} · “${sung || AH.text}”${voiceLine ? ` — ${voiceLine}` : ""}`;
  const midiLabel = midi === "on" ? (midiNames.length ? midiNames.join(", ") : "Plug one in") : midi === "connecting" ? "Connecting…" : midi === "denied" ? "Blocked" : "Off";
  const canExport = !!take && take.pcm.length > 0;
  const canPlay = !!take && take.events.length > 0 && !recording;

  return (
    <div className="choir95">
      <div className="desk">
        <div className="win" role="region" aria-label="Choir 95">
          <div className="titlebar">
            <h1>Choir 95 - Sound Recorder</h1>
            <a className="title-btn" href="/" aria-label="Close and return to Chimera">
              ×
            </a>
          </div>
          <div className="win-body">
            <div className="menubar">
              <div className="menu">
                <button type="button" className={menu === "file" ? "menu-title down" : "menu-title"} aria-expanded={menu === "file"} onClick={() => setMenu(menu === "file" ? null : "file")}>
                  File
                </button>
                {menu === "file" && (
                  <div className="menu-pop" role="menu">
                    <button type="button" role="menuitem" disabled={!canExport} onClick={() => { onExport(); setMenu(null); }}>
                      Export WAV…
                    </button>
                    <div className="menu-sep" />
                    <a role="menuitem" href="/">
                      Back to Chimera
                    </a>
                  </div>
                )}
              </div>
              <div className="menu">
                <button type="button" className={menu === "help" ? "menu-title down" : "menu-title"} aria-expanded={menu === "help"} onClick={() => setMenu(menu === "help" ? null : "help")}>
                  Help
                </button>
                {menu === "help" && (
                  <div className="menu-pop" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setAbout(true); setMenu(null); }}>
                      About Choir 95…
                    </button>
                  </div>
                )}
              </div>
            </div>

            <fieldset className="group">
              <legend>Chord</legend>
              <div className="row chord-row" role="radiogroup" aria-label="Chord">
                {CHORDS.map((id) => (
                  <button key={id} type="button" role="radio" aria-checked={chord === id} className={chord === id ? "btn down" : "btn"} onClick={() => chooseChord(id)}>
                    {CHORD_LABEL[id]}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="group">
              <legend>Lyrics</legend>
              <textarea
                className="lyric-input"
                aria-label="Lyrics to sing"
                spellCheck={false}
                rows={2}
                value={lyrics}
                placeholder="ah, oo, hallelujah"
                onChange={(e) => {
                  const text = e.target.value;
                  lyricsRef.current = text;
                  const syls = lyricsToSyllables(text);
                  if (model.current) {
                    model.current.syllables = syls;
                    model.current.cursor = 0;
                  }
                  setLyrics(text);
                  setSyllables(syls);
                  setCursor(0);
                }}
              />
              <div className="syllables" role="group" aria-label="Syllables. The marked one is sung next.">
                {syllables.map((syl, i) => (
                  <button
                    key={`${syl.text}-${i}`}
                    type="button"
                    className={`syl${i === nowIndex ? " now" : ""}${i === cursor && i !== nowIndex ? " next" : ""}`}
                    aria-current={i === cursor ? "step" : undefined}
                    onClick={() => {
                      if (model.current) model.current.cursor = i;
                      setCursor(i);
                    }}
                  >
                    {syl.text || "·"}
                  </button>
                ))}
                {!syllables.length && <span className="hint">No words: the keys sing “ah”.</span>}
              </div>
            </fieldset>

            <fieldset className="group">
              <legend>Keyboard</legend>
              <Piano
                base={base}
                down={down}
                onDown={(midi, event) => {
                  if (event.button !== 0) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pointers.current.set(event.pointerId, midi);
                  press(midi, 104);
                }}
              />
              <div className="voices">
                {VOICE_NAMES.map((name, i) => (
                  <span key={name} className={slots[i] != null ? "voice on" : "voice"}>
                    {name}
                    {slots[i] != null ? ` ${midiName(slots[i])}` : ""}
                  </span>
                ))}
              </div>
              <p className="hint">
                Keys A to ; play. Z and X change octave ({midiName(base)}–{midiName(base + 24)}). One key sings the whole chord, then the next syllable.
              </p>
              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className={midi === "on" ? "btn down" : "btn"} onClick={() => void toggleMidi()} aria-pressed={midi === "on"}>
                  MIDI: {midiLabel}
                </button>
              </div>
            </fieldset>

            <fieldset className="group">
              <legend>Sound Recorder</legend>
              <div className="transport">
                <button type="button" className={recording ? "btn down recording" : "btn"} aria-pressed={recording} onClick={() => void onRecord()}>
                  <span className="rec-dot" aria-hidden="true" />
                  Record
                </button>
                <button type="button" className="btn" onClick={panic}>
                  ■ Stop
                </button>
                <button type="button" className={playing ? "btn down" : "btn"} disabled={!canPlay} aria-pressed={playing} onClick={() => void onPlay()}>
                  ▶ Play
                </button>
                <button type="button" className="btn" disabled={!canExport} onClick={onExport}>
                  Export WAV
                </button>
              </div>
              <div className="wave-well">
                <canvas ref={canvasRef} className="waveform" aria-label="Waveform" />
              </div>
              <p className="hint">Record stores the notes and the sound. Play sings those notes again. Export WAV saves what was heard (up to one minute).</p>
            </fieldset>

            <div className="statusbar">
              <div className="status-cell grow" role="status">
                {status}
              </div>
              <div className="status-cell">{octave === 0 ? "Octave 0" : `Octave ${octave > 0 ? "+" : ""}${octave}`}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="taskbar">
        <button type="button" className={menu === "start" ? "start down" : "start"} aria-expanded={menu === "start"} onClick={() => setMenu(menu === "start" ? null : "start")}>
          <Flag />
          Start
        </button>
        <button type="button" className="task down" tabIndex={-1}>
          Choir 95
        </button>
        <div className="tray">
          <Clock />
        </div>
      </div>

      {menu === "start" && (
        <div className="start-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setAbout(true); setMenu(null); }}>
            About Choir 95…
          </button>
          <div className="menu-sep" />
          <a role="menuitem" href="/">
            Back to Chimera
          </a>
        </div>
      )}

      {about && (
        <div className="modal" onMouseDown={() => setAbout(false)}>
          <div className="win about" role="dialog" aria-labelledby="choir-about-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="titlebar">
              <h1 id="choir-about-title">About Choir 95</h1>
              <button type="button" className="title-btn" aria-label="Close" onClick={() => setAbout(false)}>
                ×
              </button>
            </div>
            <div className="win-body">
              <p>
                <b>Choir 95</b>
              </p>
              <p>One key sings a chord on several copies of the Chimera voice: bass, tenor, alto and soprano, each its own simulated airway.</p>
              <p>Choir 95 demo built on Chimera by jamesondh (MIT).</p>
              <p>Window chrome is hand-written CSS in the style of 98.css (MIT, Jordan Scales).</p>
              <div className="about-actions">
                <button type="button" className="btn" onClick={() => setAbout(false)}>
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span>{now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>;
}
