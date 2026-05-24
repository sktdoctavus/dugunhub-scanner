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
    // mweb + ios don't require PO tokens on most datacenter IPs; fall back to others
    "--extractor-args", "youtube:player_client=mweb,ios,tv_embedded,android",
  ];

  // Optional YouTube cookies — set YTDLP_COOKIES in Railway to the raw Netscape-format
  // cookies.txt content exported from your browser (paste as-is, no base64 needed).
  const rawCookies = process.env.YTDLP_COOKIES || process.env.YTDLP_COOKIES_B64;
  if (rawCookies) {
    const cookiePath = path.join(os.tmpdir(), "yt_cookies.txt");
    try {
      // Accept either raw Netscape format or legacy base64-encoded format
      const content = rawCookies.trimStart().startsWith("#")
        ? rawCookies
        : Buffer.from(rawCookies, "base64").toString("utf8");
      fs.writeFileSync(cookiePath, content);
      ytArgs.push("--cookies", cookiePath);
      console.log("[yt-dlp] using cookies file");
    } catch (_) { /* ignore */ }
  }

  // Explicitly set proxy to disable any system HTTP_PROXY/HTTPS_PROXY env vars
  // that Railway may inject — yt-dlp (Python urllib) picks these up automatically.
  // If YTDLP_PROXY is set, use it; otherwise force no proxy with empty string.
  ytArgs.push("--proxy", process.env.YTDLP_PROXY || "");
  ytArgs.push(videoUrl);

  const result = spawnSync("yt-dlp", ytArgs, { timeout: 60000, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(
      `yt-dlp -g failed (exit ${result.status}): ${(result.stderr || "").slice(0, 400)}`
    );
  }
  return result.stdout.trim().split("\n")[0];
}

// Download one audio segment (or the full stream) from an already-resolved CDN stream URL.
// Pass durationSec=null to download the entire file from startSec to end.
async function downloadSegment(streamUrl, startSec, durationSec, tmpDir) {
  const label = durationSec == null ? "full" : String(durationSec) + "s";
  const flacPath = path.join(tmpDir, `seg_${startSec}_${label}.mp3`);

  const ffArgs = ["-ss", String(startSec)];
  if (durationSec != null) ffArgs.push("-t", String(durationSec));
  if (process.env.YTDLP_PROXY) ffArgs.push("-http_proxy", process.env.YTDLP_PROXY);
  ffArgs.push(
    "-i", streamUrl,
    "-ac", "1",
    "-ar", "22050",
    "-c:a", "libmp3lame",
    "-q:a", "5",
    "-y", flacPath,
  );

  // Full-file downloads can take much longer — allow 30 minutes
  const timeoutMs = durationSec == null ? 1800000 : 120000;

  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ffArgs, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[ffmpeg] @${startSec}s failed: ${(stderr || err.message).slice(0, 400)}`);
        reject(new Error(stderr || err.message));
      } else {
        const size = fs.existsSync(flacPath) ? fs.statSync(flacPath).size : 0;
        console.log(`[ffmpeg] @${startSec}s (${label}) → mp3 (${size} bytes)`);
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
          // error_code 902 = monthly recognition limit exhausted
          if (data.error?.error_code === 902) {
            const err = new Error("AudD recognition limit reached");
            err.code = "AUDD_RATE_LIMIT";
            return reject(err);
          }
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
