const { execFile, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const FormData = require("form-data");
const axios = require("axios");

// Generate chromaprint fingerprint for an audio file — used for danger song approval only.
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
  return result.stdout.trim().split("\n")[0];
}

// Download one audio segment from an already-resolved CDN stream URL.
async function downloadSegment(streamUrl, startSec, durationSec, tmpDir) {
  const flacPath = path.join(tmpDir, `seg_${startSec}.flac`);

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

// Send an audio file to AudD for recognition.
// Returns { title, artist } or null if no song recognized.
async function recognizeWithAudd(audioPath, apiToken) {
  const formData = new FormData();
  formData.append("api_token", apiToken);
  formData.append("audio", fs.createReadStream(audioPath), {
    filename: "audio.flac",
    contentType: "audio/flac",
  });

  const response = await axios.post("https://api.audd.io/", formData, {
    headers: formData.getHeaders(),
    timeout: 30000,
  });

  const data = response.data;

  if (data.status === "error") {
    throw new Error(`AudD error: ${data.error?.error_message || JSON.stringify(data.error)}`);
  }

  if (data.status === "success" && data.result) {
    return {
      title: data.result.title,
      artist: data.result.artist,
      album: data.result.album,
      timecode: data.result.timecode,
    };
  }

  return null;
}

module.exports = { getFingerprintFromFile, resolveStreamUrl, downloadSegment, recognizeWithAudd };
