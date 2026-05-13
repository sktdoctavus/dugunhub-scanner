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
// BER divisor 0.45: tolerates up to 45% bit errors to handle mixed/overlaid audio.
function compareFingerprints(queryFp, songFp) {
  if (!queryFp?.length || !songFp?.length) return 0;

  if (songFp.length <= queryFp.length) {
    const ber = bitErrorRate(queryFp, songFp);
    return Math.max(0, 1 - ber / 0.45);
  }

  const step = Math.max(1, Math.floor(queryFp.length / 3));
  let best = 0;
  let bestBer = 1;
  for (let offset = 0; offset <= songFp.length - queryFp.length; offset += step) {
    const window = songFp.slice(offset, offset + queryFp.length);
    const ber = bitErrorRate(queryFp, window);
    const score = Math.max(0, 1 - ber / 0.45);
    if (score > best) { best = score; bestBer = ber; }
    if (best >= 0.9) break;
  }
  return best;
}

// Resolve the direct audio CDN URL for a YouTube video URL (called once per video).
function resolveStreamUrl(videoUrl) {
  const ytArgs = [
    "-g",
    "--no-playlist",
    "--format", "bestaudio/best",
    "--extractor-args", "youtube:player_client=tv_embedded,web_embedded,android_vr,android",
  ];
  if (process.env.YTDLP_PROXY) ytArgs.push("--proxy", process.env.YTDLP_PROXY);
  ytArgs.push(videoUrl);

  const result = spawnSync("yt-dlp", ytArgs, { timeout: 60000, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(
      `yt-dlp -g failed (exit ${result.status}): ${(result.stderr || "").slice(0, 400)}`
    );
  }
  // yt-dlp may print multiple lines (audio + video DASH URLs); take the first
  return result.stdout.trim().split("\n")[0];
}

// Download one audio segment from an already-resolved CDN stream URL.
// streamUrl comes from resolveStreamUrl() — called once per video, not per sample.
async function downloadSegment(streamUrl, startSec, durationSec, tmpDir) {
  const flacPath = path.join(tmpDir, `seg_${startSec}.flac`);

  // ffmpeg -ss before -i = HTTP Range seek (no decode-and-discard).
  // -t limits output to exactly durationSec seconds.
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
  const intervalSec = options.intervalSec || 60;
  const sampleDurationSec = options.sampleDurationSec || 30;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dugunhub-"));

  // Resolve the CDN stream URL once for the whole video — not once per sample.
  // A single yt-dlp -g call takes ~30s; resolving per sample multiplies that cost
  // by the number of samples (e.g. 20× for a 1-hour video).
  let streamUrl;
  try {
    console.log(`[yt-dlp] resolving stream URL...`);
    streamUrl = resolveStreamUrl(videoUrl);
    console.log(`[yt-dlp] stream URL resolved`);
  } catch (e) {
    return [{ startSec: 0, fingerprint: null, error: e.message }];
  }

  const samples = [];
  try {
    for (let start = 0; start < videoDurationSec; start += intervalSec) {
      const end = Math.min(start + sampleDurationSec, videoDurationSec);
      if (end <= start) break;

      let audioPath;
      try {
        audioPath = await downloadSegment(streamUrl, start, end - start, tmpDir);
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
