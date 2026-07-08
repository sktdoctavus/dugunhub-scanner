// vaultDownload.js — yt-dlp full-video download + ffprobe validation for Vault backups.
// Reuses the same YouTube-blocking mitigations (player client fallback list,
// cookies, residential proxy) as fingerprint.js's resolveStreamUrl, but downloads
// the actual file instead of resolving a stream URL for ffmpeg to sample from.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function ytDlpEnv() {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  return env;
}

function writeCookiesFile() {
  const rawCookies = process.env.YTDLP_COOKIES || process.env.YTDLP_COOKIES_B64;
  if (!rawCookies) return null;
  const cookiePath = path.join(os.tmpdir(), `vault_yt_cookies_${process.pid}.txt`);
  try {
    const content = rawCookies.trimStart().startsWith("#")
      ? rawCookies
      : Buffer.from(rawCookies, "base64").toString("utf8");
    fs.writeFileSync(cookiePath, content);
    return cookiePath;
  } catch {
    return null;
  }
}

// Downloads the best available video into tmpDir as "original.<ext>", preferring
// a native mp4. When yt-dlp has to merge separate video/audio streams it uses
// ffmpeg to mux them — that's a container remux, not a re-encode/transcode.
function downloadFullVideo(videoUrl, tmpDir, { timeoutMs = 3600000 } = {}) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(tmpDir, "original.%(ext)s");
    const cookiePath = writeCookiesFile();

    const args = [
      "--no-playlist",
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--extractor-args", "youtube:player_client=mweb,ios,tv_embedded,android",
      "-o", outputTemplate,
    ];
    if (cookiePath) args.push("--cookies", cookiePath);
    if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
    args.push(videoUrl);

    execFile("yt-dlp", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, env: ytDlpEnv() }, (err, _stdout, stderr) => {
      if (cookiePath) fs.unlink(cookiePath, () => {});
      if (err) {
        reject(new Error(`yt-dlp failed: ${(stderr || err.message || "").slice(0, 500)}`));
        return;
      }
      let files;
      try {
        files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("original."));
      } catch (e) {
        reject(new Error(`could not read tmp dir after download: ${e.message}`));
        return;
      }
      if (files.length === 0) {
        reject(new Error("yt-dlp reported success but no output file was found"));
        return;
      }
      const filePath = path.join(tmpDir, files[0]);
      const ext = path.extname(files[0]).replace(".", "") || "mp4";
      const size = fs.statSync(filePath).size;
      if (size === 0) {
        reject(new Error("yt-dlp produced an empty file"));
        return;
      }
      resolve({ filePath, ext, size });
    });
  });
}

// ffprobe reads only container/stream metadata, not the whole file — cheap even
// for large videos. Confirms the download is a real, readable video with a
// positive duration before we trust it enough to upload or call it "ready."
function validateVideoFile(filePath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath];
    execFile("ffprobe", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${(stderr || err.message || "").slice(0, 300)}`));
        return;
      }
      const duration = parseFloat(String(stdout).trim());
      if (!duration || duration <= 0) {
        reject(new Error(`ffprobe reported invalid duration: "${String(stdout).trim()}"`));
        return;
      }
      resolve({ durationSec: duration });
    });
  });
}

module.exports = { downloadFullVideo, validateVideoFile };
