# MP3-to-piano

Convert a YouTube URL or local MP3 into:
- a MIDI file (.mid)
- piano grand-staff MusicXML (.musicxml)
- a printable piano sheet music PDF (.pdf)

This is a JavaScript / Node.js project. It uses Spotify's TypeScript Basic Pitch implementation. **Python is not required.**

## Windows requirements

1. **Node.js 20 or newer:** https://nodejs.org/
2. **FFmpeg:** https://www.gyan.dev/ffmpeg/builds/
   - Add FFmpeg's \`bin\` directory to your Windows PATH.
3. **yt-dlp.exe** (YouTube input only): https://github.com/yt-dlp/yt-dlp/releases
   - Put \`yt-dlp.exe\` in a folder listed in PATH.
4. **MuseScore 4:** https://musescore.org/
   - The app is used in command-line mode to export MusicXML to PDF.
   - The program checks PATH and common Windows install locations.

## Install

Open CMD or PowerShell in this repository folder:

\`\`\`cmd
npm install
\`\`\`

## Run

\`\`\`cmd
npm start
\`\`\`

Choose YouTube URL or local MP3, then follow the prompts. Outputs are saved under:

\`\`\`text
transcription_output/
  <track-name>/
    <track-name>.mid
    <track-name>.musicxml
    <track-name>.pdf
    audio_22050_mono.wav
\`\`\`

## Notes

- Basic Pitch works best with one prominent instrument. Dense full mixes may produce missed or extra notes.
- The automatic hand split sends MIDI pitches 60 (middle C) and above to treble, and lower pitches to bass. This is a simple range split, not intelligent piano fingering.
- The score is quantized to a sixteenth-note grid and laid out in 4/4 at 120 BPM. The MIDI preserves note timing as seconds at that tempo.
- MuseScore is needed for PDF export. The script always creates the MusicXML file first, so it can still be opened manually if PDF export fails.
- Only download/process audio you have permission to use.

## Tech

- \`@spotify/basic-pitch\` — Spotify's TypeScript audio-to-MIDI transcription model.
- \`@tonejs/midi\` — MIDI file writing.
- \`@tensorflow/tfjs\` — TensorFlow.js model runtime.

Spotify TypeScript Basic Pitch: https://github.com/spotify/basic-pitch-ts
