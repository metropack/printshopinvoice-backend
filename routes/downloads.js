// routes/downloads.js
const express = require('express');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const router = express.Router();

const s3 = new S3Client({ region: process.env.AWS_REGION });
const bucket = process.env.S3_BUCKET;

async function sign(key, filename) {
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });
  // 60 seconds is typical; bump to 300 if you like
  return getSignedUrl(s3, cmd, { expiresIn: 60 });
}

// GET /api/download/win
router.get('/download/win', /*authenticate, subscriptionGuard,*/ async (_req, res) => {
  try {
    const key = process.env.WIN_INSTALLER_KEY;
    if (!key) return res.status(500).json({ error: 'Server missing WIN_INSTALLER_KEY' });
    const url = await sign(key, 'PrintshopInvoice-Setup.exe');
    res.json({ url });
  } catch (e) {
    console.error('sign win error', e);
    res.status(500).json({ error: 'Could not create download link' });
  }
});

// GET /api/download/mac
router.get('/download/mac', /*authenticate, subscriptionGuard,*/ async (_req, res) => {
  try {
    const key = process.env.MAC_INSTALLER_KEY;
    if (!key) return res.status(500).json({ error: 'Server missing MAC_INSTALLER_KEY' });
    const url = await sign(key, 'PrintshopInvoice.dmg');
    res.json({ url });
  } catch (e) {
    console.error('sign mac error', e);
    res.status(500).json({ error: 'Could not create download link' });
  }
});

module.exports = router;
