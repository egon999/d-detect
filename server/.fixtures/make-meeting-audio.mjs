/**
 * Builds the audio fixtures the meeting pipeline is tested against.
 *
 * The pipeline's headline feature had never been exercised end to end, because there was no
 * audio in `.fixtures/` to exercise it with — only images. Every test of it stubbed the
 * network boundary, which proves the code around Whisper and never that a real recording
 * from a real device survives the round trip. A committed, decodable recording is what makes
 * `curl` against the live server a thing anyone can repeat.
 *
 * Why the formats below and not an MP3: there is no ffmpeg or encoder on the machine this was
 * written on, and the one thing Windows can be made to produce without installing anything is
 * uncompressed RIFF/WAVE through the speech synthesiser in `System.Speech`. That turns out to
 * be the better fixture anyway — `planSegments` and `measuredDurationMs` in
 * `routes/meetings.ts` parse WAV by hand, so a real RIFF file from a real writer exercises the
 * parser as well as the upload.
 *
 * 16 kHz mono is deliberate and not a compromise: Whisper resamples everything to 16 kHz, so
 * anything higher is bytes a person on a slow connection would pay to upload for no gain in
 * what comes back. It is also what keeps the file small enough to commit.
 *
 * The speaking voices are en-US because they are the only ones installed here — SAPI exposes
 * no Hindi voice and there is no Indic TTS on this machine to add one. That limits what this
 * fixture can prove: it proves the pipeline, not the product's Hindi promise. The Hindi path
 * is verified separately by seeding a Devanagari transcript and re-reading it, which drives
 * the same analysis call with the same grounding against real Hindi words.
 *
 * Run: node .fixtures/make-meeting-audio.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname);

/** What Whisper resamples to anyway, so anything more is upload a person pays for twice. */
const SAMPLE_RATE = 16_000;

/**
 * The meeting, written to be worth extracting from rather than merely audible.
 *
 * Every clause here exists to drive one branch of the reading. Three rupee figures, all four
 * digits, so `figuresIn` has something real to check a summary's arithmetic against and a
 * hallucinated fourth figure would be caught. Two named speakers, so `owner` is a name
 * somebody said rather than a guess. One decision actually reached, so `decisions` is not
 * empty. Two deadlines spoken the way deadlines are spoken in a room — "by Friday", "before
 * Thursday" — which is the case `dueDate` resolution and the anchoring rule exist for. And one
 * unresolved complaint, so `attention` has a genuine item instead of a generic one.
 *
 * It is an English conversation between a shopkeeper and his rice supplier because that is the
 * voice available, and the content is the kind of meeting this product is for.
 */
const SCRIPT = [
  { voice: 'david', line: 'Sanjay, about the rice order. Last month you charged me 2400 rupees per bag, and this month the invoice says 2650.' },
  { voice: 'zira', line: 'The mill put its price up in September, Ravi. I can hold you at 2500 rupees a bag if you take forty bags instead of twenty five.' },
  { voice: 'david', line: 'Forty bags is more than I can store. Make it thirty bags at 2500, and I will pay half on delivery.' },
  { voice: 'zira', line: 'Agreed. Thirty bags at 2500 rupees, delivered Thursday morning. You send me the rest of the payment by Friday.' },
  { voice: 'david', line: 'One more thing. The last delivery was short by two bags and nobody ever adjusted it. Take that off this bill.' },
  { voice: 'zira', line: 'I will check the challan and send you a corrected invoice before Thursday.' },
];

/**
 * Renders the script to one WAV through the Windows speech synthesiser.
 *
 * Written out as a script file and run with `-File` rather than passed as `-Command`: the lines
 * contain apostrophes and commas, and quoting those through two shells is how a fixture ends up
 * silently missing half its sentences.
 *
 * The voices alternate so the recording is a conversation rather than a monologue. That matters
 * for what is being tested — a reading that has to attribute an action item to Sanjay rather
 * than Ravi is a reading that can get the owner wrong, and a single-voice fixture would never
 * catch it.
 */
