/**
 * Choir 95 chord spelling and the WAV header. No engine: these stay true if the wasm is absent.
 */
import { describe, expect, test } from "bun:test";
import { AH, assignVoices, chordNotes, KEYMAP, midiName, octaveBase, parentSyllable } from "../src/ui/choir95/chords.ts";
import { encodeWav } from "../src/ui/choir95/wav.ts";

describe("choir chords", () => {
  test("C4 major is bass C3, E4, G4, and a top C5", () => {
    expect(chordNotes(60, "major")).toEqual([48, 64, 67, 72]);
    expect(assignVoices(chordNotes(60, "major"))).toEqual([48, 64, 67, 72]);
  });

  test("a single note is only the soprano", () => {
    expect(assignVoices(chordNotes(60, "single"))).toEqual([null, null, null, 60]);
  });

  test("a dominant 7th keeps four distinct tones", () => {
    expect(chordNotes(60, "7th")).toEqual([48, 64, 67, 70]);
  });

  test("a power chord does not double the top note", () => {
    expect(chordNotes(60, "power")).toEqual([48, 67, 72]);
    expect(assignVoices(chordNotes(60, "power"))).toEqual([48, null, 67, 72]);
  });

  test("sus4 adds the octave above the root", () => {
    expect(chordNotes(60, "sus4")).toEqual([48, 65, 67, 72]);
  });

  test("a low root does not drop the bass below E2", () => {
    expect(chordNotes(48, "minor")[0]).toBe(48);
  });

  test("computer keys match Sing mode and Z/X stay inside two octaves", () => {
    expect(KEYMAP.a).toBe(0);
    expect(KEYMAP[";"]).toBe(16);
    expect(Object.keys(KEYMAP)).toHaveLength(17);
    expect(octaveBase(0)).toBe(60);
    expect(octaveBase(9)).toBe(84);
    expect(octaveBase(-9)).toBe(36);
    expect(midiName(60)).toBe("C4");
  });

  test("a melisma keeps its vowel", () => {
    const held = { ...AH, text: "-", melisma: true };
    expect(parentSyllable([AH, held], 1)).toBe(AH);
    expect(parentSyllable([held], 0)).toEqual(AH);
  });
});

describe("choir wav", () => {
  test("a three-sample buffer is 16-bit mono at the given rate", () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -1]), 48000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(bytes.length).toBe(44 + 6);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16383);
    expect(view.getInt16(48, true)).toBe(-32768);
  });
});
