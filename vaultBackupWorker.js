// DugunHub Vault — backup queue poller + processor.
//
// Each tick calls the Supabase edge function `vault-backup-worker-tick` to
// atomically claim one queued transfer item and mark it "preparing" — that
// endpoint only does the cheap claim step. All real work (yt-dlp download,
// ffprobe validation, Backblaze B2 upload) or, when VAULT_BACKUP_DRY_RUN is
// not explicitly "false", the dry-run lifecycle simulation, happens here in
// Railway: it's the only piece of this pipeline with disk access and no
// execution time limit — a Deno edge function can't safely host a
// multi-minute video download.
const axios = require("axios");
const os = require("os");
const { createClient } = require("@supabase/supabase-js");
const { runDryRunSimulation, runRealTransfer } = require("./vaultTransfer");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;
const ENABLED = process.env.VAULT_BACKUP_WORKER_ENABLED === "true";
const POLL_INTERVAL_SECONDS = Math.max(
  10,
  parseInt(process.env.VAULT_BACKUP_POLL_INTERVAL_SECONDS, 10) || 30
);
// Real transfer is opt-in. Anything other than the exact string "false" keeps
// the safe dry-run simulation — no yt-dlp download, no B2 upload.
const DRY_RUN = process.env.VAULT_BACKUP_DRY_RUN !== "false";

const TICK_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/vault-backup-worker-tick` : null;
const WORKER_ID = `railway-${os.hostname()}-${process.pid}`;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

let ticking = false; // guards against overlapping ticks — real transfers can take minutes

async function tick() {
  if (ticking) {
    console.log("[vault-backup-worker] previous tick still in flight, skipping this cycle");
    return;
  }
  ticking = true;
  try {
    const res = await axios.post(
      TICK_URL,
      { workerId: WORKER_ID },
      { headers: { "x-worker-secret": WORKER_SECRET }, timeout: 20000 }
    );
    const { claimed = 0, item } = res.data || {};
    if (!claimed || !item) {
      console.log("[vault-backup-worker] tick — queue empty, nothing claimed");
      return;
    }
    if (item.alreadyHandled) {
      console.log(`[vault-backup-worker] item ${item.itemId} already at status "${item.status}", skipping`);
      return;
    }

    console.log(`[vault-backup-worker] claimed item ${item.itemId} (${item.storageMode}, dryRun=${DRY_RUN}) — "${item.title || item.youtubeVideoId}"`);
    if (!supabase) {
      console.error("[vault-backup-worker] cannot process item — SUPABASE_SERVICE_ROLE_KEY not set");
      return;
    }

    if (DRY_RUN) {
      await runDryRunSimulation(supabase, item);
    } else {
      await runRealTransfer(supabase, item, WORKER_ID);
    }
    console.log(`[vault-backup-worker] item ${item.itemId} processing finished`);
  } catch (e) {
    const status = e.response?.status;
    const message = e.response?.data?.error || e.message;
    console.error(`[vault-backup-worker] tick failed${status ? ` (HTTP ${status})` : ""}: ${message}`);
  } finally {
    ticking = false;
  }
}

function startVaultBackupPoller() {
  if (!ENABLED) {
    console.log("[vault-backup-worker] disabled (set VAULT_BACKUP_WORKER_ENABLED=true to enable)");
    return;
  }
  if (!SUPABASE_URL || !WORKER_SECRET || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[vault-backup-worker] cannot start — SUPABASE_URL, WORKER_SECRET and/or SUPABASE_SERVICE_ROLE_KEY is not set");
    return;
  }
  console.log(`[vault-backup-worker] enabled — polling every ${POLL_INTERVAL_SECONDS}s as "${WORKER_ID}" (dryRun=${DRY_RUN})`);
  tick(); // fire once on boot instead of waiting a full interval for the first pass
  setInterval(tick, POLL_INTERVAL_SECONDS * 1000);
}

module.exports = { startVaultBackupPoller };
