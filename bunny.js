// bunny.js — server-side Bunny Stream upload for Vault, reusing the SAME
// Library/API key/pull zone the existing manual-upload flow already uses
// (get-bunny-upload-url edge function + UploadVideoPage.tsx), and producing
// the exact same GUID -> embed/thumbnail URL shape so Vault-created videos
// render identically to manually uploaded ones. Bunny Storage Zones are
// never used here — Stream only, same as the manual flow.
//
// Server-side upload uses Bunny's direct (non-TUS) endpoint instead of the
// TUS protocol the browser uses. TUS exists so the browser never has to see
// the real API key (it gets a short-lived signed token instead) — that
// constraint doesn't apply here, since this code already runs with the real
// AccessKey as a server-side secret.
const axios = require("axios");
const fs = require("fs");

function libId() { return process.env.BUNNY_STREAM_LIBRARY_ID; }
function apiKey() { return process.env.BUNNY_STREAM_API_KEY; }
function pullZone() { return process.env.BUNNY_STREAM_PULL_ZONE; }

function isConfigured() {
  return !!(libId() && apiKey() && pullZone());
}

// Identical URL shapes to what get-bunny-upload-url returns to the browser —
// kept in sync on purpose.
function embedUrlFor(guid) {
  return `https://iframe.mediadelivery.net/embed/${libId()}/${guid}?autoplay=false`;
}
function thumbnailUrlFor(guid) {
  return `https://${pullZone()}/${guid}/thumbnail.jpg`;
}

async function createVideo(title, { maxAttempts = 2 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post(
        `https://video.bunnycdn.com/library/${libId()}/videos`,
        { title },
        { headers: { AccessKey: apiKey(), "Content-Type": "application/json" }, timeout: 30000 }
      );
      const guid = res.data?.guid;
      if (!guid) throw new Error(`no guid in response: ${JSON.stringify(res.data).slice(0, 300)}`);
      return guid;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const detail = lastErr?.response?.data ? JSON.stringify(lastErr.response.data).slice(0, 300) : lastErr?.message;
  throw new Error(`Bunny create-video failed after ${maxAttempts} attempts: ${detail}`);
}

// Streams the file to Bunny — never loads it fully into memory. Retries the
// whole file on transient failure; each attempt opens a fresh read stream
// since a stream can only be consumed once.
async function uploadVideo(filePath, guid, { onProgress, maxAttempts = 3 } = {}) {
  const size = fs.statSync(filePath).size;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stream = fs.createReadStream(filePath);
      if (onProgress) {
        let uploaded = 0;
        stream.on("data", (chunk) => {
          uploaded += chunk.length;
          onProgress(uploaded, size);
        });
      }
      await axios.put(`https://video.bunnycdn.com/library/${libId()}/videos/${guid}`, stream, {
        headers: {
          AccessKey: apiKey(),
          "Content-Type": "application/octet-stream",
          "Content-Length": size,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 3600000,
      });
      return { size };
    } catch (e) {
      lastErr = e;
      const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      console.error(`[bunny] upload attempt ${attempt}/${maxAttempts} failed: ${detail}`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw new Error(`Bunny upload failed after ${maxAttempts} attempts: ${lastErr?.message}`);
}

// Convenience wrapper — create + upload + URL construction in one call.
async function uploadToBunnyStream(filePath, title, { onProgress } = {}) {
  const guid = await createVideo(title);
  const { size } = await uploadVideo(filePath, guid, { onProgress });
  return { guid, size, embedUrl: embedUrlFor(guid), thumbnailUrl: thumbnailUrlFor(guid) };
}

module.exports = { isConfigured, createVideo, uploadVideo, embedUrlFor, thumbnailUrlFor, uploadToBunnyStream };
