const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Generate chromaprint fingerprint for an audio file using fpcalc
// Returns array of integers (the fingerprint) and duration in seconds
function getFingerprintFromFile(audioPath) {
  try {
    const out = execSync(`fpcalc -raw -json "${audioPath}"`, { timeout: 60000 }).toString();
    const parsed = JSON.parse(out);
    return {
      fingerprint: parsed.fingerprint, // int[]
      duration: parsed.duration,
    };
  } catch (e) {
    throw new Error(`fpcalc failed: ${e.message}`);
  }
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

// Compare a query fingerprint (from a video segment) against a stored song fingerprint
// Returns match score 0-1 (1 = identical)
function compareFingerprints(queryFp, songFp) {
  if (!queryFp?.length || !songFp?.length) return 0;
  const ber = bitErrorRate(queryFp, songFp);
  return Math.max(0, 1 - ber / 0.35); // normalize: 1=perfect match, 0=no match
}

// Download a specific time segment of a YouTube video as audio, return temp file path
async function downloadSegment(videoUrl, startSec, durationSec, tmpDir) {
  const outPath = path.join(tmpDir, `seg_${startSec}.mp3`);
  const cmd = [
    "yt-dlp",
    "--no-playlist",
    "--extract-audio",
    "--audio-format mp3",
    "--audio-quality 5",
    `--download-sections "*${startSec}-${startSec + durationSec}"`,
    "--force-keyframes-at-cuts",
    "-o", `"${outPath}"`,
    `"${videoUrl}"`,
  ].join(" ");

  await new Promise((resolve, reject) => {
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });

  return outPath;
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
        samples.push({ startSec: start, fingerprint });
      } catch (e) {
        // Skip this segment on error, don't fail the whole video
        samples.push({ startSec: start, fingerprint: null, error: e.message });
      } finally {
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      }
    }
  } finally {
    // Cleanup temp dir
    try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  }

  return samples;
}

module.exports = { getFingerprintFromFile, compareFingerprints, fingerprintVideo };
