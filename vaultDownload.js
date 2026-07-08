// vaultDownload.js — yt-dlp full-video download + ffprobe validation for Vault backups.
// Reuses the same cookie/proxy plumbing as fingerprint.js's resolveStreamUrl, but
// downloads the actual file at the highest available quality instead of resolving
// a stream URL for ffmpeg to sample a few seconds from — the audio-fingerprinting
// use case and the archive-master use case want very different tradeoffs, so this
// intentionally does NOT reuse fingerprint.js's player_client restriction.
//
// IMPORTANT LIMITATION: yt-dlp can only retrieve the best version YouTube itself
// is willing to serve — YouTube re-encodes every video it hosts and does not
// expose the creator's original upload master through any API or download path.
// "Highest available quality" here means the best of YouTube's own processed
// renditions (up to and including 4K/HDR/high-bitrate when YouTube has them),
// NOT a guarantee of pixel-identical restoration of the file the creator
// originally uploaded. True original-file recovery is only possible via the
// creator's own Google Takeout export (see the separate, unimplemented
// google_takeout_import path) — this module can never substitute for that.
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

const FORMAT_PRINT_PREFIX = "VAULTFMT|";
// One line per stream yt-dlp decides to download (2 lines when it has to merge
// separate video+audio, 1 line for an already-combined format).
const FORMAT_PRINT_TEMPLATE =
  `before_dl:${FORMAT_PRINT_PREFIX}%(format_id)s|%(width)s|%(height)s|%(vcodec)s|%(acodec)s|` +
  `%(vbr)s|%(abr)s|%(tbr)s|%(dynamic_range)s|%(ext)s|%(fps)s`;

function parseSelectedFormats(stdout) {
  const lines = String(stdout || "").split("\n").filter((l) => l.startsWith(FORMAT_PRINT_PREFIX));
  return lines.map((line) => {
    const [formatId, width, height, vcodec, acodec, vbr, abr, tbr, dynamicRange, ext, fps] =
      line.slice(FORMAT_PRINT_PREFIX.length).split("|");
    return { formatId, width, height, vcodec, acodec, vbr, abr, tbr, dynamicRange, ext, fps };
  });
}

// Downloads the best available video into tmpDir as "original.<ext>" — genuinely
// the best yt-dlp can see, not capped to mp4 (YouTube's 1440p/4K/HDR formats are
// commonly VP9/AV1-in-webm only; filtering to ext=mp4 silently excludes them).
// Merges to mkv (not mp4) when video/audio are separate streams, since mkv can
// losslessly hold any codec combination without a transcode — mp4 can't always.
// player_client includes "web" first for the fullest format catalog; the other
// clients (same ones fingerprint.js uses) stay as a resilience fallback if web
// is blocked. Returns the selected format metadata alongside the file so callers
// can log exactly what was chosen.
function downloadFullVideo(videoUrl, tmpDir, { timeoutMs = 3600000 } = {}) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(tmpDir, "original.%(ext)s");
    const cookiePath = writeCookiesFile();

    const args = [
      "--no-playlist",
      "-f", "bestvideo+bestaudio/best",
      "--merge-output-format", "mkv",
      "--extractor-args", "youtube:player_client=web,mweb,tv_embedded,ios,android",
      "--print", FORMAT_PRINT_TEMPLATE,
      "-o", outputTemplate,
    ];
    if (cookiePath) args.push("--cookies", cookiePath);
    if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
    args.push(videoUrl);

    execFile("yt-dlp", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, env: ytDlpEnv() }, (err, stdout, stderr) => {
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
      const ext = path.extname(files[0]).replace(".", "") || "mkv";
      const size = fs.statSync(filePath).size;
      if (size === 0) {
        reject(new Error("yt-dlp produced an empty file"));
        return;
      }
      resolve({ filePath, ext, size, selectedFormats: parseSelectedFormats(stdout) });
    });
  });
}

function hdrLabel(colorTransfer) {
  if (!colorTransfer) return "unknown";
  if (colorTransfer === "smpte2084") return "HDR10 (PQ)";
  if (colorTransfer === "arib-std-b67") return "HLG (HDR)";
  if (colorTransfer === "bt709" || colorTransfer === "bt470bg" || colorTransfer === "smpte170m") return "SDR";
  return colorTransfer;
}

// ffprobe reads only container/stream metadata, not the whole file — cheap even
// for large videos. Confirms the download is a real, readable video with a
// positive duration, and reports the FINAL merged resolution/codec/HDR — this is
// the ground truth for what actually ended up in the file, independent of what
// yt-dlp intended to select.
function validateVideoFile(filePath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name,bit_rate,color_transfer",
      "-show_entries", "format=duration,bit_rate",
      "-of", "json",
      filePath,
    ];
    execFile("ffprobe", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${(stderr || err.message || "").slice(0, 300)}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        reject(new Error(`ffprobe produced unparseable output: ${e.message}`));
        return;
      }
      const duration = parseFloat(parsed.format?.duration);
      if (!duration || duration <= 0) {
        reject(new Error(`ffprobe reported invalid duration: "${parsed.format?.duration}"`));
        return;
      }
      const stream = (parsed.streams && parsed.streams[0]) || {};
      resolve({
        durationSec: duration,
        width: stream.width ?? null,
        height: stream.height ?? null,
        videoCodec: stream.codec_name ?? null,
        bitrateBps: parseInt(stream.bit_rate || parsed.format?.bit_rate, 10) || null,
        dynamicRange: hdrLabel(stream.color_transfer),
      });
    });
  });
}

module.exports = { downloadFullVideo, validateVideoFile };
