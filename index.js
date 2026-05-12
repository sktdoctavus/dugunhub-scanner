const express = require("express");
const { processJob, resolveYouTubeUrl, fingerprintDangerSong, debugMatch } = require("./scanner");
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

// Extract fingerprint for a danger_song — fire-and-forget, updates DB when done
app.post("/fingerprint-song", auth, async (req, res) => {
  const { songId } = req.body;
  if (!songId) return res.status(400).json({ error: "songId required" });

  res.json({ status: "accepted", songId });

  fingerprintDangerSong(songId).catch((e) => {
    console.error(`Fingerprint job for ${songId} failed:`, e.message);
    // Mark fingerprint as failed via a sentinel value so admin knows
    supabase.from("danger_songs")
      .update({ notes: `Fingerprint error: ${e.message}` })
      .eq("id", songId)
      .then(() => {});
  });
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

// Write YouTube cookies to disk at startup so yt-dlp can authenticate
if (process.env.YOUTUBE_COOKIES) {
  const fs = require("fs");
  fs.writeFileSync("/tmp/yt-cookies.txt", process.env.YOUTUBE_COOKIES);
  console.log("[startup] YouTube cookies written to /tmp/yt-cookies.txt");
} else {
  console.warn("[startup] YOUTUBE_COOKIES env var not set — YouTube bot detection may block downloads");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DüğünHub scanner worker listening on port ${PORT}`);
});
