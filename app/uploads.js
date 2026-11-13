'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const uploadDir = path.join(config.dataDir, 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Middleware that accepts up to `max` photos in `field`. Problems are left in req.photoError rather than thrown. */
function photos(field, max) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
    }),
    limits: { fileSize: config.maxPhotoBytes, files: max, fields: 300 },
    fileFilter: (req, file, cb) => {
      if (EXT[file.mimetype]) return cb(null, true);
      req.photoError = 'Photos must be JPEG, PNG, WebP or GIF images.';
      cb(null, false);
    },
  }).array(field, max);
  return (req, res, next) => upload(req, res, (err) => {
    if (err) {
      req.photoError = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is larger than 10 MB.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `No more than ${max} photos.` : 'The photos could not be uploaded.';
    }
    req.body = req.body || {};
    // When the upload is refused part-way, multer has already removed what it saved.
    req.files = err ? [] : req.files || [];
    next();
  });
}

/** Check the file really is the image type it claims to be. */
function looksLikeImage(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  const hex = b.toString('hex');
  return hex.startsWith('ffd8ff') || hex.startsWith('89504e47') || b.toString('latin1', 0, 4) === 'GIF8' ||
    (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
}

const remove = (name) => { if (name) fs.rm(path.join(uploadDir, path.basename(name)), { force: true }, () => {}); };

module.exports = { uploadDir, photos, looksLikeImage, remove };
