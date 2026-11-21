/**
 * Chord spelling for Choir 95. Pure: no engine, so the keyboard layout can be tested without wasm.
 * Computer keys match Sing mode (`src/ui/components/Keys.tsx`): A W S E D F T G Y H U J K O L P ;
 * are one piano row starting on C, and Z / X move the octave.
 */
import type { Syllable } from "../../wasm/types.ts";

export const CHORDS = ["single", "major", "minor", "7th", "sus4", "power"] as const;
export type ChordKind = (typeof CHORDS)[number];

export const CHORD_LABEL: Record<ChordKind, string> = {
  single: "Single",
  major: "Major",
  minor: "Minor",
  "7th": "7th",
  sus4: "Sus4",
  power: "Power",
};

/** Bass, tenor, alto, soprano. Index 0 is the lowest voice. */
export const VOICE_NAMES = ["Bass", "Tenor", "Alto", "Soprano"] as const;
export const VOICE_COUNT = VOICE_NAMES.length;

/** Home key of the on-screen piano and the A key: C4. */
export const BASE_MIDI = 60;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Same map as Sing mode, including the semicolon key. */
export const KEYMAP: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ";": 16,
};

export const KEY_LETTERS = ["A", "W", "S", "E", "D", "F", "T", "G", "Y", "H", "U", "J", "K", "O", "L", "P", ";"];

const clampMidi = (n: number) => Math.min(84, Math.max(36, Math.round(n)));

export function midiName(midi: number): string {
  const m = Math.round(midi);
  const n = ((m % 12) + 12) % 12;
  return `${NAMES[n]}${Math.floor(m / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

/** Octave shift from Z / X, clamped so the keyboard stays in a singable range. */
export function octaveBase(octave: number): number {
  return BASE_MIDI + Math.max(-2, Math.min(2, octave)) * 12;
}

/**
 * Notes of a chord whose root is `root` (the key the player pressed), low to high.
 * Triads gain a top octave so three singers aren't a bare stack; the bass drops an octave
 * when that still lands on a note the airway can sing (E2 and above).
 */
export function chordNotes(root: number, kind: ChordKind): number[] {
  const intervals: Record<ChordKind, number[]> = {
    single: [0],
    major: [0, 4, 7],
    minor: [0, 3, 7],
    "7th": [0, 4, 7, 10],
    sus4: [0, 5, 7],
    power: [0, 7, 12],
  };
  const iv = intervals[kind];
  const spread = kind !== "single";
  const dropped = root - 12;
  const bass = spread && dropped >= 40 ? dropped : root;
  const notes = iv.map((step, i) => (i === 0 ? bass : root + step));
  const top = root + 12;
  if (spread && notes.length < 4 && notes[notes.length - 1] !== top) notes.push(top);
  return notes.map(clampMidi);
}

/** Place chord tones on bass, tenor, alto, soprano. A single note is the soprano. */
export function assignVoices(notes: readonly number[]): (number | null)[] {
  const slots: (number | null)[] = [null, null, null, null];
  const place: Record<number, number[]> = {
    1: [3],
    2: [0, 3],
    3: [0, 2, 3],
    4: [0, 1, 2, 3],
  };
  const idx = place[Math.min(4, notes.length)] ?? place[4];
  for (let i = 0; i < notes.length && i < 4; i++) slots[idx[i]] = notes[i];
  return slots;
}

/** Sung when the lyric box is empty: an open "ah", same idea as Sing mode. */
export const AH: Syllable = {
  text: "ah",
  onset: [],
  nucleus: { ipa: "ɑ", stress: 1 },
  coda: [],
  wordEnd: true,
  phraseEnd: false,
};

/** The syllable a melisma continues, or `ah` if the line is only holds. */
export function parentSyllable(syls: readonly Syllable[], index: number): Syllable {
  for (let k = index; k >= 0; k--) if (!syls[k].melisma) return syls[k];
  return AH;
}
