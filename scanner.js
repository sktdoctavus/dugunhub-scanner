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

// Fetch all video IDs + durations from a YouTube playlist or single video URL
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
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    channelTitle: item.snippet.title,
    channelId: item.id,
  };
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
  throw new Error("Could not parse channel URL");
}

// ISO 8601 duration (PT1H30M15S) → seconds
function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
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

// Extract the "Music in this video" tracks that YouTube detected for a single video.
// Uses yt-dlp -j (metadata only, no download). Returns [{title, artist, album}].
function extractYtMusicTracks(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    "--skip-download", "--no-playlist", "-j",
    "--extractor-args", "youtube:player_client=tv_embedded,web_embedded,android_vr,android",
  ];
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  args.push(videoUrl);

  const result = spawnSync("yt-dlp", args, { timeout: 30000, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout?.trim()) return [];

  let info;
  try { info = JSON.parse(result.stdout); } catch { return []; }

  const tracks = [];

  // yt-dlp stores the "Music in this video" panel as info.music — keys may be capitalized
  if (Array.isArray(info.music)) {
    for (const m of info.music) {
      const title  = m.track  || m.Track  || m.Song   || m.song   || null;
      const artist = m.artist || m.Artist || null;
      const album  = m.album  || m.Album  || null;
      if (title || artist) tracks.push({ title, artist, album });
    }
  }

  // Fallback: single-track music videos expose top-level track/artist fields
  if (tracks.length === 0 && (info.track || info.artist)) {
    tracks.push({ title: info.track || null, artist: info.artist || null, album: info.album || null });
  }

  return tracks;
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
    const batchResults = await Promise.all(batch.map((video) => {
      const detectedTracks = extractYtMusicTracks(video.id);
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

module.exports = { processJob, resolveYouTubeUrl, fingerprintDangerSong, debugMatch, resolveChannelUrl, ytMetaScan };
