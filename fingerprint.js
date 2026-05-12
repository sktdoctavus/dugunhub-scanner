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
// WHY NOT --download-sections:
// yt-dlp --download-sections produces a truncated opus/webm container (the stream is
// cut mid-bitstream). ffmpeg's -err_detect ignore_err can open the container but the
// opus decoder produces garbage (random noise) for most frames because it lacks the
// reference frames that were cut off. FLAC of random noise is larger than raw PCM —
// confirmed by output sizes — so chromaprint exits 3 (fingerprint calc failed) on
// every format we tried (WAV, raw PCM, FLAC).
//
// THE FIX:
// Use `yt-dlp -g` to resolve the direct CDN stream URL, then let ffmpeg seek into
// the live stream with -ss (HTTP Range seek, no decode-and-discard). ffmpeg reads a
// properly formed stream from the seek point and outputs exactly durationSec seconds
// of clean audio. No truncated containers, no garbage frames.
async function downloadSegment(videoUrl, startSec, durationSec, tmpDir) {
  const flacPath = path.join(tmpDir, `seg_${startSec}.flac`);

  // Step 1: resolve direct audio CDN URL
  const ytArgs = [
    "-g",
    "--no-playlist",
    "--format", "bestaudio/best",
    "--extractor-args", "youtube:player_client=tv_embedded,web_embedded,android_vr,android",
  ];
  if (process.env.YTDLP_PROXY) ytArgs.push("--proxy", process.env.YTDLP_PROXY);
  ytArgs.push(videoUrl);

  const ytResult = spawnSync("yt-dlp", ytArgs, { timeout: 30000, encoding: "utf8" });
  if (ytResult.status !== 0 || !ytResult.stdout?.trim()) {
    throw new Error(
      `yt-dlp -g failed (exit ${ytResult.status}): ${(ytResult.stderr || "").slice(0, 400)}`
    );
  }

  // yt-dlp may print multiple lines (audio + video DASH URLs); take the first
  const streamUrl = ytResult.stdout.trim().split("\n")[0];
  console.log(`[yt-dlp] @${startSec}s resolved stream URL`);

  // Step 2: ffmpeg seeks via HTTP Range (-ss before -i) and extracts durationSec seconds.
  // Output is FLAC for a clean, self-framing container fpcalc handles natively.
  const ffArgs = ["-ss", String(startSec), "-t", String(durationSec)];
  if (process.env.YTDLP_PROXY) ffArgs.push("-http_proxy", process.env.YTDLP_PROXY);
  ffArgs.push(
    "-i", streamUrl,
    "-ac", "1",
    "-ar", "22050",
    "-c:a", "flac",
    "-y", flacPath,
  );

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ffArgs, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[ffmpeg] @${startSec}s failed: ${(stderr || err.message).slice(0, 400)}`);
        reject(new Error(stderr || err.message));
      } else {
        const size = fs.existsSync(flacPath) ? fs.statSync(flacPath).size : 0;
        console.log(`[ffmpeg] @${startSec}s → flac (${size} bytes)`);
        if (size === 0) reject(new Error("ffmpeg produced empty FLAC"));
        else resolve();
      }
    });
  });

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
