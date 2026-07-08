// vaultTransfer.js — processes exactly one claimed Vault backup item per call,
// either as a dry-run simulation or (when VAULT_BACKUP_DRY_RUN=false) as a real
// yt-dlp download + Backblaze B2 archive upload + Bunny Stream playback upload.
// Called from vaultBackupWorker.js after vault-backup-worker-tick has already
// claimed the item and moved it to "preparing".
const fs = require("fs");
const os = require("os");
const path = require("path");
const { downloadFullVideo, validateVideoFile } = require("./vaultDownload");
const b2 = require("./b2");
const bunny = require("./bunny");

const DRY_RUN_STAGE_PROGRESS = { preparing: 10, downloading: 35, uploading: 70, verifying: 90, completed: 100 };
const REAL_STAGE_PROGRESS = {
  preparing: 10,
  downloading: 35,
  validating: 60,
  uploading_archive: 80,
  uploading_stream: 90,
  completed: 100,
  ready_for_streaming_upload: 60,
  bunny_retry_pending: 80,
  local_only_waiting: 0,
  failed: 0,
};

// Any status in this list means "no further automatic action will happen in
// this phase" — used to decide when a job's fast_youtube_transfer items are
// all done, regardless of which of these outcomes each one landed on.
const TERMINAL_ITEM_STATUSES = [
  "completed", "failed", "cancelled", "unsupported",
  "ready_for_streaming_upload", "local_only_waiting", "bunny_retry_pending",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function log(supabase, item, stage, level, message) {
  await supabase.from("vault_backup_processing_logs").insert({
    backup_job_id: item.jobId,
    backup_job_item_id: item.itemId,
    user_id: item.userId,
    level,
    stage,
    message,
  });
}

async function setItemStatus(supabase, item, status, progressMap, extra = {}) {
  await supabase
    .from("vault_backup_job_items")
    .update({ status, progress_pct: progressMap[status] ?? 0, ...extra })
    .eq("id", item.itemId);
}

async function deleteQueueRow(supabase, item) {
  await supabase.from("vault_backup_transfer_queue").delete().eq("backup_job_item_id", item.itemId);
}

// Recomputes a job's rollup counters/status from the real item rows — simpler
// and less error-prone than incrementing counters inline as items finish.
// awaiting_takeout items never block completion: only fast_youtube_transfer
// items need to reach a terminal state for the job to be considered done.
async function refreshJobRollup(supabase, jobId) {
  const { data: items } = await supabase
    .from("vault_backup_job_items")
    .select("status, import_method")
    .eq("backup_job_id", jobId);
  const rows = items ?? [];
  const autoRows = rows.filter((r) => r.import_method === "fast_youtube_transfer");
  const completedItems = rows.filter((r) => r.status === "completed").length;
  const failedItems = rows.filter((r) => r.status === "failed").length;
  const unsupportedItems = rows.filter((r) => r.status === "unsupported").length;
  const autoDone = autoRows.length > 0 && autoRows.every((r) => TERMINAL_ITEM_STATUSES.includes(r.status));

  let status = "running";
  let completedAt = null;
  if (autoDone) {
    completedAt = new Date().toISOString();
    const autoCompleted = autoRows.filter((r) => r.status === "completed").length;
    const autoFailed = autoRows.filter((r) => r.status === "failed").length;
    // A job is only "failed" when every automated item genuinely failed.
    // Anything else terminal-but-not-completed (e.g. bunny_retry_pending —
    // the B2 archive succeeded, only the Bunny playback copy didn't) counts
    // as a partial success, not a failure.
    if (autoCompleted === autoRows.length) status = "completed";
    else if (autoFailed === autoRows.length) status = "failed";
    else status = "completed_with_errors";
  }

  await supabase
    .from("vault_backup_jobs")
    .update({
      completed_items: completedItems,
      failed_items: failedItems,
      unsupported_items: unsupportedItems,
      status,
      ...(completedAt ? { completed_at: completedAt } : {}),
    })
    .eq("id", jobId);
}

// ---- Dry run: same simulated lifecycle the edge function used to run itself ----
async function runDryRunSimulation(supabase, item) {
  await sleep(150);
  await setItemStatus(supabase, item, "downloading", DRY_RUN_STAGE_PROGRESS);
  await log(supabase, item, "download", "info", "Simulated download step complete (dry run) — no bytes transferred.");

  await sleep(150);
  await setItemStatus(supabase, item, "uploading", DRY_RUN_STAGE_PROGRESS);
  await log(supabase, item, "upload", "info", "Simulated upload step complete (dry run) — no bytes transferred.");

  await sleep(150);
  await setItemStatus(supabase, item, "verifying", DRY_RUN_STAGE_PROGRESS);
  await log(supabase, item, "verify", "info", "Simulated verification step complete (dry run).");

  await sleep(150);
  await setItemStatus(supabase, item, "completed", DRY_RUN_STAGE_PROGRESS, { completed_at: new Date().toISOString() });
  await supabase.from("vault_youtube_videos").update({ backup_status: "backed_up" }).eq("id", item.vaultVideoId);
  await log(supabase, item, "complete", "info", "Backup marked completed (dry run) — no real file was transferred; vault_youtube_videos.backup_status set to backed_up.");

  await deleteQueueRow(supabase, item);
  await refreshJobRollup(supabase, item.jobId);
}

async function failItem(supabase, item, stage, message) {
  console.error(`[vault-transfer] item ${item.itemId} failed at ${stage}: ${message}`);
  await setItemStatus(supabase, item, "failed", REAL_STAGE_PROGRESS, { last_error: String(message).slice(0, 500) });
  await log(supabase, item, stage, "error", String(message).slice(0, 1000));
  await deleteQueueRow(supabase, item);
  await refreshJobRollup(supabase, item.jobId);
}

// Uploads to Bunny Stream while periodically writing bytes_transferred/
// transfer_speed_bps to the item row (throttled to ~1 write/2s — the file's
// 'data' events fire far more often than that and would otherwise spam the
// DB). Shared by both vault_streaming and vault_archive so the progress-
// reporting logic exists exactly once.
async function uploadToBunnyWithProgress(supabase, item, filePath, title) {
  let lastWrite = 0;
  let lastBytes = 0;
  let lastTime = Date.now();
  const onProgress = (uploaded, total) => {
    const now = Date.now();
    if (now - lastWrite < 2000 && uploaded < total) return;
    const elapsedSec = Math.max(0.001, (now - lastTime) / 1000);
    const speed = Math.round((uploaded - lastBytes) / elapsedSec);
    lastWrite = now;
    lastBytes = uploaded;
    lastTime = now;
    supabase
      .from("vault_backup_job_items")
      .update({ bytes_transferred: uploaded, bytes_total: total, transfer_speed_bps: speed })
      .eq("id", item.itemId)
      .then(() => {}, () => {});
  };
  return bunny.uploadToBunnyStream(filePath, title, { onProgress });
}

// ---- Real transfer: one video, one attempt, no retries yet ----
async function runRealTransfer(supabase, item, workerId) {
  if (item.storageMode === "local_only") {
    await setItemStatus(supabase, item, "local_only_waiting", REAL_STAGE_PROGRESS, { skip_reason: "local_only" });
    await log(supabase, item, "skip", "info",
      "Sadece yerel yedek seçildi — otomatik aktarım yapılmadı. Videoyu manuel olarak yerel diskinize indirip saklayın.");
    await deleteQueueRow(supabase, item);
    await refreshJobRollup(supabase, item.jobId);
    return;
  }

  if (item.storageMode !== "vault_streaming" && item.storageMode !== "vault_archive") {
    await failItem(supabase, item, "prepare", `Unknown storage_mode: ${item.storageMode}`);
    return;
  }

  if (!item.youtubeVideoId || !item.youtubeChannelId) {
    await failItem(supabase, item, "prepare", "Missing YouTube video/channel id — cannot build a storage path.");
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  try {
    // Retry shortcut: this video already has a verified B2 archive from a
    // prior attempt (only a later step, like the Bunny upload, failed) —
    // reuse it instead of re-downloading from YouTube and re-uploading.
    const reuseArchivedFile = item.storageMode === "vault_archive" && !!item.storageObjectKey;

    let downloaded;
    if (reuseArchivedFile) {
      await setItemStatus(supabase, item, "downloading", REAL_STAGE_PROGRESS);
      await log(supabase, item, "download", "info",
        `Yeniden deneme: B2 arşivi zaten mevcut (${item.storageObjectKey}) — YouTube'dan tekrar indirilmiyor, B2'den alınıyor.`);
      const ext = item.storageObjectKey.split(".").pop() || "mp4";
      try {
        downloaded = await b2.downloadFile(item.storageObjectKey, path.join(tmpDir, `original.${ext}`));
      } catch (e) {
        await failItem(supabase, item, "download", `B2'den arşiv indirilemedi: ${e.message}`);
        return;
      }
      await log(supabase, item, "download", "info", `B2'den indirildi (${downloaded.size} bytes).`);
    } else {
      await setItemStatus(supabase, item, "downloading", REAL_STAGE_PROGRESS);
      await log(supabase, item, "download", "info", `Worker "${workerId}" starting yt-dlp download (bestvideo+bestaudio, no quality cap).`);
      try {
        downloaded = await downloadFullVideo(item.sourceUrl, tmpDir);
      } catch (e) {
        await failItem(supabase, item, "download", e.message);
        return;
      }
      // yt-dlp gets the best version YouTube will actually serve — never the
      // creator's true original upload master (YouTube re-encodes everything
      // it hosts). If the disaster-recovery goal is the literal original
      // file, that requires the creator's own Google Takeout export, not
      // this pipeline — see google_takeout_import.
      const formatSummary = (downloaded.selectedFormats || [])
        .map((f) => `id=${f.formatId} ${f.width || "?"}x${f.height || "?"}@${f.fps || "?"}fps vcodec=${f.vcodec} acodec=${f.acodec} vbr=${f.vbr} abr=${f.abr} tbr=${f.tbr} range=${f.dynamicRange} ext=${f.ext}`)
        .join(" | ");
      await log(supabase, item, "download", "info",
        `Downloaded ${downloaded.size} bytes (.${downloaded.ext}). Selected format(s) — ${formatSummary || "(format info unavailable)"}. ` +
        `Merged=${(downloaded.selectedFormats || []).length > 1 ? "yes (separate video+audio muxed via ffmpeg, no re-encode)" : "no (single combined format)"}.`);
    }

    await setItemStatus(supabase, item, "validating", REAL_STAGE_PROGRESS);
    let merged;
    try {
      merged = await validateVideoFile(downloaded.filePath);
      const lowQualityNote = merged.height && merged.height <= 360
        ? " NOTE: this is a low resolution — if YouTube genuinely has no higher quality available for this video, this is the true best-available, not a bug."
        : "";
      await log(supabase, item, "validate", "info",
        `ffprobe OK — merged output: ${merged.width || "?"}x${merged.height || "?"}, codec=${merged.videoCodec || "?"}, ` +
        `bitrate=${merged.bitrateBps ? Math.round(merged.bitrateBps / 1000) + "kbps" : "?"}, range=${merged.dynamicRange}, ` +
        `duration=~${Math.round(merged.durationSec)}s.${lowQualityNote}`);
    } catch (e) {
      await failItem(supabase, item, "validate", e.message);
      return;
    }

    if (item.storageMode === "vault_streaming") {
      if (!bunny.isConfigured()) {
        // Bunny env vars aren't set on this deployment yet — degrade
        // gracefully instead of failing the item outright.
        await setItemStatus(supabase, item, "ready_for_streaming_upload", REAL_STAGE_PROGRESS);
        await log(supabase, item, "complete", "info",
          "Bunny Stream ortam değişkenleri ayarlanmamış — izlenebilir kopya yükleme atlandı (ready_for_streaming_upload).");
        await deleteQueueRow(supabase, item);
        await refreshJobRollup(supabase, item.jobId);
        return;
      }

      await setItemStatus(supabase, item, "uploading_stream", REAL_STAGE_PROGRESS);
      await log(supabase, item, "upload", "info",
        `Bunny Stream'e yükleniyor — kaynak dosya: ${downloaded.filePath} (${downloaded.size} bytes, .${downloaded.ext}), ` +
        `çözünürlük ${merged.width || "?"}x${merged.height || "?"}. Bu, yt-dlp'nin indirdiği aynı dosyadır (downscale yok).`);

      let bunnyResult;
      try {
        bunnyResult = await uploadToBunnyWithProgress(supabase, item, downloaded.filePath, item.title || item.youtubeVideoId);
      } catch (e) {
        // No B2 copy exists for vault_streaming — a failed Bunny upload
        // means nothing was preserved, so this is a genuine failure.
        await failItem(supabase, item, "upload", `Bunny upload failed: ${e.message}`);
        return;
      }

      await setItemStatus(supabase, item, "completed", REAL_STAGE_PROGRESS, {
        bunny_video_guid: bunnyResult.guid,
        bunny_embed_url: bunnyResult.embedUrl,
        bunny_thumbnail_url: bunnyResult.thumbnailUrl,
        bytes_total: bunnyResult.size,
        bytes_transferred: bunnyResult.size,
        completed_at: new Date().toISOString(),
      });
      await supabase
        .from("vault_youtube_videos")
        .update({
          backup_status: "backed_up",
          bunny_video_guid: bunnyResult.guid,
          bunny_embed_url: bunnyResult.embedUrl,
          bunny_thumbnail_url: bunnyResult.thumbnailUrl,
        })
        .eq("id", item.vaultVideoId);
      await log(supabase, item, "complete", "info", `İzlenebilir kopya Bunny Stream'e yüklendi: ${bunnyResult.guid}.`);

      await deleteQueueRow(supabase, item);
      await refreshJobRollup(supabase, item.jobId);
      return;
    }

    // vault_archive from here on.
    let archiveFields;
    if (reuseArchivedFile) {
      // Already uploaded and verified in a prior attempt — nothing to redo.
      archiveFields = {
        storage_object_key: item.storageObjectKey,
        checksum: item.checksum,
        bytes_total: item.bytesTotal,
        bytes_transferred: item.bytesTotal,
      };
      await log(supabase, item, "upload", "info", "B2 arşivi zaten doğrulanmış — yeniden yüklenmiyor.");
    } else {
      const md5 = await b2.md5File(downloaded.filePath);
      const originalKey = `users/${item.userId}/youtube/${item.youtubeChannelId}/${item.youtubeVideoId}/original.${downloaded.ext}`;
      const metadataKey = `users/${item.userId}/youtube/${item.youtubeChannelId}/${item.youtubeVideoId}/metadata.json`;

      await setItemStatus(supabase, item, "uploading_archive", REAL_STAGE_PROGRESS);
      await log(supabase, item, "upload", "info", `B2'ye yükleniyor: ${originalKey}`);

      const contentTypeForExt = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm" };
      try {
        await b2.uploadFile(downloaded.filePath, originalKey, contentTypeForExt[downloaded.ext] || "application/octet-stream");
        await b2.uploadJson({
          youtubeVideoId: item.youtubeVideoId,
          youtubeChannelId: item.youtubeChannelId,
          title: item.title,
          sourceUrl: item.sourceUrl,
          downloadedAt: new Date().toISOString(),
          sizeBytes: downloaded.size,
          checksumMd5: md5,
          originalKey,
          selectedFormats: downloaded.selectedFormats || null,
          mergedResolution: merged.width && merged.height ? `${merged.width}x${merged.height}` : null,
          videoCodec: merged.videoCodec || null,
          dynamicRange: merged.dynamicRange || null,
          provenanceNote:
            "This file is the best version yt-dlp could retrieve from YouTube's own processed/re-encoded formats — " +
            "it is NOT the creator's original upload master (YouTube re-encodes everything it hosts, and does not expose " +
            "the source master via any API). Recovering the literal original file requires the creator's own Google " +
            "Takeout export (see the google_takeout_import path), not this pipeline.",
        }, metadataKey);
      } catch (e) {
        await failItem(supabase, item, "upload", `B2 upload failed: ${e.message}`);
        return;
      }

      let verification;
      try {
        verification = await b2.verifyUpload(originalKey, downloaded.size, md5);
      } catch (e) {
        await failItem(supabase, item, "upload", `B2 verification request failed: ${e.message}`);
        return;
      }
      if (!verification.verified) {
        await b2.deleteObject(originalKey).catch(() => {});
        await failItem(supabase, item, "upload",
          `B2 verification mismatch (sizeMatches=${verification.sizeMatches}, etag=${verification.etag}).`);
        return;
      }

      // The archive itself is now safe in B2 regardless of what happens next.
      archiveFields = {
        storage_object_key: originalKey,
        checksum: md5,
        bytes_total: downloaded.size,
        bytes_transferred: downloaded.size,
      };
      await log(supabase, item, "upload", "info", `Arşive yüklendi ve doğrulandı: ${originalKey} (${downloaded.size} bytes).`);
    }

    await supabase.from("vault_youtube_videos").update({ backup_status: "backed_up" }).eq("id", item.vaultVideoId);

    if (!bunny.isConfigured()) {
      await setItemStatus(supabase, item, "completed", REAL_STAGE_PROGRESS, { ...archiveFields, completed_at: new Date().toISOString() });
      await log(supabase, item, "complete", "info", "Bunny Stream ortam değişkenleri ayarlanmamış — yalnızca B2 arşivi tamamlandı.");
      await deleteQueueRow(supabase, item);
      await refreshJobRollup(supabase, item.jobId);
      return;
    }

    await setItemStatus(supabase, item, "uploading_stream", REAL_STAGE_PROGRESS, archiveFields);
    await log(supabase, item, "upload", "info",
      `Arşiv tamamlandı, şimdi Bunny Stream'e izlenebilir kopya yükleniyor — kaynak dosya: ${downloaded.filePath} ` +
      `(${downloaded.size} bytes, .${downloaded.ext}), çözünürlük ${merged.width || "?"}x${merged.height || "?"}. ` +
      `Bu, B2'ye yüklenen aynı yüksek kaliteli dosyadır (downscale yok).`);

    let bunnyResult;
    try {
      bunnyResult = await uploadToBunnyWithProgress(supabase, item, downloaded.filePath, item.title || item.youtubeVideoId);
    } catch (e) {
      // B2 archive already succeeded and is untouched — don't lose it or
      // call this a failure. Mark the Bunny leg as needing a future retry.
      console.error(`[vault-transfer] item ${item.itemId} Bunny upload failed after B2 archive succeeded: ${e.message}`);
      await setItemStatus(supabase, item, "bunny_retry_pending", REAL_STAGE_PROGRESS, {
        ...archiveFields,
        last_error: `Arşiv (B2) başarılı, Bunny Stream yüklemesi başarısız: ${String(e.message).slice(0, 400)}`,
      });
      await log(supabase, item, "upload", "error", `Bunny upload failed, B2 archive preserved: ${String(e.message).slice(0, 1000)}`);
      await deleteQueueRow(supabase, item);
      await refreshJobRollup(supabase, item.jobId);
      return;
    }

    await setItemStatus(supabase, item, "completed", REAL_STAGE_PROGRESS, {
      ...archiveFields,
      bunny_video_guid: bunnyResult.guid,
      bunny_embed_url: bunnyResult.embedUrl,
      bunny_thumbnail_url: bunnyResult.thumbnailUrl,
      completed_at: new Date().toISOString(),
    });
    await supabase
      .from("vault_youtube_videos")
      .update({
        bunny_video_guid: bunnyResult.guid,
        bunny_embed_url: bunnyResult.embedUrl,
        bunny_thumbnail_url: bunnyResult.thumbnailUrl,
      })
      .eq("id", item.vaultVideoId);
    await log(supabase, item, "complete", "info", `İzlenebilir kopya da Bunny Stream'e yüklendi: ${bunnyResult.guid}. Arşiv + oynatma tamamlandı.`);

    await deleteQueueRow(supabase, item);
    await refreshJobRollup(supabase, item.jobId);
  } catch (e) {
    await failItem(supabase, item, "prepare", `Unexpected error: ${e.message}`);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { runDryRunSimulation, runRealTransfer };
