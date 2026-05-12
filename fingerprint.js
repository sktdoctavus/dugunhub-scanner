const { execFile, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Write a minimal, spec-compliant 44-byte WAV header + raw s16le PCM into wavPath.
// Avoids any ffmpeg WAV muxer quirks (e.g. JUNK alignment chunks that confuse
// libchromaprint's internal parser and cause "End of file" decode failures).
function writePcmAsWav(pcmPath, wavPath, sampleRate = 22050, channels = 1) {
  const pcm = fs.readFileSync(pcmPath);
  const buf = Buffer.alloc(44 + pcm.length);
  const byteRate = sampleRate * channels * 2;
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);        // PCM fmt chunk is always 16 bytes
  buf.writeUInt16LE(1, 20);         // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34);           // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  fs.writeFileSync(wavPath, buf);
}

// Generate chromaprint fingerprint for an audio file using fpcalc
// Returns array of integers (the fingerprint) and duration in seconds
function getFingerprintFromFile(audioPath) {
  const result = spawnSync("fpcalc", ["-raw", "-json", audioPath], {
    timeout: 60000,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout?.trim()) {
    const detail = (result.stderr || result.error?.message || "no output").slice(0, 600);
    throw new Error(`fpcalc exit ${result.status}: ${detail}`);
  }
  const parsed = JSON.parse(result.stdout);
  return {
    fingerprint: parsed.fingerprint, // int[]
    duration: parsed.duration,
  };
}

// Bit error rate between two fingerprint arrays (lower = more similar)
// < 0.35 is considered a match
function bitErrorRate(fp1, fp2) {
  const len = Math.min(fp1.length, fp2.length);
  if (len === 0) return 1;
  let errors = 0;
  for (let i = 0; i < len; i++) {
    let diff = fp1[i] ^ fp2[i];
    while (diff) {
      errors += diff & 1;
      diff >>>= 1;
    }
  }
  return errors / (len * 32);
}

// Compare a short query fingerprint (video segment) against a longer song fingerprint
// using a sliding window so the match works regardless of where in the song the clip appears.
// Returns the best match score 0-1 (1 = identical)
function compareFingerprints(queryFp, songFp) {
  if (!queryFp?.length || !songFp?.length) return 0;

  // If song fingerprint is shorter than query, just do direct comparison
  if (songFp.length <= queryFp.length) {
    const ber = bitErrorRate(queryFp, songFp);
    return Math.max(0, 1 - ber / 0.35);
  }

  // Slide query over song fingerprint in steps of ~5 seconds (10 ints)
  const step = Math.max(1, Math.floor(queryFp.length / 3));
  let best = 0;
  for (let offset = 0; offset <= songFp.length - queryFp.length; offset += step) {
    const window = songFp.slice(offset, offset + queryFp.length);
    const ber = bitErrorRate(queryFp, window);
    const score = Math.max(0, 1 - ber / 0.35);
    if (score > best) best = score;
    if (best >= 0.9) break; // good enough, stop early
  }
  return best;
}

// Download a specific time segment of a YouTube video as audio, return temp WAV file path.
async function downloadSegment(videoUrl, startSec, durationSec, tmpDir) {
  const outTemplate = path.join(tmpDir, `seg_${startSec}.%(ext)s`);

  const args = [
    "--no-playlist",
    "-x",
    "--format", "bestaudio/best",
    "--download-sections", `*${startSec}-${startSec + durationSec}`,
    "--no-progress",
    "--js-runtimes", "node",
    "--extractor-args", "youtube:player_client=tv_embedded,web_embedded,android_vr,android",
  ];

  if (process.env.YTDLP_PROXY) {
    args.push("--proxy", process.env.YTDLP_PROXY);
  }

  args.push("-o", outTemplate, videoUrl);

  await new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "unknown error").slice(0, 800);
        console.error(`[yt-dlp] FAILED @${startSec}s: ${msg}`);
        reject(new Error(msg));
      } else {
        if (stderr) console.log(`[yt-dlp] @${startSec}s ok. stderr: ${stderr.slice(0, 200)}`);
        resolve();
      }
    });
  });

  // Find the actual output file (extension varies: webm, m4a, opus, etc.)
  const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`seg_${startSec}.`));
  if (files.length === 0) {
    throw new Error(`yt-dlp exited 0 but no output file found for seg_${startSec}`);
  }
  const rawPath = path.join(tmpDir, files[0]);
  console.log(`[yt-dlp] @${startSec}s saved: ${files[0]} (${fs.statSync(rawPath).size} bytes)`);

  // Two-pass audio pipeline to handle truncated opus/webm from yt-dlp --download-sections:
  //
  // Pass 1 (ffmpeg): decode to raw s16le PCM with error tolerance. Raw PCM has no
  //   container header, so truncation = fewer bytes, not a corrupt size field.
  //
  // Pass 2 (Node.js): write a hand-crafted minimal 44-byte WAV header. ffmpeg's WAV
  //   muxer adds a JUNK alignment chunk that confuses libchromaprint's internal RIFF
  //   parser, causing "Error decoding audio frame / End of file" even on valid PCM.
  //   Building the header manually guarantees fmt + data chunks only, exact sizes.
  const pcmPath = path.join(tmpDir, `seg_${startSec}.pcm`);
  const wavPath = path.join(tmpDir, `seg_${startSec}.wav`);

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", [
      "-err_detect", "ignore_err",
      "-i", rawPath,
      "-ac", "1",
      "-ar", "22050",
      "-f", "s16le",
      "-y", pcmPath,
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[ffmpeg/pcm] @${startSec}s failed: ${(stderr || err.message).slice(0, 300)}`);
        reject(new Error(stderr || err.message));
      } else {
        const size = fs.existsSync(pcmPath) ? fs.statSync(pcmPath).size : 0;
        console.log(`[ffmpeg/pcm] @${startSec}s → pcm (${size} bytes)`);
        if (size === 0) reject(new Error("ffmpeg produced empty PCM file"));
        else resolve();
      }
    });
  });

  writePcmAsWav(pcmPath, wavPath);
  const wavSize = fs.statSync(wavPath).size;
  console.log(`[wav] @${startSec}s → wav (${wavSize} bytes)`);

  fs.unlinkSync(rawPath);
  fs.unlinkSync(pcmPath);
  return wavPath;
}

// Extract audio fingerprints from a YouTube video by sampling every intervalSec seconds
// Each sample is sampleDurationSec long
// Returns array of { startSec, fingerprint }
async function fingerprintVideo(videoUrl, videoDurationSec, options = {}) {
  const intervalSec = options.intervalSec || 180; // sample every 3 minutes
  const sampleDurationSec = options.sampleDurationSec || 30;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dugunhub-"));

  const samples = [];
  try {
    for (let start = 0; start < videoDurationSec; start += intervalSec) {
      const end = Math.min(start + sampleDurationSec, videoDurationSec);
      if (end <= start) break;

      let audioPath;
      try {
        audioPath = await downloadSegment(videoUrl, start, end - start, tmpDir);
        const { fingerprint } = getFingerprintFromFile(audioPath);
        console.log(`[fp] sample @${start}s: ${fingerprint.length} ints`);
        samples.push({ startSec: start, fingerprint });
      } catch (e) {
        console.error(`[fp] sample @${start}s FAILED: ${e.message.slice(0, 500)}`);
        samples.push({ startSec: start, fingerprint: null, error: e.message });
      } finally {
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return samples;
}

module.exports = { getFingerprintFromFile, compareFingerprints, fingerprintVideo };
