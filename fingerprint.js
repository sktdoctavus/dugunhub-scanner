const { execFile, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Fingerprint a raw s16le PCM file directly, bypassing any container parsing.
// fpcalc supports raw audio input via -format/-rate/-channels flags, so no WAV
// wrapper is needed. This avoids all RIFF/container-related EOF decode failures.
function getFingerprintFromPcm(pcmPath, sampleRate = 22050, channels = 1) {
  const result = spawnSync("fpcalc", [
    "-raw", "-json",
    "-format", "s16le",
    "-rate", String(sampleRate),
    "-channels", String(channels),
    pcmPath,
  ], { timeout: 60000, encoding: "utf8" });

  if (result.status !== 0 || !result.stdout?.trim()) {
    const detail = (result.stderr || result.error?.message || "no output").slice(0, 600);
    throw new Error(`fpcalc exit ${result.status}: ${detail}`);
  }

  const parsed = JSON.parse(result.stdout);
  return { fingerprint: parsed.fingerprint, duration: parsed.duration };
}

// Generate chromaprint fingerprint for a decoded audio file (WAV, MP3, FLAC, etc.)
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
  return { fingerprint: parsed.fingerprint, duration: parsed.duration };
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

  if (songFp.length <= queryFp.length) {
    const ber = bitErrorRate(queryFp, songFp);
    return Math.max(0, 1 - ber / 0.35);
  }

  const step = Math.max(1, Math.floor(queryFp.length / 3));
  let best = 0;
  for (let offset = 0; offset <= songFp.length - queryFp.length; offset += step) {
    const window = songFp.slice(offset, offset + queryFp.length);
    const ber = bitErrorRate(queryFp, window);
    const score = Math.max(0, 1 - ber / 0.35);
    if (score > best) best = score;
    if (best >= 0.9) break;
  }
  return best;
}

// Download a specific time segment of a YouTube video as audio.
// Returns the path to a raw s16le PCM temp file (caller must delete it).
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

  const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`seg_${startSec}.`));
  if (files.length === 0) {
    throw new Error(`yt-dlp exited 0 but no output file found for seg_${startSec}`);
  }
  const rawPath = path.join(tmpDir, files[0]);
  console.log(`[yt-dlp] @${startSec}s saved: ${files[0]} (${fs.statSync(rawPath).size} bytes)`);

  // Decode to raw s16le PCM. yt-dlp --download-sections produces truncated opus/webm
  // containers (no end-of-stream marker), so the container has a structural EOF.
  // -err_detect ignore_err lets ffmpeg decode all available frames despite the truncation.
  // Raw PCM output has no container header, so there is nothing for fpcalc to mis-parse.
  const pcmPath = path.join(tmpDir, `seg_${startSec}.pcm`);
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
        console.error(`[ffmpeg] @${startSec}s failed: ${(stderr || err.message).slice(0, 300)}`);
        reject(new Error(stderr || err.message));
      } else {
        const size = fs.existsSync(pcmPath) ? fs.statSync(pcmPath).size : 0;
        console.log(`[ffmpeg] @${startSec}s → pcm (${size} bytes)`);
        if (size === 0) reject(new Error("ffmpeg produced empty PCM file"));
        else resolve();
      }
    });
  });

  fs.unlinkSync(rawPath);
  return pcmPath;
}

// Extract audio fingerprints from a YouTube video by sampling every intervalSec seconds
// Each sample is sampleDurationSec long
// Returns array of { startSec, fingerprint }
async function fingerprintVideo(videoUrl, videoDurationSec, options = {}) {
  const intervalSec = options.intervalSec || 180;
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
        const { fingerprint } = getFingerprintFromPcm(audioPath);
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
