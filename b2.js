// b2.js — Backblaze B2 uploads via its S3-compatible API for Vault archive backups.
// Bucket is private; this module never generates or returns a public/signed URL.
const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const crypto = require("crypto");

function endpointUrl() {
  const raw = process.env.BACKBLAZE_ENDPOINT || "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function regionFromEndpoint() {
  // e.g. s3.eu-central-003.backblazeb2.com -> eu-central-003
  const m = (process.env.BACKBLAZE_ENDPOINT || "").match(/^s3\.([^.]+)\./);
  return m ? m[1] : "us-east-1";
}

function getClient() {
  return new S3Client({
    endpoint: endpointUrl(),
    region: regionFromEndpoint(),
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.BACKBLAZE_KEY_ID,
      secretAccessKey: process.env.BACKBLAZE_APPLICATION_KEY,
    },
  });
}

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
    Bucket: process.env.BACKBLAZE_BUCKET,
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
    Bucket: process.env.BACKBLAZE_BUCKET,
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
  const head = await client.send(new HeadObjectCommand({ Bucket: process.env.BACKBLAZE_BUCKET, Key: key }));
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
  await client.send(new DeleteObjectCommand({ Bucket: process.env.BACKBLAZE_BUCKET, Key: key }));
}

module.exports = { uploadFile, uploadJson, verifyUpload, deleteObject, md5File };
