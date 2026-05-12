const { execFile, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Generate chromaprint fingerprint for an audio file (WAV, FLAC, MP3, etc.)
// Returns { fingerprint: int[], duration }
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

// Compare a short query fingerprint against a longer song fingerprint using a sliding
// window. Returns the best match score 0-1 (1 = identical).
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

// Download a YouTube audio segment and return the path to a FLAC temp file.
//
// yt-dlp --download-sections produces truncated opus/webm containers (the stream is
// cut without a proper end-of-stream marker). WAV and raw-PCM output from such files
// cause fpcalc to exit 3 ("Error decoding audio frame / End of file") regardless of
// how the WAV header is constructed, because libchromaprint's internal libav parser
// hits the EOF condition differently for those formats.
//
// FLAC is self-framing: each frame carries its own sync word and sample count, so
// the decoder never relies on a pre-declared total size. ffmpeg properly closes the
// FLAC STREAMINFO after flushing the decoder, giving fpcalc a valid, complete file
// even when the source container was truncated.
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
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
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
  if (files.length === 0) throw new Error(`yt-dlp produced no output for seg_${startSec}`);
  const rawPath = path.join(tmpDir, files[0]);
  console.log(`[yt-dlp] @${startSec}s saved: ${files[0]} (${fs.statSync(rawPath).size} bytes)`);

  const flacPath = path.join(tmpDir, `seg_${startSec}.flac`);
  await new Promise((resolve, reject) => {
    execFile("ffmpeg", [
      "-err_detect", "ignore_err",
      "-i", rawPath,
      "-ac", "1",
      "-ar", "22050",
      "-c:a", "flac",
      "-y", flacPath,
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[ffmpeg] @${startSec}s failed: ${(stderr || err.message).slice(0, 300)}`);
        reject(new Error(stderr || err.message));
      } else {
        const size = fs.existsSync(flacPath) ? fs.statSync(flacPath).size : 0;
        console.log(`[ffmpeg] @${startSec}s → flac (${size} bytes)`);
        if (size === 0) reject(new Error("ffmpeg produced empty FLAC"));
        else resolve();
      }
    });
  });

  fs.unlinkSync(rawPath);
  return flacPath;
}

// Extract audio fingerprints from a YouTube video by sampling every intervalSec seconds.
// Returns array of { startSec, fingerprint }.
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
