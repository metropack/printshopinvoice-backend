const express = require('express');
const router = express.Router();
const { sendMail } = require('../utils/mailer');

const isEmail = (s = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

router.get('/freight-test', (_req, res) => {
  res.json({ ok: true, route: 'freight.js is live' });
});

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

    const cleanEmail = String(email).trim();
    if (!isEmail(cleanEmail)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    const freightToRaw = process.env.FREIGHT_TO_EMAIL;
    const freightTo = String(freightToRaw || 'livonia@metropackandship.com').trim();

    if (!isEmail(freightTo)) {
      console.error('Freight mail config error: invalid FREIGHT_TO_EMAIL', {
        freightToRaw,
        freightTo,
      });
      return res.status(500).json({ error: 'Freight email recipient is not configured correctly.' });
    }

    const adminSubject = `🚚 Freight Quote Request — ${String(name).trim() || cleanEmail || 'New Request'}`;

    const adminText = [
      'Type: Freight Quote',
      `Name: ${String(name).trim()}`,
      `Company: ${String(company).trim()}`,
      `Email: ${cleanEmail}`,
      `Phone: ${String(phone).trim()}`,
      '',
      `Pickup Location: ${String(pickupLocation).trim()}`,
      `Delivery Location: ${String(deliveryLocation).trim()}`,
      `Pickup Type: ${String(pickupType).trim()}`,
      `Delivery Type: ${String(deliveryType).trim()}`,
      `Pallet Count / Pieces: ${String(palletCount).trim()}`,
      `Packaging Type: ${String(packagingType).trim()}`,
      `Length (in): ${String(length).trim()}`,
      `Width (in): ${String(width).trim()}`,
      `Height (in): ${String(height).trim()}`,
      `Weight Per Pallet (lbs): ${String(weight).trim()}`,
      `Total Shipment Weight (lbs): ${String(totalWeight).trim()}`,
      `Stackable: ${String(stackable).trim()}`,
      `Liftgate Pickup: ${String(liftgatePickup).trim()}`,
      `Liftgate Delivery: ${String(liftgateDelivery).trim()}`,
      `Inside Pickup: ${String(insidePickup).trim()}`,
      `Inside Delivery: ${String(insideDelivery).trim()}`,
      `Ready Date: ${String(readyDate).trim()}`,
      `Commodity: ${String(commodity).trim()}`,
      '',
      'Additional Notes:',
      String(notes).trim(),
    ].join('\n');

    await sendMail({
      to: freightTo,
      subject: adminSubject,
      text: adminText,
      replyTo: cleanEmail,
      from: 'Metro Pack And Ship <livonia@metropackandship.com>',
    });

    await sendMail({
      to: cleanEmail,
      subject: 'We received your freight quote request',
      text:
        `Hi${String(name).trim() ? ' ' + String(name).trim() : ''},\n\n` +
        `Thanks for contacting Metro Pack And Ship. We received your freight quote request and will review your shipment details as soon as possible.\n\n` +
        `— Metro Pack And Ship`,
      replyTo: freightTo,
      from: 'Metro Pack And Ship <livonia@metropackandship.com>',
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Freight mail error:', e);
    res.status(500).json({ error: e?.message || 'Could not send freight email right now.' });
  }
});

module.exports = router;