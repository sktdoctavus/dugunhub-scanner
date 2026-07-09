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
  const cookiePath = path.join(os.tmpdir(), `vault_yt_cookies_${process.pid}_${Date.now()}.txt`);
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

const PLAYER_CLIENTS = "web,mweb,tv_embedded,ios,android";

function baseClientArgs(cookiePath) {
  const args = [
    "--no-playlist",
    "--extractor-args", `youtube:player_client=${PLAYER_CLIENTS}`,
  ];
  if (cookiePath) args.push("--cookies", cookiePath);
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  return args;
}

// Redacts embedded proxy credentials (http://user:pass@host) before a command
// is logged. Cookie file paths are fine to show as-is — only the file's
// contents are sensitive, and we never print those.
function redactForLog(args) {
  return args.map((a) => {
    if (typeof a !== "string") return a;
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/i.test(a)) return a.replace(/\/\/[^@]+@/, "//<redacted>@");
    return a;
  });
}

function safeCommandString(args) {
  return ["yt-dlp", ...redactForLog(args)].join(" ");
}

function runVersionCheck(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ available: false, version: null, error: (stderr || err.message || "").slice(0, 200) });
      } else {
        resolve({ available: true, version: String(stdout || stderr || "").trim().split("\n")[0] });
      }
    });
  });
}

// Checked once per real transfer attempt (cheap, sub-second each) so every
// item's processing log carries direct proof of what was actually available
// in the running container — not an assumption from reading the Dockerfile.
async function checkTooling({ timeoutMs = 10000 } = {}) {
  const [ffmpeg, ffprobe, ytDlp] = await Promise.all([
    runVersionCheck("ffmpeg", ["-version"], timeoutMs),
    runVersionCheck("ffprobe", ["-version"], timeoutMs),
    runVersionCheck("yt-dlp", ["--version"], timeoutMs),
  ]);
  return { ffmpeg, ffprobe, ytDlp };
}

// Fetches the full format list yt-dlp can currently see for this video (via
// -j / --dump-json, no media downloaded) using the EXACT same client/cookie/
// proxy configuration the real download will use — this is ground truth for
// "was 1440p even visible to us," independent of what format selector we
// then apply. A failure here is informational only; the real download is
// still attempted.
function listAvailableFormats(videoUrl, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const cookiePath = writeCookiesFile();
    const args = [...baseClientArgs(cookiePath), "-j", "--no-warnings", videoUrl];
    const safeCommand = safeCommandString(args);
    execFile("yt-dlp", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 20, env: ytDlpEnv() }, (err, stdout, stderr) => {
      if (cookiePath) fs.unlink(cookiePath, () => {});
      if (err) {
        resolve({ ok: false, safeCommand, error: (stderr || err.message || "").slice(0, 500), formats: [] });
        return;
      }
      try {
        const info = JSON.parse(stdout);
        resolve({ ok: true, safeCommand, formats: info.formats || [] });
      } catch (e) {
        resolve({ ok: false, safeCommand, error: `unparseable JSON: ${e.message}`, formats: [] });
      }
    });
  });
}

// Collapses a raw yt-dlp format list into a compact, loggable summary: the
// best (highest tbr) format at each of the top resolutions, plus the best
// audio-only format. Directly answers "were higher resolutions even in the
// list" and "were we filtering out webm/VP9/AV1" without dumping the full
// (often 50+ entry) raw array into the logs.
function summarizeFormats(formats) {
  const video = formats.filter((f) => f.vcodec && f.vcodec !== "none");
  const audio = formats.filter((f) => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none");

  const bestPerHeight = new Map();
  for (const f of video) {
    const h = f.height || 0;
    const existing = bestPerHeight.get(h);
    if (!existing || (f.tbr || 0) > (existing.tbr || 0)) bestPerHeight.set(h, f);
  }
  const topVideo = [...bestPerHeight.values()]
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .slice(0, 10)
    .map((f) => `${f.height || "?"}p(id=${f.format_id},${f.vcodec},${f.ext},tbr=${Math.round(f.tbr || 0)}${f.dynamic_range && f.dynamic_range !== "SDR" ? `,${f.dynamic_range}` : ""})`)
    .join(" ");

  const bestAudio = [...audio].sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const audioSummary = bestAudio
    ? `id=${bestAudio.format_id},${bestAudio.acodec},${bestAudio.ext},abr=${Math.round(bestAudio.abr || bestAudio.tbr || 0)}`
    : "(none)";

  const bestHeight = video.reduce((max, f) => Math.max(max, f.height || 0), 0);

  return {
    text: `video formats (top by resolution): ${topVideo || "(none)"} | best audio: ${audioSummary}`,
    bestHeight,
    videoFormatCount: video.length,
    audioFormatCount: audio.length,
  };
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
// is blocked. Before downloading, checks tool availability and the real
// available-format list so callers can prove (or disprove) that a given
// quality was ever reachable, not just log what we intended to select.
async function downloadFullVideo(videoUrl, tmpDir, { timeoutMs = 3600000 } = {}) {
  const tooling = await checkTooling();
  const preflight = await listAvailableFormats(videoUrl);
  const preflightSummary = preflight.ok ? summarizeFormats(preflight.formats) : null;

  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(tmpDir, "original.%(ext)s");
    const cookiePath = writeCookiesFile();

    const args = [
      ...baseClientArgs(cookiePath),
      "-f", "bestvideo+bestaudio/best",
      "--merge-output-format", "mkv",
      "--print", FORMAT_PRINT_TEMPLATE,
      "-o", outputTemplate,
      videoUrl,
    ];
    const safeCommand = safeCommandString(args);

    execFile("yt-dlp", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, env: ytDlpEnv() }, (err, stdout, stderr) => {
      if (cookiePath) fs.unlink(cookiePath, () => {});
      if (err) {
        reject(Object.assign(new Error(`yt-dlp failed: ${(stderr || err.message || "").slice(0, 500)}`), {
          tooling, preflight, preflightSummary, safeCommand,
        }));
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
      const selectedFormats = parseSelectedFormats(stdout);
      resolve({
        filePath, ext, size, selectedFormats,
        mergeHappened: selectedFormats.length > 1,
        tooling, preflight, preflightSummary, safeCommand,
      });
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
// yt-dlp intended to select. This is the check that must run and be logged
// BEFORE any upload to B2/Bunny, per the Vault acceptance test.
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

module.exports = { downloadFullVideo, validateVideoFile, checkTooling, listAvailableFormats, summarizeFormats };
