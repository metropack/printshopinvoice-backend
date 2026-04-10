const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

router.get('/freight-test', (_req, res) => {
  res.json({ ok: true, route: 'freight.js is live' });
});

const isEmail = (s = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

function makeTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    port === 465 ||
    String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  const base = {
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    requireTLS: !secure,
    tls: { minVersion: 'TLSv1.2' },
  };

  if (String(process.env.SMTP_DEBUG || '0') === '1') {
    base.logger = true;
    base.debug = true;
    console.log('[smtp freight]', { host: base.host, port: base.port, secure: base.secure });
  }

  return nodemailer.createTransport(base);
}

router.post('/freight', async (req, res) => {
  try {
    const {
      name = '',
      company = '',
      email = '',
      phone = '',
      pickupLocation = '',
      deliveryLocation = '',
      pickupType = '',
      deliveryType = '',
      palletCount = '',
      packagingType = '',
      length = '',
      width = '',
      height = '',
      weight = '',
      totalWeight = '',
      stackable = '',
      liftgatePickup = '',
      liftgateDelivery = '',
      insidePickup = '',
      insideDelivery = '',
      readyDate = '',
      commodity = '',
      notes = '',
    } = req.body || {};

    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    const transporter = makeTransport();
    await transporter.verify();

    const FREIGHT_TO_EMAIL =
      process.env.FREIGHT_TO_EMAIL || 'livonia@metropackandship.com';

    const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USER;
    const MAILBOX = process.env.SMTP_USER;

    const adminSubject = `🚚 Freight Quote Request — ${name || email || 'New Request'}`;

    const adminText = [
      'Type: Freight Quote',
      `Name: ${name}`,
      `Company: ${company}`,
      `Email: ${email}`,
      `Phone: ${phone}`,
      '',
      `Pickup Location: ${pickupLocation}`,
      `Delivery Location: ${deliveryLocation}`,
      `Pickup Type: ${pickupType}`,
      `Delivery Type: ${deliveryType}`,
      `Pallet Count / Pieces: ${palletCount}`,
      `Packaging Type: ${packagingType}`,
      `Length (in): ${length}`,
      `Width (in): ${width}`,
      `Height (in): ${height}`,
      `Weight Per Pallet (lbs): ${weight}`,
      `Total Shipment Weight (lbs): ${totalWeight}`,
      `Stackable: ${stackable}`,
      `Liftgate Pickup: ${liftgatePickup}`,
      `Liftgate Delivery: ${liftgateDelivery}`,
      `Inside Pickup: ${insidePickup}`,
      `Inside Delivery: ${insideDelivery}`,
      `Ready Date: ${readyDate}`,
      `Commodity: ${commodity}`,
      '',
      'Additional Notes:',
      notes,
    ].join('\n');

    await transporter.sendMail({
      from: FROM_EMAIL,
      sender: MAILBOX,
      envelope: { from: MAILBOX, to: FREIGHT_TO_EMAIL },
      to: FREIGHT_TO_EMAIL,
      replyTo: email,
      subject: adminSubject,
      text: adminText,
    });

    await transporter.sendMail({
      from: FROM_EMAIL,
      sender: MAILBOX,
      envelope: { from: MAILBOX, to: email },
      to: email,
      subject: 'We received your freight quote request',
      text:
        `Hi${name ? ' ' + name : ''},\n\n` +
        `Thanks for contacting Metro Pack And Ship. We received your freight quote request and will review your shipment details as soon as possible.\n\n` +
        `— Metro Pack And Ship`,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Freight mail error:', e);
    res.status(500).json({ error: 'Could not send freight email right now.' });
  }
});

module.exports = router;