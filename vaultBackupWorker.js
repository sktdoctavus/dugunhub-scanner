// DugunHub Vault — backup queue poller.
//
// Calls the Supabase edge function `vault-backup-worker-tick` on an
// interval, authenticated with the same WORKER_SECRET Supabase already uses
// to call INTO this service (see index.js's `auth` middleware) — no new
// secret needed on either side.
//
// Phase 4 foundation only: the tick endpoint claims queued items and moves
// them queued -> preparing to prove the pipeline works. It does not download
// from YouTube or upload to Bunny. That logic lands in a later phase.
const axios = require("axios");
const os = require("os");

const SUPABASE_URL = process.env.SUPABASE_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const ENABLED = process.env.VAULT_BACKUP_WORKER_ENABLED === "true";
const POLL_INTERVAL_SECONDS = Math.max(
  10,
  parseInt(process.env.VAULT_BACKUP_POLL_INTERVAL_SECONDS, 10) || 30
);

const TICK_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/vault-backup-worker-tick` : null;
const WORKER_ID = `railway-${os.hostname()}-${process.pid}`;

let ticking = false; // guards against overlapping calls if a tick is slow

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
    const { claimed = 0, items = [] } = res.data || {};
    if (claimed > 0) {
      const ids = items.map((i) => i.itemId).join(", ");
      console.log(`[vault-backup-worker] claimed ${claimed} item(s) -> preparing: ${ids}`);
    } else {
      console.log("[vault-backup-worker] tick — queue empty, nothing claimed");
    }
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
  if (!SUPABASE_URL || !WORKER_SECRET) {
    console.error("[vault-backup-worker] cannot start — SUPABASE_URL and/or WORKER_SECRET is not set");
    return;
  }
  console.log(`[vault-backup-worker] enabled — polling every ${POLL_INTERVAL_SECONDS}s as "${WORKER_ID}"`);
  tick(); // fire once on boot instead of waiting a full interval for the first pass
  setInterval(tick, POLL_INTERVAL_SECONDS * 1000);
}

module.exports = { startVaultBackupPoller };
