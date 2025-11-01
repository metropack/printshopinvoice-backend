// server/routes/mail.js (Node/Express)
import express from 'express';
import nodemailer from 'nodemailer';

const router = express.Router();
const tx = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT) || 465,
  secure: (Number(process.env.MAIL_PORT) || 465) === 465,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  from: process.env.MAIL_FROM
});

router.post('/send', async (req, res) => {
  const { to, subject, html, text } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'Missing fields' });
  await tx.sendMail({ to, subject, html, text });
  res.json({ ok: true });
});

export default router;
