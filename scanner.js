const { createClient } = require("@supabase/supabase-js");
const { fingerprintVideo, compareFingerprints } = require("./fingerprint");
const { execSync } = require("child_process");
const axios = require("axios");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const MATCH_THRESHOLD = 0.65; // score above this = match
const DELAY_BETWEEN_VIDEOS_MS = 20000; // 20s delay between videos to avoid YouTube blocking
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300000; // 5 minutes on block

// Fetch all video IDs + durations from a YouTube playlist or single video URL
async function resolveYouTubeUrl(url) {
  const videoMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const playlistMatch = url.match(/[?&]list=([A-Za-z0-9_-]+)/);

  if (playlistMatch) {
    return await fetchPlaylistVideos(playlistMatch[1]);
  } else if (videoMatch) {
    const video = await fetchVideoDetails([videoMatch[1]]);
    return video;
  }
  throw new Error("Invalid YouTube URL");
}

async function fetchPlaylistVideos(playlistId) {
  const videos = [];
  let pageToken = "";

  do {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/playlistItems", {
      params: {
        part: "contentDetails",
        playlistId,
        maxResults: 50,
        pageToken: pageToken || undefined,
        key: YOUTUBE_API_KEY,
      },
    });
    const ids = res.data.items.map((i) => i.contentDetails.videoId);
    const details = await fetchVideoDetails(ids);
    videos.push(...details);
    pageToken = res.data.nextPageToken || "";
  } while (pageToken);

  return videos;
}

async function fetchVideoDetails(videoIds) {
  const res = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
    params: {
      part: "contentDetails,snippet",
      id: videoIds.join(","),
      key: YOUTUBE_API_KEY,
    },
  });
  return res.data.items.map((v) => ({
    id: v.id,
    title: v.snippet.title,
    durationSec: parseDuration(v.contentDetails.duration),
    url: `https://www.youtube.com/watch?v=${v.id}`,
  }));
}

// ISO 8601 duration (PT1H30M15S) → seconds
function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// Load all approved danger songs with their fingerprints from Supabase
async function loadDangerSongs() {
  const { data, error } = await supabase
    .from("danger_songs")
    .select("id, title, artist, claimant, fingerprint")
    .eq("approved", true)
    .not("fingerprint", "is", null);

  if (error) throw new Error(`Failed to load danger songs: ${error.message}`);
  return data || [];
}

// Compare video samples against all danger songs, return matches
function findMatches(samples, dangerSongs) {
  const matches = [];
  for (const song of dangerSongs) {
    if (!song.fingerprint) continue;
    for (const sample of samples) {
      if (!sample.fingerprint) continue;
      const score = compareFingerprints(sample.fingerprint, song.fingerprint);
      if (score >= MATCH_THRESHOLD) {
        matches.push({
          song_id: song.id,
          song_title: song.title,
          song_artist: song.artist,
          claimant: song.claimant,
          detected_at_sec: sample.startSec,
          score: Math.round(score * 100),
        });
        break; // one match per song per video is enough
      }
    }
  }
  return matches;
}

// Process a single video with retry on YouTube block
async function processVideo(video, dangerSongs, attempt = 1) {
  try {
    const samples = await fingerprintVideo(video.url, video.durationSec);
    const validSamples = samples.filter((s) => s.fingerprint);
    const matches = findMatches(validSamples, dangerSongs);
    return { status: "done", matches, samplesChecked: validSamples.length };
  } catch (e) {
    const blocked = e.message.includes("429") || e.message.includes("blocked") || e.message.includes("HTTP Error 403");
    if (blocked && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return processVideo(video, dangerSongs, attempt + 1);
    }
    return { status: "failed", error: e.message, matches: [] };
  }
}

// Main scan job processor
async function processJob(jobId) {
  // Mark job as running
  await supabase.from("scan_jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", jobId);

  try {
    const { data: job } = await supabase.from("scan_jobs").select("*").eq("id", jobId).single();
    if (!job) throw new Error("Job not found");

    const videos = await resolveYouTubeUrl(job.youtube_url);
    const totalDurationHours = videos.reduce((sum, v) => sum + v.durationSec / 3600, 0);

    await supabase.from("scan_jobs").update({
      total_videos: videos.length,
      total_hours: Math.round(totalDurationHours * 10) / 10,
    }).eq("id", jobId);

    // Deduct credits (hours) from user's scan balance
    await supabase.rpc("deduct_scan_hours", {
      p_user_id: job.user_id,
      p_hours: totalDurationHours,
    });

    const dangerSongs = await loadDangerSongs();
    const results = [];

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      // Show which video is currently being processed
      await supabase.from("scan_jobs").update({
        progress_title: video.title,
      }).eq("id", jobId);

      const result = await processVideo(video, dangerSongs);

      // Update progress count after video is done
      await supabase.from("scan_jobs").update({
        progress_video: i + 1,
      }).eq("id", jobId);

      results.push({
        video_id: video.id,
        video_title: video.title,
        video_url: video.url,
        duration_sec: video.durationSec,
        status: result.status,
        matches: result.matches,
        error: result.error || null,
      });

      // Delay between videos to avoid YouTube blocking
      if (i < videos.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_VIDEOS_MS));
      }
    }

    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

    await supabase.from("scan_jobs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      results,
      total_matches: totalMatches,
    }).eq("id", jobId);

  } catch (e) {
    await supabase.from("scan_jobs").update({
      status: "failed",
      error: e.message,
      completed_at: new Date().toISOString(),
    }).eq("id", jobId);
  }
}

// Extract and store fingerprint for a danger_song entry
// source: { type: "youtube", url } | { type: "storage_path", path }
async function fingerprintDangerSong(songId) {
  const { data: song, error } = await supabase
    .from("danger_songs")
    .select("id, title, notes, submission_id")
    .eq("id", songId)
    .single();
  if (error || !song) throw new Error(`Song not found: ${error?.message}`);

  // Derive source: prefer YouTube URL from notes, fallback to submission audio_url
  let youtubeUrl = null;
  if (song.notes) {
    const match = song.notes.match(/YouTube:\s*(https?:\/\/\S+)/);
    if (match) youtubeUrl = match[1];
  }

  if (!youtubeUrl && song.submission_id) {
    const { data: sub } = await supabase
      .from("song_submissions")
      .select("youtube_url, audio_url")
      .eq("id", song.submission_id)
      .single();
    if (sub?.youtube_url) youtubeUrl = sub.youtube_url;
  }

  if (!youtubeUrl) throw new Error("No YouTube URL found for this song — upload an audio file or provide a YouTube link.");

  // Download first 3 minutes of the song for a reliable fingerprint
  const tmpDir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dh-song-"));
  const outPath = require("path").join(tmpDir, "song.mp3");
  try {
    const { exec } = require("child_process");
    await new Promise((resolve, reject) => {
      const cmd = [
        "yt-dlp", "--no-playlist", "--extract-audio",
        "--audio-format mp3", "--audio-quality 5",
        `--download-sections "*0-180"`,
        "-o", `"${outPath}"`,
        `"${youtubeUrl}"`,
      ].join(" ");
      exec(cmd, { timeout: 120000 }, (err, _, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    const { getFingerprintFromFile } = require("./fingerprint");
    const { fingerprint } = getFingerprintFromFile(outPath);

    await supabase.from("danger_songs").update({
      fingerprint,
      approved_at: new Date().toISOString(),
    }).eq("id", songId);

    return { success: true, fingerprintLength: fingerprint.length };
  } finally {
    try { require("fs").rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

module.exports = { processJob, resolveYouTubeUrl, fingerprintDangerSong };
