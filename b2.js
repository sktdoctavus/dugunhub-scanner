// b2.js — Backblaze B2 uploads via its S3-compatible API for Vault archive backups.
// Bucket is private; this module never generates or returns a public/signed URL.
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// process.env values can pick up a trailing newline/space from however
// they were pasted into Railway's env var UI — an invisible difference that
// still breaks SigV4 signing and comes back from B2 as "The key '<id>' is
// not valid", showing what looks like the exact right key ID. Trim every
// credential field defensively so that class of bug can't happen here.
function envTrim(name) {
  return (process.env[name] || "").trim();
}

function keyId() { return envTrim("BACKBLAZE_KEY_ID"); }
function applicationKey() { return envTrim("BACKBLAZE_APPLICATION_KEY"); }
function bucket() { return envTrim("BACKBLAZE_BUCKET"); }

// Accepts either "s3.eu-central-003.backblazeb2.com" (documented/canonical
// form in .env.example) or "https://s3.eu-central-003.backblazeb2.com" —
// both produce an identical client, so this specific formatting choice is
// not what causes "key is not valid" errors.
function endpointUrl() {
  const raw = envTrim("BACKBLAZE_ENDPOINT");
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function endpointHost() {
  return envTrim("BACKBLAZE_ENDPOINT").replace(/^https?:\/\//, "");
}

function regionFromEndpoint() {
  // e.g. s3.eu-central-003.backblazeb2.com -> eu-central-003
  const m = envTrim("BACKBLAZE_ENDPOINT").match(/^(?:https?:\/\/)?s3\.([^.]+)\./);
  return m ? m[1] : "us-east-1";
}

function getClient() {
  return new S3Client({
    endpoint: endpointUrl(),
    region: regionFromEndpoint(),
    forcePathStyle: true,
    credentials: {
      accessKeyId: keyId(),
      secretAccessKey: applicationKey(),
    },
  });
}

// Safe startup diagnostic — never logs BACKBLAZE_APPLICATION_KEY (not even
// its length). Logs once when this module is first required, i.e. at
// process boot, so the values reflect exactly what Railway handed the
// process this deploy.
function maskKeyId(id) {
  if (!id) return "(not set)";
  if (id.length <= 8) return `${id} (${id.length} chars — unexpectedly short for a B2 key ID)`;
  return `${id.slice(0, 4)}...${id.slice(-4)} (${id.length} chars)`;
}

function logConfig() {
  const b = bucket();
  const host = endpointHost();
  const region = regionFromEndpoint();
  const appKeySet = !!applicationKey();
  console.log(
    `[b2] config — bucket=${b || "(not set)"} endpoint=${host || "(not set)"} region=${region} ` +
    `keyId=${maskKeyId(keyId())} applicationKey=${appKeySet ? "(set)" : "(not set)"}`
  );
  if (host && region === "us-east-1" && !host.includes("us-east-1")) {
    console.warn(
      `[b2] WARNING: region defaulted to "us-east-1" but endpoint host is "${host}" — ` +
      `this almost always means the region couldn't be parsed from BACKBLAZE_ENDPOINT and ` +
      `every request will sign with the wrong region, which B2 rejects as an invalid key.`
    );
  }
}
logConfig();

// Streams the file once to compute its MD5 without loading it fully into memory —
// video files can be multiple gigabytes.
function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Single-part PutObject with a known Content-Length keeps the returned ETag a
// reliable plain MD5 for verification (multipart ETags are a hash-of-hashes,
// not comparable to a whole-file MD5). B2's S3-compatible single-PUT limit is
// 5GB — larger files aren't supported by this first pass.
async function uploadFile(filePath, key, contentType) {
  const size = fs.statSync(filePath).size;
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: size,
    ContentType: contentType,
  }));
  return { size };
}

async function uploadJson(obj, key) {
  const client = getClient();
  const body = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  await client.send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: "application/json",
  }));
}

// Returns { verified, sizeMatches, etagIsMd5, md5Matches, etag, size }.
// verified is only true when size matches AND, whenever the ETag is a plain
// (non-multipart) MD5, that MD5 matches too — "verify if possible" per spec.
async function verifyUpload(key, expectedSize, expectedMd5) {
  const client = getClient();
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  const etag = (head.ETag || "").replace(/"/g, "");
  const sizeMatches = head.ContentLength === expectedSize;
  const etagIsMd5 = !!etag && !etag.includes("-");
  const md5Matches = etagIsMd5 && etag === expectedMd5;
  return {
    verified: sizeMatches && (!etagIsMd5 || md5Matches),
    sizeMatches,
    etagIsMd5,
    md5Matches,
    etag,
    size: head.ContentLength,
  };
}

async function deleteObject(key) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

// Streams an already-archived original back down from B2 — used on retry so
// a video whose B2 upload already succeeded (only a later step, like the
// Bunny upload, failed) doesn't need to be re-fetched from YouTube.
async function downloadFile(key, destPath) {
  const client = getClient();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    res.Body.pipe(writeStream);
    res.Body.on("error", reject);
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });
  const size = fs.statSync(destPath).size;
  return { filePath: destPath, size, ext: path.extname(destPath).replace(".", "") };
}

module.exports = { uploadFile, uploadJson, verifyUpload, deleteObject, downloadFile, md5File };
