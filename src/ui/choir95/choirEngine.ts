/**
 * Four Chimera airways, one AudioWorklet each, mixed in the page. The engine is one voice;
 * a chord is several copies (bass, tenor, alto, soprano) planned with the same calls Sing mode
 * uses (`planNoteOn` / `planMelisma` / `planNoteOff`). A voice that the current chord does not
 * need is disconnected after its release, so a single note does not keep four simulations running.
 * Audio starts only when `start()` runs, from a gesture.
 */
import workletUrl from "../../worklet/processor.ts?worker&url";
import { chimeraModule } from "../../wasm/chimera.ts";
import { preferPlaybackSession } from "../../audio/session.ts";
import { EXHALE_LABEL, planMelisma, planNoteOff, planNoteOn } from "../../wasm/engine.ts";
import type { BodyMix, Gesture, Syllable } from "../../wasm/types.ts";
import type { ToWorklet } from "../../worklet/protocol.ts";

const BODIES: BodyMix[] = [
  { female: 0, child: 0 },
  { female: 0.28, child: 0 },
  { female: 1, child: 0 },
  { female: 0.15, child: 0.9 },
];

const VIBRATO = 22;
const LEAD = 0.006;

const breathFor = (velocity: number) => 0.62 + 0.4 * Math.min(1, Math.max(0, velocity / 96)) + 0.12 * Math.max(0, (velocity - 96) / 31);

const REC_SOURCE = `
class ChoirRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        if (this.n) {
          const out = this.buf.slice(0, this.n);
          this.n = 0;
          this.port.postMessage(out, [out.buffer]);
        }
        this.port.postMessage("flushed");
        return;
      }
      this.on = e.data === "on";
    };
  }
  process(inputs, outputs) {
    const ch = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (out) out.fill(0);
    if (!ch || !this.on) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        const ready = this.buf;
        this.buf = new Float32Array(2048);
        this.n = 0;
        this.port.postMessage(ready, [ready.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("choir-rec", ChoirRec);
`;

interface Sounding {
  tag: number;
  midi: number;
  syl: Syllable;
}

class ChoirVoice {
  private nextTag = 2;
  private active: Sounding | null = null;
  private exhaleTag: number | null = null;
  private connected = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly node: AudioWorkletNode,
    private readonly gain: GainNode,
    private readonly master: AudioNode,
    readonly body: BodyMix,
  ) {
    this.send({ type: "telemetry", enabled: false });
    this.send({ type: "body", body });
  }

  private send(message: ToWorklet): void {
    this.node.port.postMessage(message);
  }

  private connect(): void {
    if (this.connected) return;
    this.node.connect(this.gain);
    this.gain.connect(this.master);
    this.connected = true;
  }

  private disconnect(): void {
    if (!this.connected) return;
    this.node.disconnect();
    this.gain.disconnect();
    this.connected = false;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Drop the simulation once the release has had time to finish. */
  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.active) this.disconnect();
    }, 800);
  }

  private dropExhale(): void {
    if (this.exhaleTag === null) return;
    this.send({ type: "release", tag: this.exhaleTag + 1 });
    this.exhaleTag = null;
  }

  private schedule(gestures: Gesture[], id: number): void {
    this.send({ type: "schedule", gestures, segments: [], end: 0, id, replace: false, lead: LEAD });
  }

  attack(syl: Syllable, parent: Syllable, midi: number, velocity: number): void {
    this.clearIdle();
    this.connect();
    if (syl.melisma && this.active) {
      this.glide(midi);
      return;
    }
    const sung = syl.melisma ? { ...parent, onset: [] } : syl;
    this.dropExhale();
    const from = this.active;
    if (from) {
      this.send({ type: "release", tag: from.tag });
      this.send({ type: "release", tag: from.tag + 1 });
    }
    const tag = this.nextTag;
    this.nextTag += 2;
    const breath = breathFor(velocity);
    const gestures = planNoteOn(sung, midi, {
      body: this.body,
      vibrato: VIBRATO,
      tag,
      legatoFrom: from ? { syl: from.syl, midi: from.midi } : undefined,
    }).map((g) => (g.targets.breath !== undefined ? { ...g, targets: { ...g.targets, breath: (g.targets.breath ?? 0) * breath } } : g));
    this.schedule(gestures, tag);
    this.active = { tag, midi, syl: sung };
  }

  private glide(midi: number): void {
    const s = this.active;
    if (!s) return;
    this.send({ type: "release", tag: s.tag + 1 });
    this.schedule(planMelisma(midi, { vibrato: VIBRATO, tag: s.tag }), s.tag + 1);
    s.midi = midi;
  }

  /** `skipCoda`: the next syllable is a melisma, so the vowel ends without a release consonant. */
  release(skipCoda: boolean): void {
    const s = this.active;
    if (!s) {
      this.armIdle();
      return;
    }
    this.send({ type: "release", tag: s.tag });
    this.send({ type: "release", tag: s.tag + 1 });
    this.active = null;
    if (!skipCoda) {
      const gestures = planNoteOff(s.syl, s.midi, this.body);
      if (gestures.length) {
        const tag = this.nextTag;
        this.nextTag += 2;
        this.schedule(
          gestures.map((g) => ({ ...g, tag: g.label === EXHALE_LABEL ? tag + 1 : tag })),
          tag,
        );
        this.exhaleTag = tag;
      }
    }
    this.armIdle();
  }

  /** This voice is not in the chord. Finish anything it was singing. */
  omit(): void {
    if (this.active) this.release(false);
    else this.armIdle();
  }

  dispose(): void {
    this.clearIdle();
    if (this.connected) this.disconnect();
  }
}

