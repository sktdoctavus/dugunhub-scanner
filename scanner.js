const { createClient } = require("@supabase/supabase-js");
const { getFingerprintFromFile, resolveStreamUrl, downloadSegment, recognizeWithAudd } = require("./fingerprint");
const { spawnSync } = require("child_process");
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
// How many segments to download + recognize simultaneously per video
const SCAN_CONCURRENCY = 8;

// Fetch all video IDs + durations from a YouTube video, playlist, or channel URL
async function resolveYouTubeUrl(url) {
  const videoMatch = url.match(/(?:v=|youtu\.be\/|\/live\/)([A-Za-z0-9_-]{11})/);
  const playlistMatch = url.match(/[?&]list=([A-Za-z0-9_-]+)/);

  // RD/WL/LL/FL prefixes are auto-generated YouTube mixes — not real playlists,
  // the playlistItems API returns nothing useful for them. Treat as single video.
  const isAutoPlaylist = playlistMatch && /^(RD|WL|LL|FL|OLAK)/.test(playlistMatch[1]);

  if (playlistMatch && !isAutoPlaylist) {
    return await fetchPlaylistVideos(playlistMatch[1]);
  } else if (videoMatch) {
    return await fetchVideoDetails([videoMatch[1]]);
  }

  // Try to resolve as a channel URL (/@Handle, /channel/UCxxx, /c/Name, /user/Name)
  try {
    const { uploadsPlaylistId } = await resolveChannelUrl(url);
    return await fetchPlaylistVideos(uploadsPlaylistId);
  } catch {
    // not a channel URL either
  }

  throw new Error("Invalid YouTube URL — paste a video link, playlist link, or channel URL (e.g. youtube.com/@ChannelName)");
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
    thumbnailUrl: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || null,
    publishedAt: v.snippet.publishedAt || null,
    channelTitle: v.snippet.channelTitle || null,
    channelId: v.snippet.channelId || null,
  }));
}

// Fetch the uploads playlist ID for a channel (used by resolveChannelUrl)
async function fetchChannelUploadsPlaylistId({ forHandle, id, forUsername }) {
  const params = { part: "contentDetails,snippet", maxResults: 1, key: YOUTUBE_API_KEY };
  if (forHandle) params.forHandle = forHandle;
  else if (id) params.id = id;
  else if (forUsername) params.forUsername = forUsername;
  else throw new Error("fetchChannelUploadsPlaylistId: no channel selector provided");

  const res = await axios.get("https://www.googleapis.com/youtube/v3/channels", { params });
  const item = res.data.items?.[0];
  if (!item) throw new Error("Channel not found");
  return {
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
    channelTitle: item.snippet?.title,
    channelId: item.id,
  };
}

// Try forHandle first, then fall back to forUsername for legacy custom URLs
async function resolveHandle(name) {
  try {
    return await fetchChannelUploadsPlaylistId({ forHandle: name });
  } catch {
    return fetchChannelUploadsPlaylistId({ forUsername: name });
  }
}

// Resolve any YouTube channel URL to { uploadsPlaylistId, channelTitle, channelId }
async function resolveChannelUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);

  if (parts[0] === "channel" && parts[1]) {
    return fetchChannelUploadsPlaylistId({ id: parts[1] });
  }
  if (parts[0] === "c" && parts[1]) {
    return fetchChannelUploadsPlaylistId({ forHandle: parts[1] });
  }
  if (parts[0] === "user" && parts[1]) {
    return fetchChannelUploadsPlaylistId({ forUsername: parts[1] });
  }
  if (parts[0]?.startsWith("@")) {
    return fetchChannelUploadsPlaylistId({ forHandle: parts[0].slice(1) });
  }
  // URL path like /@Handle
  const handleMatch = u.pathname.match(/^\/@(.+)/);
  if (handleMatch) {
    return fetchChannelUploadsPlaylistId({ forHandle: handleMatch[1] });
  }
  // Bare handle: youtube.com/SmartVideoBE (no prefix, no @)
  // Try forHandle first (new-style), fall back to forUsername (legacy custom URL)
  if (parts.length === 1 && parts[0]) {
    return resolveHandle(parts[0]);
  }
  throw new Error("Could not parse channel URL");
}

// ISO 8601 duration (PT1H30M15S) → seconds
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// Load all approved danger songs from Supabase (title/artist matching, for full AudD scan)
async function loadDangerSongs() {
  const { data, error } = await supabase
    .from("danger_songs")
    .select("id, title, artist, claimant, match_type")
    .eq("approved", true);

  if (error) throw new Error(`Failed to load danger songs: ${error.message}`);
  return data || [];
}

// Load danger songs that have stored fingerprints (for local fingerprint-only scan)
async function loadDangerSongsWithFingerprints() {
  const { data, error } = await supabase
    .from("danger_songs")
    .select("id, title, artist, claimant, fingerprint")
    .eq("approved", true)
    .eq("match_type", "song")
    .not("fingerprint", "is", null);

  if (error) throw new Error(`Failed to load danger songs: ${error.message}`);
  return (data || []).filter((s) => Array.isArray(s.fingerprint) && s.fingerprint.length > 0);
}

