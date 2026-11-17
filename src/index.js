import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";
import * as tf from "@tensorflow/tfjs";
import { Midi } from "@tonejs/midi";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

const SAMPLE_RATE = 22050;
const BPM = 120;
const BEATS_PER_BAR = 4;
const GRID = 0.25; // sixteenth note, in quarter-note beats
const DIVISIONS = 4; // MusicXML ticks per quarter note
const require = createRequire(import.meta.url);

function findOnPath(names) {
  const pathParts = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32"
    ? [...new Set((process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").concat([""]))]
    : [""];
  for (const name of names) {
    for (const folder of pathParts) {
      for (const ext of extensions) {
        const candidate = join(folder, name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

function findMuseScore() {
  const fromPath = findOnPath(["MuseScore4.exe", "MuseScore.exe", "musescore", "mscore"]);
  if (fromPath) return fromPath;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe",
      "C:\\Program Files\\MuseScore Studio 4\\bin\\MuseScore4.exe",
      "C:\\Program Files\\MuseScore 4\\MuseScore4.exe",
      "C:\\Program Files (x86)\\MuseScore 4\\bin\\MuseScore4.exe"
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }
  return undefined;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(label + " was not found. Install it and add it to PATH.");
    }
    throw new Error(label + " could not start: " + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(label + " exited with code " + String(result.status) + ".");
  }
}

function validYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function safeName(value) {
  const stem = value.replace(/\.[^.]+$/, "");
  return stem.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "transcription";
}

async function obtainAudio(choice, input, outDir) {
  if (choice === "1") {
    if (!validYouTubeUrl(input)) throw new Error("That is not a valid YouTube URL.");
    const ytDlp = findOnPath(["yt-dlp.exe", "yt-dlp"]);
    if (!ytDlp) throw new Error("yt-dlp was not found. Install yt-dlp.exe and add its folder to PATH.");
    const template = join(outDir, "youtube_source.%(ext)s");
    console.log("\nDownloading the best available YouTube audio...");
    run(ytDlp, ["--no-playlist", "-f", "bestaudio", "-x", "--audio-format", "wav", "-o", template, input], "yt-dlp");
    const wavPath = join(outDir, "youtube_source.wav");
    if (!existsSync(wavPath)) throw new Error("yt-dlp did not create the expected WAV file. Check FFmpeg.");
    return { inputPath: wavPath, trackName: "youtube_transcription" };
  }

  const inputPath = resolve(input.replace(/^"|"$/g, ""));
  if (!existsSync(inputPath)) throw new Error("File not found: " + inputPath);
  if (extname(inputPath).toLowerCase() !== ".mp3") throw new Error("Please choose a local .mp3 file.");
  return { inputPath, trackName: safeName(basename(inputPath)) };
}

function normalizeToWav(ffmpeg, inputPath, wavPath) {
  console.log("\nPreparing mono 22050 Hz audio...");
  run(ffmpeg, ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", wavPath], "FFmpeg");
}

function readMonoPcm16Wav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The normalized audio is not a valid WAV file.");
  }
  let format = 0, channels = 0, sampleRate = 0, bits = 0, dataOffset = -1, dataLength = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && size >= 16) {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataOffset = start;
      dataLength = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (format !== 1 || channels !== 1 || sampleRate !== SAMPLE_RATE || bits !== 16) {
    throw new Error("Expected 16-bit PCM mono WAV at 22050 Hz. FFmpeg output did not match.");
  }
  if (dataOffset < 0 || dataLength <= 0 || dataOffset + dataLength > buffer.length) {
    throw new Error("The WAV file has no valid audio data.");
  }
  const samples = new Float32Array(Math.floor(dataLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768;
  return samples;
}

async function loadModel() {
  const packageEntry = require.resolve("@spotify/basic-pitch");
  const packageRoot = resolve(dirname(packageEntry), "..");
  const modelPath = join(packageRoot, "model", "model.json");
  if (!existsSync(modelPath)) throw new Error("Spotify Basic Pitch model.json was not found in the installed package.");

  const modelJson = JSON.parse(await readFile(modelPath, "utf8"));
  if (!modelJson.modelTopology || !Array.isArray(modelJson.weightsManifest)) {
    throw new Error("The Basic Pitch model.json is incomplete.");
  }
  const weightSpecs = [];
  const weightBuffers = [];
  for (const group of modelJson.weightsManifest) {
    weightSpecs.push(...group.weights);
    for (const relativePath of group.paths) {
      const shardPath = resolve(dirname(modelPath), relativePath);
      if (!existsSync(shardPath)) throw new Error("Missing model weights: " + shardPath);
      weightBuffers.push(await readFile(shardPath));
    }
  }
  const joined = Buffer.concat(weightBuffers);
  const weightData = new Uint8Array(joined.length);
  weightData.set(joined);

  await tf.setBackend("cpu");
  await tf.ready();

  const handler = tf.io.fromMemory(modelJson.modelTopology, weightSpecs, weightData.buffer);
  return tf.loadGraphModel(handler);
}

async function transcribe(wavPath) {
  const samples = readMonoPcm16Wav(await readFile(wavPath));
  if (samples.length < SAMPLE_RATE) throw new Error("Audio is shorter than one second or contains no usable sound.");

  console.log("\nLoading Spotify Basic Pitch model...");
  const model = await loadModel();
  const basicPitch = new BasicPitch(model);
  const frames = [], onsets = [], contours = [];
  let lastProgress = -5;

  console.log("Transcribing audio. This can take a while for longer tracks...");
  await basicPitch.evaluateModel(
    samples,
    (frameRows, onsetRows, contourRows) => {
      frames.push(...frameRows);
      onsets.push(...onsetRows);
      contours.push(...contourRows);
    },
    (percent) => {
      const current = Math.floor(percent * 100);
      if (current >= lastProgress + 5 || current === 100) {
        lastProgress = current;
        console.log("Transcription: " + current + "%");
      }
    }
  );

  const frameNotes = outputToNotesPoly(frames, onsets, 0.25, 0.25, 5);
  const notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, frameNotes));
  if (!notes.length) throw new Error("No notes were detected. Try clearer audio with one prominent instrument.");
  return notes;
}

async function saveMidi(notes, path) {
  const midi = new Midi();
  midi.header.setTempo(BPM);
  const track = midi.addTrack();
  track.name = "Piano transcription";
  for (const item of notes) {
    track.addNote({
      midi: Math.round(item.pitchMidi),
      time: Math.max(0, item.startTimeSeconds),
      duration: Math.max(0.01, item.durationSeconds),
      velocity: Math.max(0.01, Math.min(1, item.amplitude))
    });
    if (Array.isArray(item.pitchBends)) {
      item.pitchBends.forEach((bend, index) => {
        const time = item.startTimeSeconds + item.durationSeconds * index / Math.max(1, item.pitchBends.length);
        track.addPitchBend({ time: Math.max(0, time), value: Math.max(-1, Math.min(1, bend)) });
      });
    }
  }
  await writeFile(path, Buffer.from(midi.toArray()));
}

function quantizeBeats(seconds) {
  return Math.max(0, Math.round((seconds * BPM / 60) / GRID) * GRID);
}

function makeMeasureFragments(notes) {
  const measures = new Map();
  for (const note of notes) {
    const start = quantizeBeats(note.startTimeSeconds);
    const duration = Math.max(GRID, Math.round((note.durationSeconds * BPM / 60) / GRID) * GRID);
    const end = start + duration;
    let cursor = start;
    while (cursor < end - 1e-7) {
      const bar = Math.floor(cursor / BEATS_PER_BAR);
      const barStart = bar * BEATS_PER_BAR;
      const fragmentDuration = Math.min(end - cursor, barStart + BEATS_PER_BAR - cursor);
      if (!measures.has(bar)) measures.set(bar, { treble: [], bass: [] });
      const target = note.pitchMidi >= 60 ? measures.get(bar).treble : measures.get(bar).bass;
      target.push({
        start: cursor - barStart,
        duration: fragmentDuration,
        pitch: Math.max(0, Math.min(127, Math.round(note.pitchMidi))),
        tieFromPrevious: cursor > start + 1e-7,
        tieToNext: cursor + fragmentDuration < end - 1e-7
      });
      cursor += fragmentDuration;
    }
  }
  return measures;
}

function groupAtSameStart(fragments) {
  const map = new Map();
  for (const fragment of fragments) {
    const key = fragment.start.toFixed(4);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fragment);
  }
  return [...map.values()].map((items) => ({
    start: items[0].start,
    duration: Math.max(...items.map((item) => item.duration)),
    notes: items.sort((a, b) => a.pitch - b.pitch)
  })).sort((a, b) => a.start - b.start);
}

function splitVoices(groups) {
  const voices = [];
  const endTimes = [];
  for (const group of groups) {
    let index = endTimes.findIndex((end) => end <= group.start + 1e-7);
    if (index < 0) {
      index = voices.length;
      voices.push([]);
      endTimes.push(0);
    }
    voices[index].push(group);
    endTimes[index] = group.start + group.duration;
  }
  return voices.length ? voices : [[]];
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function pitchXml(midiPitch) {
  const pitchClasses = [
    ["C", 0, ""], ["C", 1, "sharp"], ["D", 0, ""], ["D", 1, "sharp"],
    ["E", 0, ""], ["F", 0, ""], ["F", 1, "sharp"], ["G", 0, ""],
    ["G", 1, "sharp"], ["A", 0, ""], ["A", 1, "sharp"], ["B", 0, ""]
  ];
  const [step, alter, accidental] = pitchClasses[midiPitch % 12];
  const octave = Math.floor(midiPitch / 12) - 1;
  return "<pitch><step>" + step + "</step>" +
    (alter ? "<alter>" + alter + "</alter>" : "") +
    "<octave>" + octave + "</octave></pitch>" +
    (accidental ? "<accidental>" + accidental + "</accidental>" : "");
}

const DURATIONS = [
  { beats: 4, type: "whole", dots: 0 },
  { beats: 3, type: "half", dots: 1 },
  { beats: 2, type: "half", dots: 0 },
  { beats: 1.5, type: "quarter", dots: 1 },
  { beats: 1, type: "quarter", dots: 0 },
  { beats: 0.75, type: "eighth", dots: 1 },
  { beats: 0.5, type: "eighth", dots: 0 },
  { beats: 0.375, type: "16th", dots: 1 },
  { beats: 0.25, type: "16th", dots: 0 }
];

function durationParts(beats) {
  const parts = [];
  let remaining = Math.round(beats / GRID) * GRID;
  while (remaining > 1e-7) {
    const part = DURATIONS.find((candidate) => candidate.beats <= remaining + 1e-7) || DURATIONS[DURATIONS.length - 1];
    parts.push(part);
    remaining = Math.round((remaining - part.beats) / GRID) * GRID;
  }
  return parts;
}

function noteElement(fragment, duration, voice, staff, chordTone, tieStart, tieStop) {
  const ticks = Math.max(1, Math.round(duration.beats * DIVISIONS));
  let xml = "<note>";
  if (chordTone) xml += "<chord/>";
  xml += pitchXml(fragment.pitch);
  xml += "<duration>" + ticks + "</duration>";
  if (tieStop) xml += '<tie type="stop"/>';
  if (tieStart) xml += '<tie type="start"/>';
  xml += "<voice>" + voice + "</voice><type>" + duration.type + "</type>";
  for (let i = 0; i < duration.dots; i++) xml += "<dot/>";
  xml += "<staff>" + staff + "</staff>";
  if (tieStart || tieStop) {
    xml += "<notations>";
    if (tieStop) xml += '<tied type="stop"/>';
    if (tieStart) xml += '<tied type="start"/>';
    xml += "</notations>";
  }
  return xml + "</note>";
}

function restElement(beats, voice, staff) {
  return durationParts(beats).map((duration) => {
    const ticks = Math.max(1, Math.round(duration.beats * DIVISIONS));
    return "<note><rest/><duration>" + ticks + "</duration><voice>" + voice +
      "</voice><type>" + duration.type + "</type>" +
      "<staff>" + staff + "</staff></note>";
  }).join("");
}

function voiceMeasureXml(groups, voice, staff) {
  let xml = "";
  let cursor = 0;
  for (const group of groups) {
    if (group.start > cursor + 1e-7) xml += restElement(group.start - cursor, voice, staff);
    const parts = durationParts(group.duration);
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      group.notes.forEach((fragment, noteIndex) => {
        const tieStop = partIndex > 0 || fragment.tieFromPrevious;
        const tieStart = partIndex < parts.length - 1 || fragment.tieToNext;
        xml += noteElement(fragment, part, voice, staff, noteIndex > 0, tieStart, tieStop);
      });
    }
    cursor = group.start + group.duration;
  }
  if (cursor < BEATS_PER_BAR - 1e-7) xml += restElement(BEATS_PER_BAR - cursor, voice, staff);
  return xml;
}

function makeMusicXml(notes, title) {
  const measures = makeMeasureFragments(notes);
  const lastMeasure = measures.size ? Math.max(...measures.keys()) : 0;
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
  xml += '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n';
  xml += '<score-partwise version="4.0"><work><work-title>' + escapeXml(title) + '</work-title></work>';
  xml += "<identification><encoding><software>MP3-to-piano</software></encoding></identification>";
  xml += '<part-list><score-part id="P1"><part-name>Piano</part-name><score-instrument id="P1-I1"><instrument-name>Acoustic Grand Piano</instrument-name></score-instrument></score-part></part-list>';
  xml += '<part id="P1">';

  for (let bar = 0; bar <= lastMeasure; bar++) {
    const measure = measures.get(bar) || { treble: [], bass: [] };
    const trebleVoices = splitVoices(groupAtSameStart(measure.treble));
    const bassVoices = splitVoices(groupAtSameStart(measure.bass));
    const allVoices = [
      ...trebleVoices.map((groups, index) => ({ groups, staff: 1, voice: index + 1 })),
      ...bassVoices.map((groups, index) => ({ groups, staff: 2, voice: index + 1 }))
    ];

    xml += '<measure number="' + (bar + 1) + '">';
    if (bar === 0) {
      xml += '<attributes><divisions>' + DIVISIONS + '</divisions><key><fifths>0</fifths></key>';
      xml += '<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>';
      xml += '<clef number="1"><sign>G</sign><line>2</line></clef>';
      xml += '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>';
      xml += '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>' + BPM + '</per-minute></metronome></direction-type><sound tempo="' + BPM + '"/></direction>';
    }

    let firstVoice = true;
    for (const entry of allVoices) {
      if (!firstVoice) xml += '<backup><duration>' + (BEATS_PER_BAR * DIVISIONS) + '</duration></backup>';
      xml += voiceMeasureXml(entry.groups, entry.voice, entry.staff);
      firstVoice = false;
    }
    if (bar === lastMeasure) xml += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    xml += "</measure>";
  }
  xml += "</part></score-partwise>";
  return xml;
}

async function exportPdf(musicXmlPath, pdfPath) {
  const museScore = findMuseScore();
  if (!museScore) throw new Error("MuseScore 4 was not found. Install it or add MuseScore4.exe to PATH. The MusicXML file has still been saved.");
  console.log("\nRendering PDF with MuseScore...");
  run(museScore, ["-o", pdfPath, musicXmlPath], "MuseScore");
  if (!existsSync(pdfPath)) throw new Error("MuseScore did not create the PDF. The MusicXML file is available to open manually.");
}

async function main() {
  console.log("==============================================");
  console.log("          MP3 / YOUTUBE TO PIANO");
  console.log("==============================================");
  console.log("1. YouTube URL");
  console.log("2. Local MP3 file");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const choice = (await rl.question("\nChoose 1 or 2: ")).trim();
    if (choice !== "1" && choice !== "2") throw new Error("Choose either 1 or 2.");
    const input = (await rl.question(choice === "1" ? "Paste YouTube URL: " : "Enter MP3 path: ")).trim().replace(/^"|"$/g, "");
    if (!input) throw new Error("No input was provided.");

    const ffmpeg = findOnPath(["ffmpeg.exe", "ffmpeg"]);
    if (!ffmpeg) throw new Error("FFmpeg was not found. Install FFmpeg and add its bin folder to PATH.");
    const outputBase = resolve("transcription_output");
    await mkdir(outputBase, { recursive: true });

    const source = await obtainAudio(choice, input, outputBase);
    const outDir = join(outputBase, source.trackName);
    await mkdir(outDir, { recursive: true });

    const wavPath = join(outDir, "audio_22050_mono.wav");
    normalizeToWav(ffmpeg, source.inputPath, wavPath);

    const notes = await transcribe(wavPath);
    const midiPath = join(outDir, source.trackName + ".mid");
    await saveMidi(notes, midiPath);
    console.log("\nMIDI saved: " + midiPath);

    const xmlPath = join(outDir, source.trackName + ".musicxml");
    const xml = makeMusicXml(notes, source.trackName);
    await writeFile(xmlPath, xml, "utf8");
    console.log("MusicXML saved: " + xmlPath);

    const pdfPath = join(outDir, source.trackName + ".pdf");
    await exportPdf(xmlPath, pdfPath);
    console.log("PDF saved: " + pdfPath);
    console.log("\nDone! All output files are in: " + outDir);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("\nERROR: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
