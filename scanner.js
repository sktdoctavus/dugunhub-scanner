const { createClient } = require("@supabase/supabase-js");
const { getFingerprintFromFile, resolveStreamUrl, downloadSegment, recognizeWithAudd } = require("./fingerprint");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const AUDD_API_TOKEN = process.env.AUDD_API_TOKEN;
const DELAY_BETWEEN_VIDEOS_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300000;

// Interval between audio samples — 120s catches any song longer than 2 minutes
const SAMPLE_INTERVAL_SEC = 120;
// Duration of each audio clip sent to AudD — 15s is optimal for their standard endpoint
const SAMPLE_DURATION_SEC = 15;

// Fetch all video IDs + durations from a YouTube playlist or single video URL
async function resolveYouTubeUrl(url) {
  const videoMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const playlistMatch = url.match(/[?&]list=([A-Za-z0-9_-]+)/);

  // RD/WL/LL/FL prefixes are auto-generated YouTube mixes — not real playlists,
  // the playlistItems API returns nothing useful for them. Treat as single video.
  const isAutoPlaylist = playlistMatch && /^(RD|WL|LL|FL|OLAK)/.test(playlistMatch[1]);

  if (playlistMatch && !isAutoPlaylist) {
    return await fetchPlaylistVideos(playlistMatch[1]);
  } else if (videoMatch) {
    return await fetchVideoDetails([videoMatch[1]]);
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

// Load all approved danger songs from Supabase (no fingerprint required — AudD matches by title/artist)
async function loadDangerSongs() {
  const { data, error } = await supabase
    .from("danger_songs")
    .select("id, title, artist, claimant")
    .eq("approved", true);

  if (error) throw new Error(`Failed to load danger songs: ${error.message}`);
  return data || [];
}

// Normalize a string for fuzzy comparison: lowercase, strip diacritics and punctuation
function normalize(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Check if an AudD recognition result matches any danger song by title
function matchesDangerSong(recognition, dangerSongs) {
  if (!recognition?.title) return null;
  const recTitle = normalize(recognition.title);

  for (const song of dangerSongs) {
    const songTitle = normalize(song.title);
    if (recTitle === songTitle ||
        recTitle.includes(songTitle) ||
        songTitle.includes(recTitle)) {
      return song;
    }
  }
  return null;
}

// Scan a single video with AudD — downloads 15s clips every 120s and recognizes each
async function processVideo(video, dangerSongs, attempt = 1) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dugunhub-"));

  try {
    let streamUrl;
    try {
      console.log(`[yt-dlp] resolving stream URL for "${video.title}"...`);
      streamUrl = resolveStreamUrl(video.url);
      console.log(`[yt-dlp] stream URL resolved`);
    } catch (e) {
      const blocked = e.message.includes("429") || e.message.includes("blocked") || e.message.includes("HTTP Error 403");
      if (blocked && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        return processVideo(video, dangerSongs, attempt + 1);
      }
      return { status: "failed", error: e.message, matches: [] };
    }

    const matches = [];
    const matchedSongIds = new Set();
    const recognizedSongs = []; // every song AudD found, danger or not
    let samplesChecked = 0;

    for (let start = 0; start < video.durationSec; start += SAMPLE_INTERVAL_SEC) {
      const duration = Math.min(SAMPLE_DURATION_SEC, video.durationSec - start);
      if (duration < 5) break;

      let audioPath;
      try {
        audioPath = await downloadSegment(streamUrl, start, duration, tmpDir);
        const recognition = await recognizeWithAudd(audioPath, AUDD_API_TOKEN);
        samplesChecked++;

        if (recognition) {
          console.log(`[audd] @${start}s: "${recognition.title}" by ${recognition.artist}`);
          recognizedSongs.push({
            at_sec: start,
            title: recognition.title,
            artist: recognition.artist,
          });
          const dangerSong = matchesDangerSong(recognition, dangerSongs);
          if (dangerSong && !matchedSongIds.has(dangerSong.id)) {
            matchedSongIds.add(dangerSong.id);
            console.log(`[audd] MATCH: "${dangerSong.title}" at ${start}s`);
            matches.push({
              song_id: dangerSong.id,
              song_title: dangerSong.title,
              song_artist: dangerSong.artist,
              claimant: dangerSong.claimant,
              detected_at_sec: start,
              score: 100,
              audd_title: recognition.title,
              audd_artist: recognition.artist,
            });
          }
        } else {
          console.log(`[audd] @${start}s: no match`);
        }
      } catch (e) {
        console.error(`[audd] @${start}s FAILED: ${e.message.slice(0, 500)}`);
      } finally {
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      }
    }

    return { status: "done", matches, recognizedSongs, samplesChecked };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Main scan job processor
async function processJob(jobId) {
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

      await supabase.from("scan_jobs").update({ progress_title: video.title }).eq("id", jobId);

      const result = await processVideo(video, dangerSongs);

      await supabase.from("scan_jobs").update({ progress_video: i + 1 }).eq("id", jobId);

      results.push({
        video_id: video.id,
        video_title: video.title,
        video_url: video.url,
        duration_sec: video.durationSec,
        status: result.status,
        matches: result.matches,
        recognized_songs: result.recognizedSongs || [],
        error: result.error || null,
      });

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

// Extract and store chromaprint fingerprint for a danger_song from its uploaded audio file.
// The fingerprint is kept for historical reference; AudD title/artist matching is now used for scanning.
async function fingerprintDangerSong(songId) {
  const setNote = (msg) => supabase.from("danger_songs").update({ notes: `[fp] ${msg}` }).eq("id", songId).then(() => {});

  await setNote("started");

  const { data: song, error } = await supabase
    .from("danger_songs")
    .select("id, title, submission_id")
    .eq("id", songId)
    .single();
  if (error || !song) throw new Error(`Song not found: ${error?.message}`);
  if (!song.submission_id) throw new Error("No submission linked to this song.");

  await setNote("fetching submission");

  const { data: sub } = await supabase
    .from("song_submissions")
    .select("audio_url")
    .eq("id", song.submission_id)
    .single();

  if (!sub?.audio_url) throw new Error("No audio file uploaded for this song.");

  await setNote(`signing url: ${sub.audio_url}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from("song-submissions")
    .createSignedUrl(sub.audio_url, 300);
  if (signErr) throw new Error(`Storage URL failed: ${signErr.message}`);

  await setNote("downloading audio");

  const res = await fetch(signed.signedUrl);
  if (!res.ok) throw new Error(`Storage download failed: ${res.status}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-song-"));
  try {
    const audioPath = path.join(tmpDir, "song.mp3");
    const buf = Buffer.from(await res.arrayBuffer());
    await setNote(`downloaded ${buf.length} bytes, running fpcalc`);
    fs.writeFileSync(audioPath, buf);

    const { fingerprint: rawFp } = getFingerprintFromFile(audioPath);
    // fpcalc outputs unsigned 32-bit ints; PostgreSQL integer[] is signed — reinterpret
    const fingerprint = rawFp.map((v) => (v > 2147483647 ? v - 4294967296 : v));
    await setNote(`fpcalc done, fp length ${fingerprint.length}, saving`);

    const { error: updateErr } = await supabase.from("danger_songs").update({
      fingerprint,
      approved_at: new Date().toISOString(),
      notes: null,
    }).eq("id", songId);
    if (updateErr) throw new Error(`DB update failed: ${updateErr.message} (code ${updateErr.code})`);

    return { success: true, fingerprintLength: fingerprint.length };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// Debug: recognize one 15s clip from a YouTube URL via AudD and return the raw result
async function debugMatch(youtubeUrl, startSec = 0) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dugunhub-dbg-"));
  try {
    const streamUrl = resolveStreamUrl(youtubeUrl);
    const audioPath = await downloadSegment(streamUrl, startSec, 15, tmpDir);
    const recognition = await recognizeWithAudd(audioPath, AUDD_API_TOKEN);

    const dangerSongs = await loadDangerSongs();
    const match = recognition ? matchesDangerSong(recognition, dangerSongs) : null;

    return { startSec, recognition, dangerSongMatch: match || null };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { processJob, resolveYouTubeUrl, fingerprintDangerSong, debugMatch };