// Compute minimum BER between a short clip fingerprint and a longer song fingerprint
// using a sliding window. Returns 0 (perfect match) to 1 (no match).
function computeMinBER(clipFp, songFp) {
  if (!clipFp?.length || !songFp?.length) return 1;
  const [shortFp, longFp] = clipFp.length <= songFp.length ? [clipFp, songFp] : [songFp, clipFp];
  const wSize = shortFp.length;
  const totalBits = wSize * 32;
  let minBER = 1;

  for (let offset = 0; offset <= longFp.length - wSize; offset++) {
    let diffBits = 0;
    for (let i = 0; i < wSize; i++) {
      let x = ((shortFp[i] ^ longFp[offset + i]) >>> 0);
      // Hamming weight (popcount)
      x = x - ((x >>> 1) & 0x55555555);
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      x = (x + (x >>> 4)) & 0x0f0f0f0f;
      diffBits += (x * 0x01010101) >>> 24;
    }
    const ber = diffBits / totalBits;
    if (ber < minBER) minBER = ber;
    if (minBER < 0.1) break; // great match — early exit
  }
  return minBER;
}

// Find the best-matching danger song for a clip fingerprint. Returns { song, ber } or null.
function matchFingerprintToDangerSongs(clipFp, dangerSongs, threshold = 0.35) {
  let best = null;
  for (const song of dangerSongs) {
    const ber = computeMinBER(clipFp, song.fingerprint);
    if (ber < threshold && (!best || ber < best.ber)) best = { song, ber };
  }
  return best;
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

// Check if an AudD recognition result matches any danger entry (song, artist, or label)
function matchesDangerSong(recognition, dangerSongs) {
  const recTitle = normalize(recognition?.title);
  const recArtist = normalize(recognition?.artist);
  const recLabel = normalize(recognition?.label);

  for (const song of dangerSongs) {
    const matchType = song.match_type || "song";

    if (matchType === "song") {
      if (!recTitle) continue;
      const songTitle = normalize(song.title);
      const titleMatch = recTitle === songTitle || recTitle.includes(songTitle) || songTitle.includes(recTitle);
      if (!titleMatch) continue;
      const songArtist = normalize(song.artist);
      if (songArtist && recArtist) {
        const artistMatch = recArtist === songArtist || recArtist.includes(songArtist) || songArtist.includes(recArtist);
        if (!artistMatch) continue;
      }
      return song;
    }

    if (matchType === "artist") {
      if (!recArtist || !song.artist) continue;
      const songArtist = normalize(song.artist);
      if (recArtist === songArtist || recArtist.includes(songArtist) || songArtist.includes(recArtist)) return song;
    }

    if (matchType === "label") {
      if (!recLabel || !song.title) continue;
      const labelName = normalize(song.title);
      if (recLabel === labelName || recLabel.includes(labelName) || labelName.includes(recLabel)) return song;
    }
  }
  return null;
}

// Scan a single video with AudD — downloads 15s clips every 120s and recognizes each
async function processVideo(video, dangerSongs, jobId, onBatchComplete, attempt = 1) {
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
        return processVideo(video, dangerSongs, jobId, onBatchComplete, attempt + 1);
      }
      return { status: "failed", error: e.message, matches: [] };
    }

    // Check if cancelled before we even start sampling
    if (jobId) {
      const { data: jobCheck } = await supabase.from("scan_jobs").select("status").eq("id", jobId).single();
      if (jobCheck?.status === "cancelled") return { status: "cancelled", matches: [], recognizedSongs: [], samplesChecked: 0 };
    }

    const matches = [];
    const matchedSongIds = new Set();
    const recognizedSongs = []; // every song AudD found, danger or not
    let samplesChecked = 0;
    let rateLimited = false;
    let cancelled = false;

    // Build the full list of segments to check
    const segments = [];
    for (let start = 0; start < video.durationSec; start += SAMPLE_INTERVAL_SEC) {
      const duration = Math.min(SAMPLE_DURATION_SEC, video.durationSec - start);
      if (duration < 5) break;
      segments.push({ start, duration });
    }

    // Process SCAN_CONCURRENCY segments at a time — ~4x faster than sequential
    for (let i = 0; i < segments.length; i += SCAN_CONCURRENCY) {
      if (rateLimited || cancelled) break;
      if (jobId) {
        const { data: jobCheck } = await supabase.from("scan_jobs").select("status").eq("id", jobId).single();
        if (jobCheck?.status === "cancelled") {
          cancelled = true;
          console.log(`[scan] job ${jobId} cancelled, stopping`);
          break;
        }
      }
      const batch = segments.slice(i, i + SCAN_CONCURRENCY);
      await Promise.all(batch.map(async ({ start, duration }) => {
        if (rateLimited || cancelled) return;
        let audioPath;
        try {
          audioPath = await downloadSegment(streamUrl, start, duration, tmpDir);
          // Re-check after download — skip AudD upload if cancelled while downloading
          if (rateLimited || cancelled) return;
          const recognition = await recognizeWithAudd(audioPath, AUDD_API_TOKEN);
          samplesChecked++;

          if (recognition) {
            console.log(`[audd] @${start}s: "${recognition.title}" by ${recognition.artist}`);
            recognizedSongs.push({
              at_sec: start,
              title: recognition.title,
              artist: recognition.artist,
              timecode: recognition.timecode || null,
              label: recognition.label || null,
              song_link: recognition.song_link || null,
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
                match_type: dangerSong.match_type || "song",
                detected_at_sec: start,
                audd_timecode: recognition.timecode || null,
                score: 100,
                audd_title: recognition.title,
                audd_artist: recognition.artist,
              });
            }
          } else {
            console.log(`[audd] @${start}s: no match`);
          }
        } catch (e) {
          if (e.code === "AUDD_RATE_LIMIT") {
            rateLimited = true;
            console.error(`[audd] @${start}s: recognition limit reached — aborting scan`);
          } else {
            console.error(`[audd] @${start}s FAILED: ${e.message.slice(0, 500)}`);
          }
        } finally {
          if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        }
      }));
      if (onBatchComplete) await onBatchComplete(batch.length);
    }

    return { status: cancelled ? "cancelled" : "done", rateLimited, cancelled, matches, recognizedSongs, samplesChecked };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Local-only scan: compare audio fingerprints against stored danger song fingerprints (no AudD)