function renderSpeech(target) {
  const scratch = mkdtempSync(join(tmpdir(), 'detact-fixture-'));
  try {
    const say = SCRIPT.map(({ voice, line }) => {
      const pick = voice === 'david' ? 'Microsoft David Desktop' : 'Microsoft Zira Desktop';
      // Doubled single quotes are PowerShell's own escape, which is what makes "I will" safe.
      return `$s.SelectVoice('${pick}')\n$s.Speak('${line.replaceAll("'", "''")}')`;
    }).join('\n');

    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${target.replaceAll("'", "''")}', $format)
$s.Rate = 1
${say}
$s.SetOutputToNull()
$s.Dispose()
`;
    const file = join(scratch, 'speak.ps1');
    writeFileSync(file, ps, 'utf8');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A RIFF/WAVE wrapper around 16-bit mono samples, with every size field honest. */
function wave(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.byteLength - 8, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let at = 0; at < samples.length; at += 1) out.writeInt16LE(samples[at], 44 + at * 2);
  return out;
}

/**
 * A recording with something on it that is not speech.
 *
 * This is the fixture behind the one failure the route's own comments describe as having
 * reached a person: Whisper answers a tone with `"."`, which is not empty, so a transcript
 * stored on a `length > 0` test produced a summary reading "No transcript was provided for
 * analysis." A tone is how `hasSpeech` gets tested against the thing it was written for.
 */
function tone(seconds) {
  const samples = new Int16Array(SAMPLE_RATE * seconds);
  for (let at = 0; at < samples.length; at += 1) {
    samples[at] = Math.round(Math.sin((2 * Math.PI * 440 * at) / SAMPLE_RATE) * 12_000);
  }
  return wave(samples);
}

/** A phone left in a bag: a real, decodable, playable recording of nothing at all. */
function silence(seconds) {
  return wave(new Int16Array(SAMPLE_RATE * seconds));
}

/**
 * Where a RIFF file's sample data actually begins.
 *
 * Not a constant, and that is the point. The synthesiser writes an 18-byte `fmt ` chunk — PCM
 * plus a zero `cbSize` — which puts `data` at offset 38 rather than the 44 every "WAV header
 * is 44 bytes" snippet assumes. Truncating at the assumed offset overwrote the `data` tag
 * itself, which makes the file unparseable in a way no recorder produces: `readWave` finds no
 * data chunk, the file stops being a WAV, and the truncation fixture ends up testing a
 * corruption nothing in the wild creates instead of the one it was written for.
 */
function dataChunk(bytes) {
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'data') return { body: at + 8, size: at + 4 };
    at = at + 8 + size + (size % 2);
    if (size === 0) break;
  }
  throw new Error('the synthesiser wrote a RIFF file with no data chunk');
}

/**
 * A recording whose writer was killed mid-write.
 *
 * The header still declares the full length the recorder intended, and the bytes stop a
 * fraction of a second in. That mismatch is not hypothetical — it is what a phone killed by
 * the task manager during a recording leaves on disk, and `readWave` has a branch for exactly
 * it that nothing was testing. Cut on a sample boundary so what little audio survives is
 * valid, which is the hard case: a file that is broken and decodable at the same time.
 */
function truncate(full) {
  const { body, size } = dataChunk(full);
  const out = Buffer.from(full.subarray(0, body + 1_600 * 2));
  out.writeUInt32LE(full.byteLength - 8, 4); // the RIFF size the recorder meant to write
  out.writeUInt32LE(full.byteLength - body, size); // and the data size, now overstating what is here
  return out;
}

const spoken = join(HERE, 'meeting.wav');
renderSpeech(spoken);
const full = readFileSync(spoken);

writeFileSync(join(HERE, 'meeting-tone.wav'), tone(3));
writeFileSync(join(HERE, 'meeting-silence.wav'), silence(3));
writeFileSync(join(HERE, 'meeting-truncated.wav'), truncate(full));
writeFileSync(join(HERE, 'meeting-empty.wav'), Buffer.alloc(0));

const seconds = ((full.byteLength - 44) / (SAMPLE_RATE * 2)).toFixed(1);
console.log(`meeting.wav           ${full.byteLength} bytes, ${seconds}s of speech`);
for (const name of ['meeting-tone.wav', 'meeting-silence.wav', 'meeting-truncated.wav', 'meeting-empty.wav']) {
  console.log(`${name.padEnd(22)}${readFileSync(join(HERE, name)).byteLength} bytes`);
}
