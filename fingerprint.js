const { execFile, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");

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
  const flacPath = path.join(tmpDir, `seg_${startSec}.mp3`);

  const ffArgs = ["-ss", String(startSec), "-t", String(durationSec)];
  if (process.env.YTDLP_PROXY) ffArgs.push("-http_proxy", process.env.YTDLP_PROXY);
  ffArgs.push(
    "-i", streamUrl,
    "-ac", "1",
    "-ar", "22050",
    "-c:a", "libmp3lame",
    "-q:a", "5",
    "-y", flacPath,
  );

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ffArgs, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[ffmpeg] @${startSec}s failed: ${(stderr || err.message).slice(0, 400)}`);
        reject(new Error(stderr || err.message));
      } else {
        const size = fs.existsSync(flacPath) ? fs.statSync(flacPath).size : 0;
        console.log(`[ffmpeg] @${startSec}s → mp3 (${size} bytes)`);
        if (size === 0) reject(new Error("ffmpeg produced empty MP3"));
        else resolve();
      }
    });
  });

  return flacPath;
}

// Send an audio file to AudD via raw Node.js HTTPS — no curl, no redirects.
// curl -F silently converts to GET on 301 redirects (dropping the body), which
// is what api.audd.io does. https.request sends directly to the IP, no redirect.
// Returns { title, artist } or null if no song recognized.
async function recognizeWithAudd(audioPath, apiToken) {
  const boundary = crypto.randomBytes(16).toString("hex");
  const CRLF = "\r\n";

  const fileData = fs.readFileSync(audioPath);
  const fileName = path.basename(audioPath);
  const fileSize = fileData.length;
  console.log(`[audd] uploading ${fileName} (${fileSize} bytes)`);

  // Skip near-empty files — ffmpeg at end-of-stream produces ~227 bytes (headers only)
  // AudD returns error_code 300 for these, which pollutes logs and wastes a credit
  if (fileSize < 2000) {
    console.log(`[audd] skipping ${fileName} — too small, likely empty segment`);
    return null;
  }

  const headerBuf = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="api_token"${CRLF}${CRLF}` +
    `${apiToken}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
    `Content-Type: audio/mpeg${CRLF}${CRLF}`
  );
  const footerBuf = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([headerBuf, fileData, footerBuf]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.audd.io",
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      console.log(`[audd] HTTP ${res.statusCode}`);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        console.log(`[audd-body] ${raw.slice(0, 400)}`);
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { return reject(new Error(`AudD non-JSON response: ${raw.slice(0, 200)}`)); }

        if (data.status === "error") {
          return reject(new Error(`AudD error: ${data.error?.error_message || JSON.stringify(data.error)}`));
        }
        if (data.status === "success" && data.result) {
          return resolve({
            title: data.result.title,
            artist: data.result.artist,
            album: data.result.album,
            timecode: data.result.timecode,
            label: data.result.label,
            song_link: data.result.song_link,
          });
        }
        resolve(null);
      });
    });
    req.on("error", (e) => {
      console.error(`[audd-error] ${e.message}`);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

module.exports = { getFingerprintFromFile, resolveStreamUrl, downloadSegment, recognizeWithAudd };
