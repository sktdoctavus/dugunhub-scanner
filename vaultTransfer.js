// vaultTransfer.js — processes exactly one claimed Vault backup item per call,
// either as a dry-run simulation or (when VAULT_BACKUP_DRY_RUN=false) as a real
// yt-dlp download + Backblaze B2 upload. Called from vaultBackupWorker.js after
// vault-backup-worker-tick has already claimed the item and moved it to "preparing".
const fs = require("fs");
const os = require("os");
const path = require("path");
const { downloadFullVideo, validateVideoFile } = require("./vaultDownload");
const b2 = require("./b2");

const DRY_RUN_STAGE_PROGRESS = { preparing: 10, downloading: 35, uploading: 70, verifying: 90, completed: 100 };
const REAL_STAGE_PROGRESS = {
  preparing: 10,
  downloading: 35,
  validating: 60,
  uploading_archive: 80,
  completed: 100,
  ready_for_streaming_upload: 60,
  local_only_waiting: 0,
  failed: 0,
};

// Any status in this list means "no further automatic action will happen in
// this phase" — used to decide when a job's fast_youtube_transfer items are
// all done, regardless of which of these outcomes each one landed on.
const TERMINAL_ITEM_STATUSES = [
  "completed", "failed", "cancelled", "unsupported",
  "ready_for_streaming_upload", "local_only_waiting",
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
    if (autoCompleted === autoRows.length) status = "completed";
    else if (autoCompleted === 0) status = "failed";
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
    await setItemStatus(supabase, item, "downloading", REAL_STAGE_PROGRESS);
    await log(supabase, item, "download", "info", `Worker "${workerId}" starting yt-dlp download.`);

    let downloaded;
    try {
      downloaded = await downloadFullVideo(item.sourceUrl, tmpDir);
    } catch (e) {
      await failItem(supabase, item, "download", e.message);
      return;
    }
    await log(supabase, item, "download", "info", `Downloaded ${downloaded.size} bytes (.${downloaded.ext}).`);

    await setItemStatus(supabase, item, "validating", REAL_STAGE_PROGRESS);
    try {
      const { durationSec } = await validateVideoFile(downloaded.filePath);
      await log(supabase, item, "validate", "info", `ffprobe OK — duration ~${Math.round(durationSec)}s.`);
    } catch (e) {
      await failItem(supabase, item, "validate", e.message);
      return;
    }

    if (item.storageMode === "vault_streaming") {
      // Bunny/streaming upload isn't implemented yet — stop here on purpose.
      // No bytes are kept anywhere; the temp file is deleted in `finally` below.
      await setItemStatus(supabase, item, "ready_for_streaming_upload", REAL_STAGE_PROGRESS);
      await log(supabase, item, "complete", "info",
        "İndirme ve doğrulama tamamlandı — izlenebilir kopya yükleme bir sonraki aşamada (Bunny) yapılacak.");
      await deleteQueueRow(supabase, item);
      await refreshJobRollup(supabase, item.jobId);
      return;
    }

    // vault_archive from here on.
    const md5 = await b2.md5File(downloaded.filePath);
    const originalKey = `users/${item.userId}/youtube/${item.youtubeChannelId}/${item.youtubeVideoId}/original.${downloaded.ext}`;
    const metadataKey = `users/${item.userId}/youtube/${item.youtubeChannelId}/${item.youtubeVideoId}/metadata.json`;

    await setItemStatus(supabase, item, "uploading_archive", REAL_STAGE_PROGRESS);
    await log(supabase, item, "upload", "info", `B2'ye yükleniyor: ${originalKey}`);

    try {
      await b2.uploadFile(downloaded.filePath, originalKey, downloaded.ext === "mp4" ? "video/mp4" : "application/octet-stream");
      await b2.uploadJson({
        youtubeVideoId: item.youtubeVideoId,
        youtubeChannelId: item.youtubeChannelId,
        title: item.title,
        sourceUrl: item.sourceUrl,
        downloadedAt: new Date().toISOString(),
        sizeBytes: downloaded.size,
        checksumMd5: md5,
        originalKey,
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

    await setItemStatus(supabase, item, "completed", REAL_STAGE_PROGRESS, {
      storage_object_key: originalKey,
      checksum: md5,
      bytes_total: downloaded.size,
      bytes_transferred: downloaded.size,
      completed_at: new Date().toISOString(),
    });
    await supabase.from("vault_youtube_videos").update({ backup_status: "backed_up" }).eq("id", item.vaultVideoId);
    await log(supabase, item, "complete", "info", `Arşive yüklendi ve doğrulandı: ${originalKey} (${downloaded.size} bytes).`);

    await deleteQueueRow(supabase, item);
    await refreshJobRollup(supabase, item.jobId);
  } catch (e) {
    await failItem(supabase, item, "prepare", `Unexpected error: ${e.message}`);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { runDryRunSimulation, runRealTransfer };