export interface RecordedAudio {
  pcm: Float32Array;
  sampleRate: number;
}

export class ChoirEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  /** One peak (0..1) per captured block, for the recorder's display while recording. */
  peaks: number[] = [];
  error: string | null = null;
  /** Fired on the main thread when a take hits the length cap. */
  onLimit: (() => void) | null = null;
  readonly maxSeconds = 60;

  private voices: ChoirVoice[] = [];
  private starting: Promise<void> | null = null;
  private disposed = false;
  private rec: AudioWorkletNode | null = null;
  private recording = false;
  private accepting = false;
  private limited = false;
  private chunks: Float32Array[] = [];
  private recorded = 0;
  private sampleRate = 48000;
  private flushWait: (() => void) | null = null;

  get ready(): boolean {
    return !!this.ctx && this.voices.length === BODIES.length;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.build();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async build(): Promise<void> {
    preferPlaybackSession();
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    const resumed = ctx.resume().catch(() => {});
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const recUrl = URL.createObjectURL(new Blob([REC_SOURCE], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(recUrl);
      } finally {
        URL.revokeObjectURL(recUrl);
      }
    } catch (err) {
      this.ctx = null;
      void ctx.close().catch(() => {});
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    if (this.disposed) {
      void ctx.close().catch(() => {});
      this.ctx = null;
      return;
    }
    const master = ctx.createGain();
    master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.18;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;
    this.analyser = analyser;
    master.connect(comp);
    comp.connect(ctx.destination);
    comp.connect(analyser);

    const rec = new AudioWorkletNode(ctx, "choir-rec", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
    rec.port.onmessage = (e: MessageEvent<Float32Array | string>) => {
      const data = e.data;
      if (data === "flushed") {
        this.flushWait?.();
        return;
      }
      if (data instanceof Float32Array) this.push(data);
      else if (data && typeof data === "object" && "length" in data) this.push(Float32Array.from(data as ArrayLike<number>));
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    comp.connect(rec);
    rec.connect(mute);
    mute.connect(ctx.destination);
    this.rec = rec;

    const module = chimeraModule();
    this.voices = BODIES.map((body) => {
      const node = new AudioWorkletNode(ctx, "chimera", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { module },
      });
      node.port.onmessage = (e: MessageEvent<{ type?: string; message?: string }>) => {
        if (e.data?.type === "error") this.error = e.data.message ?? "voice stopped";
      };
      const gain = ctx.createGain();
      gain.gain.value = 0.22;
      return new ChoirVoice(node, gain, master, body);
    });
    await resumed;
    await ctx.resume();
  }

  sing(notes: readonly (number | null)[], syl: Syllable, parent: Syllable, velocity: number): void {
    this.voices.forEach((voice, i) => {
      const midi = notes[i];
      if (midi == null) voice.omit();
      else voice.attack(syl, parent, midi, velocity);
    });
  }

  releaseAll(skipCoda = false): void {
    for (const voice of this.voices) voice.release(skipCoda);
  }

  beginRecord(): void {
    this.chunks = [];
    this.peaks = [];
    this.recorded = 0;
    this.limited = false;
    this.recording = true;
    this.accepting = true;
    this.rec?.port.postMessage("on");
  }

  capturedSeconds(): number {
    return this.sampleRate ? this.recorded / this.sampleRate : 0;
  }

  private push(chunk: Float32Array): void {
    if (!this.accepting) return;
    const room = this.sampleRate * this.maxSeconds - this.recorded;
    if (room <= 0) {
      if (!this.limited) {
        this.limited = true;
        this.recording = false;
        this.rec?.port.postMessage("off");
        this.onLimit?.();
      }
      return;
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    const copy = slice.slice();
    this.chunks.push(copy);
    this.recorded += copy.length;
    let peak = 0;
    for (let i = 0; i < copy.length; i++) peak = Math.max(peak, Math.abs(copy[i]));
    this.peaks.push(peak);
  }

  endRecord(): Promise<RecordedAudio> {
    this.recording = false;
    const finish = () => {
      this.accepting = false;
      const pcm = new Float32Array(this.recorded);
      let o = 0;
      for (const chunk of this.chunks) {
        pcm.set(chunk, o);
        o += chunk.length;
      }
      this.chunks = [];
      return { pcm, sampleRate: this.sampleRate };
    };
    if (!this.rec) return Promise.resolve(finish());
    return new Promise((resolve) => {
      this.flushWait = () => {
        this.flushWait = null;
        resolve(finish());
      };
      this.rec?.port.postMessage("flush");
      this.rec?.port.postMessage("off");
    });
  }

  dispose(): void {
    this.disposed = true;
    this.recording = false;
    this.accepting = false;
    this.flushWait?.();
    for (const voice of this.voices) voice.dispose();
    this.voices = [];
    const ctx = this.ctx;
    this.ctx = null;
    this.analyser = null;
    this.rec = null;
    if (ctx) void ctx.close().catch(() => {});
  }
}
