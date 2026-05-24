const express = require("express");
const { processJob, resolveYouTubeUrl, fingerprintDangerSong, debugMatch, resolveChannelUrl, ytMetaScan, monitorUserChannel } = require("./scanner");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const WORKER_SECRET = process.env.WORKER_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Auth middleware — Supabase edge function sends this secret
function auth(req, res, next) {
  if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Preview endpoint: resolve YouTube URL and return video list + total hours
// Called before scan to show user what they're about to scan
app.post("/preview", auth, async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "youtubeUrl required" });

  try {
    const videos = await resolveYouTubeUrl(youtubeUrl);
    const totalHours = videos.reduce((sum, v) => sum + v.durationSec / 3600, 0);
    res.json({
      videos: videos.map((v) => ({ id: v.id, title: v.title, durationSec: v.durationSec })),
      totalVideos: videos.length,
      totalHours: Math.round(totalHours * 10) / 10,
      estimatedMinutes: Math.round(totalHours * 2 + videos.length * 0.33),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Fingerprint queue — caps concurrent DB+yt-dlp+ffmpeg jobs at FP_CONCURRENCY
// regardless of how many /fingerprint-song requests arrive at once.
let fpRunning = 0;
const FP_CONCURRENCY = 1;
const fpQueue = [];
const fpQueued = new Set(); // deduplicate: ignore re-queued songs already waiting

function processFpQueue() {
  while (fpRunning < FP_CONCURRENCY && fpQueue.length > 0) {
    const songId = fpQueue.shift();
    fpQueued.delete(songId);
    fpRunning++;
    console.log(`[fp-queue] starting ${songId} (running=${fpRunning} queued=${fpQueue.length})`);
    fingerprintDangerSong(songId)
      .catch((e) => {
        console.error(`Fingerprint job for ${songId} failed:`, e.message);
        supabase.from("danger_songs")
          .update({ notes: `Fingerprint error: ${e.message}` })
          .eq("id", songId)
          .then(() => {});
      })
      .finally(() => {
        fpRunning--;
        processFpQueue();
      });
  }
}

// Extract fingerprint for a danger_song — queued, updates DB when done
app.post("/fingerprint-song", auth, async (req, res) => {
  const { songId } = req.body;
  if (!songId) return res.status(400).json({ error: "songId required" });

  res.json({ status: "accepted", songId, queued: fpQueue.length, running: fpRunning });

  if (!fpQueued.has(songId)) {
    fpQueue.push(songId);
    fpQueued.add(songId);
    processFpQueue();
  }
});

// Debug: compare a YouTube URL against all danger songs synchronously, returns raw scores
app.post("/debug-match", auth, async (req, res) => {
  const { youtubeUrl, startSec = 0 } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "youtubeUrl required" });
  try {
    const result = await debugMatch(youtubeUrl, startSec);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List videos from a YouTube channel — paginated, 50 per page
// Returns { videos: [{id, title, durationSec, channelTitle, channelId}], nextPageToken }
app.post("/channel-videos", auth, async (req, res) => {
  const { channelUrl, pageToken } = req.body;
  if (!channelUrl) return res.status(400).json({ error: "channelUrl required" });

  try {
    const { uploadsPlaylistId, channelTitle, channelId } = await resolveChannelUrl(channelUrl);

    const itemsRes = await axios.get("https://www.googleapis.com/youtube/v3/playlistItems", {
      params: {
        part: "contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken: pageToken || undefined,
        key: process.env.YOUTUBE_API_KEY,
      },
    });

    const videoIds = itemsRes.data.items.map((i) => i.contentDetails.videoId);
    const detailsRes = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: {
        part: "contentDetails,snippet",
        id: videoIds.join(","),
        key: process.env.YOUTUBE_API_KEY,
      },
    });

    const videos = detailsRes.data.items
      .map((v) => ({
        id: v.id,
        title: v.snippet.title,
        durationSec: parseDurationISO(v.contentDetails.duration),
        channelTitle: v.snippet.channelTitle || channelTitle,
        channelId: v.snippet.channelId || channelId,
      }))
      .filter((v) => v.durationSec > 60); // exclude Shorts (≤ 60s)

    res.json({
      videos,
      channelTitle,
      channelId,
      nextPageToken: itemsRes.data.nextPageToken || null,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function parseDurationISO(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// YouTube metadata scan: extract Content ID music data from a video/channel/playlist
// and compare against danger_songs. No audio download, no AudD — near-zero cost.
app.post("/yt-meta-scan", auth, async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "youtubeUrl required" });
  try {
    const result = await ytMetaScan(youtubeUrl);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Monitor a user's YouTube channel for new dangerous songs — fire-and-forget
app.post("/channel-monitor", auth, async (req, res) => {
  const { userId, fingerprint = false } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  res.json({ status: "accepted", userId, fingerprint });
  monitorUserChannel(userId, { fingerprint }).catch((e) => console.error(`Channel monitor ${userId} failed:`, e.message));
});

// Start a scan job — job must already exist in Supabase scan_jobs table
app.post("/scan", auth, async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  // Acknowledge immediately, process in background
  res.json({ status: "accepted", jobId });

  // Don't await — runs in background
  processJob(jobId).catch((e) => {
    console.error(`Job ${jobId} crashed:`, e);
  });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DüğünHub scanner worker listening on port ${PORT}`);
  console.log(`[config] AUDD_API_TOKEN set: ${!!process.env.AUDD_API_TOKEN}`);
  console.log(`[config] YTDLP_PROXY set: ${!!process.env.YTDLP_PROXY}`);
});