async function processVideoLocal(video, dangerSongs, jobId, onBatchComplete) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dugunhub-local-"));
  try {
    let streamUrl;
    try {
      console.log(`[local] resolving stream URL for "${video.title}"...`);
      streamUrl = resolveStreamUrl(video.url);
    } catch (e) {
      return { status: "failed", error: e.message, matches: [], samplesChecked: 0 };
    }

    if (jobId) {
      const { data: jobCheck } = await supabase.from("scan_jobs").select("status").eq("id", jobId).single();
      if (jobCheck?.status === "cancelled") return { status: "cancelled", matches: [], samplesChecked: 0 };
    }

    const matches = [];
    const matchedSongIds = new Set();
    let samplesChecked = 0;
    let cancelled = false;

    const segments = [];
    for (let start = 0; start < video.durationSec; start += SAMPLE_INTERVAL_SEC) {
      const duration = Math.min(SAMPLE_DURATION_SEC, video.durationSec - start);
      if (duration < 5) break;
      segments.push({ start, duration });
    }

    for (let i = 0; i < segments.length; i += SCAN_CONCURRENCY) {
      if (cancelled) break;
      if (jobId) {
        const { data: jobCheck } = await supabase.from("scan_jobs").select("status").eq("id", jobId).single();
        if (jobCheck?.status === "cancelled") { cancelled = true; break; }
      }
      const batch = segments.slice(i, i + SCAN_CONCURRENCY);
      await Promise.all(batch.map(async ({ start, duration }) => {
        if (cancelled) return;
        let audioPath;
        try {
          audioPath = await downloadSegment(streamUrl, start, duration, tmpDir);
          if (cancelled) return;
          const { fingerprint: clipFp } = getFingerprintFromFile(audioPath);
          samplesChecked++;
          const hit = matchFingerprintToDangerSongs(clipFp, dangerSongs);
          if (hit && !matchedSongIds.has(hit.song.id)) {
            matchedSongIds.add(hit.song.id);
            const score = Math.round((1 - hit.ber) * 100);
            console.log(`[local] @${start}s: MATCH "${hit.song.title}" BER=${hit.ber.toFixed(3)} score=${score}`);
            matches.push({
              song_id: hit.song.id,
              song_title: hit.song.title,
              song_artist: hit.song.artist,
              claimant: hit.song.claimant,
              match_type: "song",
              detected_at_sec: start,
              audd_timecode: null,
              score,
              audd_title: null,
              audd_artist: null,
            });
          } else if (!hit) {
            console.log(`[local] @${start}s: no match`);
          }
        } catch (e) {
          console.error(`[local] @${start}s FAILED: ${e.message.slice(0, 300)}`);
        } finally {
          if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        }
      }));
      if (onBatchComplete) await onBatchComplete(batch.length);
    }

    return { status: cancelled ? "cancelled" : "done", cancelled, matches, recognizedSongs: [], samplesChecked, rateLimited: false };
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

    // Calculate total segments across all videos upfront for accurate progress
    const totalSamples = videos.reduce((sum, v) => {
      let count = 0;
      for (let s = 0; s < v.durationSec; s += SAMPLE_INTERVAL_SEC) {
        if (Math.min(SAMPLE_DURATION_SEC, v.durationSec - s) >= 5) count++;
      }
      return sum + count;
    }, 0);

    await supabase.from("scan_jobs").update({
      total_videos: videos.length,
      total_hours: Math.round(totalDurationHours * 10) / 10,
      total_samples: totalSamples,
      progress_samples: 0,
    }).eq("id", jobId);

    const isLocal = job.scan_mode === "local";

    // Deduct credits only for full AudD scans
    if (!isLocal) {
      await supabase.rpc("deduct_scan_hours", {
        p_user_id: job.user_id,
        p_hours: totalDurationHours,
      });
    }

    const dangerSongs = isLocal
      ? await loadDangerSongsWithFingerprints()
      : await loadDangerSongs();

    if (isLocal) {
      console.log(`[scan] local mode — ${dangerSongs.length} songs with fingerprints loaded`);
    }
    const results = [];
    let completedSamples = 0;

    const onBatchComplete = async (count) => {
      completedSamples += count;
      await supabase.from("scan_jobs").update({ progress_samples: completedSamples }).eq("id", jobId);
    };

    const processedVideoIds = new Set();

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      // Check cancellation before each video
      const { data: jobCheck } = await supabase.from("scan_jobs").select("status").eq("id", jobId).single();
      if (jobCheck?.status === "cancelled") {
        console.log(`[scan] job ${jobId} cancelled between videos`);
        break;
      }

      await supabase.from("scan_jobs").update({ progress_title: video.title }).eq("id", jobId);

      const result = isLocal
        ? await processVideoLocal(video, dangerSongs, jobId, onBatchComplete)
        : await processVideo(video, dangerSongs, jobId, onBatchComplete);

      processedVideoIds.add(video.id);
      await supabase.from("scan_jobs").update({ progress_video: i + 1 }).eq("id", jobId);

      results.push({
        video_id: video.id,
        video_title: video.title,
        video_url: video.url,
        duration_sec: video.durationSec,
        status: result.status,
        matches: result.matches,
        recognized_songs: result.recognizedSongs || [],
        rate_limited: result.rateLimited || false,
        samples_checked: result.samplesChecked || 0,
        error: result.error || null,
      });

      if (result.cancelled) {
        console.log(`[scan] job ${jobId} cancelled inside video — stopping`);
        break;
      }
      if (result.rateLimited) {
        console.log(`[scan] AudD rate limit hit — stopping job ${jobId} early`);
        break;
      }

      if (i < videos.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_VIDEOS_MS));
      }
    }

    // Check if cancelled (may have been set during last video)
    const { data: finalCheck } = await supabase.from("scan_jobs").select("status").eq("id", jobId).single();
    if (finalCheck?.status === "cancelled") {
      console.log(`[scan] job ${jobId} finished as cancelled`);
      return;
    }

    // Refund hours only for full AudD scans (local scans never deduct credits)
    if (!isLocal) {
      let refundHours = 0;
      for (const video of videos) {
        if (!processedVideoIds.has(video.id)) {
          refundHours += video.durationSec / 3600;
        } else {
          const res = results.find((r) => r.video_id === video.id);
          if (res?.rate_limited && res.samples_checked === 0) {
            refundHours += video.durationSec / 3600;
          }
        }
      }
      if (refundHours > 0) {
        console.log(`[scan] refunding ${refundHours.toFixed(2)}h to user ${job.user_id}`);
        await supabase.rpc("refund_scan_hours", { p_user_id: job.user_id, p_hours: refundHours });
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

// Extract fingerprint for a danger_song that was added via YouTube URL (no Storage upload)
async function fingerprintDangerSongFromYouTube(songId) {
  const setNote = (msg) => supabase.from("danger_songs").update({ notes: `[fp] ${msg}` }).eq("id", songId).then(() => {});

  await setNote("started (youtube path)");

  const { data: song, error } = await supabase
    .from("danger_songs")
    .select("id, title, youtube_video_id")
    .eq("id", songId)
    .single();
  if (error || !song) throw new Error(`Song not found: ${error?.message}`);
  if (!song.youtube_video_id) throw new Error("No youtube_video_id on this song.");

  const videoUrl = `https://www.youtube.com/watch?v=${song.youtube_video_id}`;
  await setNote(`resolving stream: ${videoUrl}`);

  const streamUrl = resolveStreamUrl(videoUrl);
  await setNote("downloading full audio");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-yt-fp-"));
  try {
    // null duration = download the whole song so the fingerprint covers every second
    const audioPath = await downloadSegment(streamUrl, 0, null, tmpDir);
    await setNote("running fpcalc");

    const { fingerprint: rawFp, duration } = getFingerprintFromFile(audioPath);
    const fingerprint = rawFp.map((v) => (v > 2147483647 ? v - 4294967296 : v));
    await setNote(`fpcalc done, fp length ${fingerprint.length}, saving`);

    const { error: updateErr } = await supabase.from("danger_songs").update({
      fingerprint,
      duration,
      notes: null,
    }).eq("id", songId);
    if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`);

    return { success: true, fingerprintLength: fingerprint.length };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// Extract and store chromaprint fingerprint for a danger_song from its uploaded audio file.
// Routes to fingerprintDangerSongFromYouTube when the song has a youtube_video_id and no submission.
async function fingerprintDangerSong(songId) {
  const setNote = (msg) => supabase.from("danger_songs").update({ notes: `[fp] ${msg}` }).eq("id", songId).then(() => {});

  await setNote("started");

  const { data: song, error } = await supabase
    .from("danger_songs")
    .select("id, title, submission_id, youtube_video_id")
    .eq("id", songId)
    .single();
  if (error || !song) throw new Error(`Song not found: ${error?.message}`);

  // Route to YouTube path when no uploaded audio file exists
  if (song.youtube_video_id && !song.submission_id) {
    return fingerprintDangerSongFromYouTube(songId);
  }

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

// Flatten a YouTube text object { simpleText } or { runs: [{text}] } to a plain string.
function getText(obj) {
  if (!obj) return null;
  if (typeof obj.simpleText === "string") return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || "").join("");
  return null;
}

// Recursively find all videoDescriptionMusicSectionRenderer nodes in ytInitialData.
function findMusicSections(obj, depth = 0, results = []) {
  if (!obj || depth > 30 || typeof obj !== "object") return results;
  if (obj.videoDescriptionMusicSectionRenderer) {
    results.push(obj.videoDescriptionMusicSectionRenderer);
    return results; // don't recurse into found node
  }
  const children = Array.isArray(obj) ? obj : Object.values(obj);
  for (const child of children) findMusicSections(child, depth + 1, results);
  return results;
}

// Parse tracks out of a list of videoDescriptionMusicSectionRenderer nodes.
function parseMusicSectionsToTracks(musicSections) {
  const tracks = [];
  for (const section of musicSections) {
    for (const lockup of section?.carouselLockups || []) {
      const lr = lockup?.carouselLockupRenderer;
      if (!lr) continue;
      const track = {};

      // Song title may be in the videoLockup sub-renderer
      const vl = lr?.videoLockup?.videoLockupRenderer;
      if (vl) {
        const t = getText(vl?.title);
        if (t) track.title = t;
      }

      // Info rows: Song / Artist / Album
      for (const row of lr?.infoRows || []) {
        const info = row?.infoRowRenderer;
        if (!info) continue;
        const label = (getText(info.title) || "").toLowerCase();
        const value = getText(info.defaultMetadata) || getText(info.expandedMetadata);
        if (!value) continue;
        if (label === "song"   || label === "şarkı")   track.title  = value;
        else if (label === "artist" || label === "sanatçı") track.artist = value;
        else if (label === "album"  || label === "albüm")  track.album  = value;
      }

      if (track.title || track.artist) tracks.push(track);
    }
  }
  return tracks;
}

// Fetch the YouTube watch page HTML and extract ytInitialData JSON.
// Uses the residential proxy (YTDLP_PROXY) and optional cookies (YTDLP_COOKIES).
// Returns the parsed ytInitialData object, or null on failure.
async function fetchYtInitialData(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Cookie": "SOCS=CAI",
  };

  const rawCookies = process.env.YTDLP_COOKIES || process.env.YTDLP_COOKIES_B64;
  if (rawCookies) {
    const content = rawCookies.trimStart().startsWith("#")
      ? rawCookies
      : Buffer.from(rawCookies, "base64").toString("utf8");
    const cookieStr = content.split("\n")
      .filter(l => !l.startsWith("#") && l.trim())
      .map(l => { const p = l.split("\t"); return p.length >= 7 ? `${p[5]}=${p[6]}` : null; })
      .filter(Boolean).join("; ");
    if (cookieStr) headers["Cookie"] = cookieStr;
  }

  const config = { headers, timeout: 30000 };

  if (process.env.YTDLP_PROXY) {
    try {
      const p = new URL(process.env.YTDLP_PROXY);
      config.proxy = {
        protocol: p.protocol.replace(":", ""),
        host: p.hostname,
        port: parseInt(p.port),
        ...(p.username ? { auth: { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) } } : {}),
      };
    } catch {}
  }

  const res = await axios.get(url, config);
  const html = res.data;

  const marker = "var ytInitialData = ";
  const start = html.indexOf(marker);
  if (start === -1) {
    const botPage = html.includes("Sign in to confirm");
    console.log(`[yt-page] ${videoId}: ytInitialData not found — ${html.length} bytes, HTTP ${res.status}${botPage ? " [BOT DETECTION PAGE]" : ""}`);
    return null;
  }
  const jsonStart = start + marker.length;
  // Use </script> not ;</script> — YouTube HTML sometimes has \n before </script>
  const end = html.indexOf("</script>", jsonStart);
  if (end === -1) {
    console.log(`[yt-page] ${videoId}: </script> end marker not found`);
    return null;
  }
  let jsonStr = html.slice(jsonStart, end).trimEnd();
  if (jsonStr.endsWith(";")) jsonStr = jsonStr.slice(0, -1);
  console.log(`[yt-page] ${videoId}: parsing JSON (${jsonStr.length} chars), HTTP ${res.status}`);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error(`[yt-page] ${videoId}: JSON parse error — ${e.message.slice(0, 100)}`);
    console.error(`[yt-page] ${videoId}: JSON tail: ${jsonStr.slice(-150)}`);
    return null;
  }
}

// Extract "Music in this video" tracks.
// PRIMARY: yt-dlp --dump-json with web client + proxy + cookies (same pattern as resolveStreamUrl).
//   The missing --proxy flag was the root cause of all previous yt-dlp failures.
// FALLBACK: direct axios GET of the watch page HTML → parse ytInitialData.
// Returns [{title, artist, album}].
async function extractYtMusicTracks(videoId) {
  const ytArgs = [
    "--dump-json", "--no-playlist",
    "--extractor-args", "youtube:player_client=web",
  ];

  const rawCookies = process.env.YTDLP_COOKIES || process.env.YTDLP_COOKIES_B64;
  let cookieTmp = null;
  if (rawCookies) {
    cookieTmp = path.join(os.tmpdir(), "yt_music_cookies.txt");
    try {
      const content = rawCookies.trimStart().startsWith("#")
        ? rawCookies
        : Buffer.from(rawCookies, "base64").toString("utf8");
      fs.writeFileSync(cookieTmp, content);
      ytArgs.push("--cookies", cookieTmp);
    } catch (e) {
      console.error(`[yt-music] cookie write failed: ${e.message}`);
      cookieTmp = null;
    }
  }

  if (process.env.YTDLP_PROXY) ytArgs.push("--proxy", process.env.YTDLP_PROXY);
  ytArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

  const ytEnv = { ...process.env };
  delete ytEnv.HTTP_PROXY; delete ytEnv.HTTPS_PROXY;
  delete ytEnv.http_proxy; delete ytEnv.https_proxy;
  delete ytEnv.ALL_PROXY;  delete ytEnv.all_proxy;

  console.log(`[yt-music] ${videoId}: yt-dlp web client (proxy=${!!process.env.YTDLP_PROXY}, cookies=${!!cookieTmp})`);
  const result = spawnSync("yt-dlp", ytArgs, { timeout: 60000, encoding: "utf8", env: ytEnv });
  if (cookieTmp) try { fs.unlinkSync(cookieTmp); } catch (_) {}

  if (result.status === 0 && result.stdout?.trim()) {
    try {
      const info = JSON.parse(result.stdout);
      const tracks = (info.music || [])
        .map((m) => ({ title: m.song || null, artist: m.artist || null, album: m.album || null }))
        .filter((t) => t.title || t.artist);
      console.log(`[yt-music] ${videoId}: yt-dlp OK → ${tracks.length} tracks`);
      return tracks;
    } catch (e) {
      console.error(`[yt-music] ${videoId}: yt-dlp JSON parse: ${e.message.slice(0, 100)}`);
    }
  } else {
    console.error(`[yt-music] ${videoId}: yt-dlp exit ${result.status} — ${(result.stderr || "").slice(0, 300)}`);
  }

  console.log(`[yt-music] ${videoId}: falling back to axios page fetch`);
  try {
    const ytInitialData = await fetchYtInitialData(videoId);
    if (!ytInitialData) {
      console.log(`[yt-music] ${videoId}: axios fallback → ytInitialData null`);
      return [];
    }
    const musicSections = findMusicSections(ytInitialData);
    const tracks = parseMusicSectionsToTracks(musicSections);
    if (tracks.length === 0) {
      const raw = JSON.stringify(ytInitialData);
      const hasMusicSection = raw.includes("MusicSection");
      const hasMusicRenderer = raw.includes("musicRenderer");
      const hasEngagementMusic = raw.includes("engagementPanel") && raw.includes("music");
      console.log(`[yt-music] ${videoId}: axios 0 tracks — MusicSection=${hasMusicSection} musicRenderer=${hasMusicRenderer} engagementMusic=${hasEngagementMusic} jsonLen=${raw.length}`);
    } else {
      console.log(`[yt-music] ${videoId}: axios fallback → ${musicSections.length} sections, ${tracks.length} tracks`);
    }
    return tracks;
  } catch (e) {
    console.error(`[yt-music] ${videoId}: axios fallback: ${e.message.slice(0, 200)}`);
    return [];
  }
}

// YouTube-metadata-based scan: resolves a URL to videos, extracts Content ID music data,
// compares against danger_songs — no audio download, no AudD call needed.
async function ytMetaScan(youtubeUrl) {
  const videos = await resolveYouTubeUrl(youtubeUrl);
  const dangerSongs = await loadDangerSongs();

  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < videos.length; i += CONCURRENCY) {
    const batch = videos.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (video) => {
      const detectedTracks = await extractYtMusicTracks(video.id);
      const dangerousMatches = [];
      for (const track of detectedTracks) {
        const hit = matchesDangerSong(track, dangerSongs);
        if (hit) {
          dangerousMatches.push({
            danger_song_id: hit.id,
            title: hit.title,
            artist: hit.artist,
            claimant: hit.claimant,
            match_type: hit.match_type || "song",
            detected_title: track.title,
            detected_artist: track.artist,
          });
        }
      }
      return {
        video_id: video.id,
        video_title: video.title,
        video_url: video.url,
        duration_sec: video.durationSec,
        detected_tracks: detectedTracks,
        dangerous_matches: dangerousMatches,
      };
    }));
    results.push(...batchResults);
  }

  const totalDetected = results.reduce((s, r) => s + r.detected_tracks.length, 0);
  const totalDangerous = results.reduce((s, r) => s + r.dangerous_matches.length, 0);
  const videosWithMatches = results.filter((r) => r.dangerous_matches.length > 0).length;

  return { results, totalVideos: videos.length, totalDetected, totalDangerous, videosWithMatches };
}

// Fetch videos from an uploads playlist published after sinceDate (ISO string or null for all).
// Playlist items are newest-first, so we stop paging once we hit the cutoff.
async function fetchPlaylistVideosSince(playlistId, sinceDate) {
  const cutoff = sinceDate ? new Date(sinceDate) : null;
  const videoIds = [];
  let pageToken = "";

  do {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/playlistItems", {
      params: {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: 50,
        pageToken: pageToken || undefined,
        key: YOUTUBE_API_KEY,
      },
    });

    let reachedCutoff = false;
    for (const item of res.data.items) {
      if (item.snippet.title === "Private video" || item.snippet.title === "Deleted video") continue;
      const publishedAt = new Date(item.snippet.publishedAt);
      if (cutoff && publishedAt <= cutoff) { reachedCutoff = true; break; }
      videoIds.push(item.contentDetails.videoId);
    }

    pageToken = reachedCutoff ? "" : (res.data.nextPageToken || "");
  } while (pageToken);

  if (videoIds.length === 0) return [];

  const results = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const details = await fetchVideoDetails(videoIds.slice(i, i + 50));
    results.push(...details);
  }
  return results;
}

// Fingerprint a single video against the danger_songs database.
// Samples every 60s throughout the full video — ±60s timecode precision.
// Returns [{song: dangerSongRow, atSec: number}] for each distinct match.
async function monitorVideoFingerprint(video, dangerSongsWithFp) {
  if (!dangerSongsWithFp || dangerSongsWithFp.length === 0) return [];
  let streamUrl;
  try {
    streamUrl = resolveStreamUrl(video.url);
  } catch (e) {
    console.error(`[monitor-fp] ${video.id}: stream resolve failed: ${e.message.slice(0, 200)}`);
    return [];
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-mfp-"));
  const maxSec = video.durationSec || 600;
  const SEGMENT_CONCURRENCY = 8;
  const segments = [];
  for (let s = 0; s < maxSec; s += 30) segments.push(s);
  const matchedIds = new Set();
  const matches = [];

  try {
    for (let i = 0; i < segments.length; i += SEGMENT_CONCURRENCY) {
      const batch = segments.slice(i, i + SEGMENT_CONCURRENCY);

      // Phase 1: download all segments in the batch concurrently (ffmpeg is async/non-blocking)
      const downloaded = await Promise.all(batch.map(async (startSec) => {
        try {
          const audioPath = await downloadSegment(streamUrl, startSec, 15, tmpDir);
          return { startSec, audioPath };
        } catch (e) {
          console.error(`[monitor-fp] ${video.id}@${startSec}s: ${e.message.slice(0, 150)}`);
          return null;
        }
      }));

      // Phase 2: fingerprint sequentially (fpcalc uses spawnSync, blocks event loop)
      for (const item of downloaded.filter(Boolean)) {
        const { startSec, audioPath } = item;
        try {
          const { fingerprint: clipFp } = getFingerprintFromFile(audioPath);
          try { fs.unlinkSync(audioPath); } catch {}
          const hit = matchFingerprintToDangerSongs(clipFp, dangerSongsWithFp);
          if (hit && !matchedIds.has(hit.song.id)) {
            matchedIds.add(hit.song.id);
            matches.push({ song: hit.song, atSec: startSec });
            console.log(`[monitor-fp] ${video.id}: MATCH "${hit.song.title}" at ${startSec}s (BER=${hit.ber.toFixed(3)})`);
          }
        } catch (e) {
          console.error(`[monitor-fp] ${video.id}@${startSec}s fingerprint: ${e.message.slice(0, 150)}`);
        }
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`[monitor-fp] ${video.id}: ${matches.length} fingerprint match(es)`);
  return matches;
}

// Scan a user's YouTube channel for dangerous songs.
// Fetches ALL channel videos upfront for the progress display, then processes
// only uncached ones. Updates channel_scan_progress in real time so the UI
// can show per-video status as the scan runs.
async function monitorUserChannel(userId, options = {}) {
  const doFingerprint = options.fingerprint === true;
  console.log(`[monitor] starting for user ${userId} (fingerprint=${doFingerprint})`);
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("youtube, channel_last_scanned_at")
    .eq("id", userId)
    .single();

  if (profileErr || !profile) throw new Error(`Profile not found: ${profileErr?.message}`);
  if (!profile.youtube) throw new Error("No YouTube channel URL configured for this user");

  console.log(`[monitor] channel URL: ${profile.youtube}`);
  const scanId = new Date().toISOString();
  await supabase.from("profiles").update({ channel_scan_started_at: scanId }).eq("id", userId);

  try {
  console.log(`[monitor] resolving channel URL...`);
  const { uploadsPlaylistId, channelTitle } = await resolveChannelUrl(profile.youtube);
  console.log(`[monitor] resolved: ${channelTitle} → playlist ${uploadsPlaylistId}`);

  // Always fetch all videos so the full list appears in the progress UI.
  // sinceDate=null means no cutoff — get every upload.
  console.log(`[monitor] fetching all videos...`);
  const allVideos = await fetchPlaylistVideosSince(uploadsPlaylistId, null);
  console.log(`[monitor] fetched ${allVideos.length} videos`);

  if (allVideos.length === 0) {
    await supabase.from("profiles").update({ channel_last_scanned_at: new Date().toISOString() }).eq("id", userId);
    return { scannedVideos: 0, newAlerts: 0 };
  }

  // Seed the progress table so the frontend sees all videos immediately
  const progressRows = allVideos.map((v) => ({
    user_id: userId,
    scan_id: scanId,
    video_id: v.id,
    video_title: v.title,
    video_url: v.url,
    video_thumbnail: v.thumbnailUrl || null,
    duration_sec: v.durationSec || null,
    published_at: v.publishedAt || null,
    status: "pending",
    alert_count: 0,
  }));

  // Insert in batches of 100 to stay within request size limits
  for (let i = 0; i < progressRows.length; i += 100) {
    await supabase.from("channel_scan_progress")
      .upsert(progressRows.slice(i, i + 100), { onConflict: "user_id,scan_id,video_id" });
  }

  // Find already-cached videos and mark them done right away
  const { data: cached } = await supabase
    .from("video_music_cache")
    .select("video_id")
    .eq("user_id", userId)
    .in("video_id", allVideos.map((v) => v.id));

  const cachedIds = new Set((cached || []).map((c) => c.video_id));

  if (cachedIds.size > 0) {
    const cachedArr = [...cachedIds];
    for (let i = 0; i < cachedArr.length; i += 100) {
      await supabase.from("channel_scan_progress")
        .update({ status: "done", processed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("scan_id", scanId)
        .in("video_id", cachedArr.slice(i, i + 100));
    }
  }

  const newVideos = allVideos.filter((v) => !cachedIds.has(v.id));
  const dangerSongs = await loadDangerSongs();
  const dangerSongsWithFp = doFingerprint ? await loadDangerSongsWithFingerprints() : [];
  console.log(`[monitor] ${dangerSongs.length} danger songs, ${dangerSongsWithFp.length} with fingerprints, ${newVideos.length} videos to scan (fingerprint=${doFingerprint})`);

  // CONCURRENCY=3: process 3 videos in parallel without saturating Railway CPU
  const CONCURRENCY = 3;
  let scannedVideos = 0;
  let newAlerts = 0;

  for (let i = 0; i < newVideos.length; i += CONCURRENCY) {
    const batch = newVideos.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (video) => {
      await supabase.from("channel_scan_progress")
        .update({ status: "scanning" })
        .eq("user_id", userId).eq("scan_id", scanId).eq("video_id", video.id);

      const metaTracks = await extractYtMusicTracks(video.id);
      const fpMatches = doFingerprint ? await monitorVideoFingerprint(video, dangerSongsWithFp) : [];

      await supabase.from("video_music_cache").upsert({
        user_id: userId,
        video_id: video.id,
        video_title: video.title,
        video_url: video.url,
        duration_sec: video.durationSec,
        detected_tracks: metaTracks,
        scanned_at: new Date().toISOString(),
      }, { onConflict: "user_id,video_id" });

      scannedVideos++;
      let alertCount = 0;
      const alertedSongIds = new Set();

      // Content ID tracks → text-match against danger_songs
      for (const track of metaTracks) {
        const hit = matchesDangerSong(track, dangerSongs);
        if (!hit || alertedSongIds.has(hit.id)) continue;
        alertedSongIds.add(hit.id);
        const { data: existing } = await supabase.from("channel_alerts")
          .select("id").eq("user_id", userId).eq("video_id", video.id).eq("danger_song_id", hit.id).maybeSingle();
        if (!existing) {
          await supabase.from("channel_alerts").insert({
            user_id: userId, video_id: video.id, video_title: video.title, video_url: video.url,
            danger_song_id: hit.id, danger_song_title: hit.title, danger_song_artist: hit.artist,
            claimant: hit.claimant, match_type: hit.match_type || "song",
            match_source: "content_id", detected_at_sec: null,
          });
          newAlerts++; alertCount++;
        }
      }

      // Fingerprint matches → store exact timecode (second where match was found)
      for (const { song, atSec } of fpMatches) {
        if (alertedSongIds.has(song.id)) continue;
        alertedSongIds.add(song.id);
        const { data: existing } = await supabase.from("channel_alerts")
          .select("id").eq("user_id", userId).eq("video_id", video.id).eq("danger_song_id", song.id).maybeSingle();
        if (!existing) {
          await supabase.from("channel_alerts").insert({
            user_id: userId, video_id: video.id, video_title: video.title, video_url: video.url,
            danger_song_id: song.id, danger_song_title: song.title, danger_song_artist: song.artist,
            claimant: song.claimant, match_type: song.match_type || "song",
            match_source: "fingerprint", detected_at_sec: atSec,
          });
          newAlerts++; alertCount++;
        }
      }

      await supabase.from("channel_scan_progress")
        .update({
          status: alertCount > 0 ? "alert" : "done",
          alert_count: alertCount,
          processed_at: new Date().toISOString(),
        })
        .eq("user_id", userId).eq("scan_id", scanId).eq("video_id", video.id);
    }));

    // Check if user clicked Stop — handleStopScan sets channel_scan_started_at to null
    const { data: cancelCheck } = await supabase
      .from("profiles")
      .select("channel_scan_started_at")
      .eq("id", userId)
      .single();
    if (!cancelCheck?.channel_scan_started_at) {
      console.log(`[monitor] scan cancelled by user, stopping`);
      break;
    }
  }

    await supabase.from("profiles").update({ channel_last_scanned_at: new Date().toISOString(), channel_scan_started_at: null }).eq("id", userId);
    console.log(`[monitor] done for ${userId}: scannedVideos=${scannedVideos} newAlerts=${newAlerts}`);
    return { scannedVideos, newAlerts };
  } catch (e) {
    // Clear the in-progress flag so the UI doesn't stay stuck
    console.error(`[monitor] failed for ${userId}:`, e.message);
    await supabase.from("profiles").update({ channel_scan_started_at: null }).eq("id", userId);
    throw e;
  }
}

module.exports = { processJob, resolveYouTubeUrl, fingerprintDangerSong, debugMatch, resolveChannelUrl, ytMetaScan, monitorUserChannel };
