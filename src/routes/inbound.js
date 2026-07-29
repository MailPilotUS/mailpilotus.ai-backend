const express = require('express');
const multer = require('multer');
const { simpleParser } = require('mailparser');
const { Users, Tasks } = require('../store');

const router = express.Router();
const upload = multer();

/**
 * Inbound email webhook.
 *
 * How mail actually gets here: mailpilotus.ai's MX records point the
 * `fly.mailpilotus.ai` subdomain at an inbound email parsing provider
 * (SendGrid Inbound Parse or Mailgun Routes — see /docs/deployment-guide.docx,
 * "Setting up the forwarding address"). That provider receives the raw SMTP
 * message addressed to e.g. jane.k4f9@fly.mailpilotus.ai and POSTs it here
 * as multipart/form-data (SendGrid's format is assumed below; Mailgun's
 * field names differ slightly but the parsing approach is the same).
 *
 * We look up which MailPilotus user owns that address, then create a new
 * Follow-Up task from the ORIGINAL sender/subject of the forwarded message
 * (mail clients set the forwarded email's From/Subject inside the body as
 * "Fwd: ..." — we take the outer envelope's to-address to find the user,
 * and parse the raw MIME to recover the original from/subject/snippet).
 */
router.post('/sendgrid', upload.any(), async (req, res) => {
  try {
    const toAddress = (req.body.to || '').match(/[\w.+-]+@fly\.mailpilotus\.ai/i)?.[0];
    if (!toAddress) return res.status(400).send('No recognizable MailPilotus address in To');

    const user = Users.findByForwardingAddress(toAddress.toLowerCase());
    if (!user) return res.status(404).send('Unknown MailPilotus address');

    const rawEmail = req.body.email; // SendGrid provides the full raw MIME in `email`
    const parsed = rawEmail ? await simpleParser(rawEmail) : null;

    const subject = parsed?.subject || req.body.subject || '(no subject)';
    const fromAddress = parsed?.from?.value?.[0]?.address || req.body.from || 'unknown@sender';
    const fromName = parsed?.from?.value?.[0]?.name;
    const snippet = (parsed?.text || req.body.text || '').slice(0, 160);

    Tasks.create({
      ownerId: user.id,
      fromAddress,
      fromName,
      subject: subject.replace(/^(fwd?:\s*)+/i, ''), // strip leading "Fwd:" noise
      snippet,
    });

    // TODO production: also persist the raw MIME to object storage (S3) and
    // set Task.rawEmailUrl, and send a push notification to the user's
    // device (expo-server-sdk) so the Follow-Up list badge updates
    // immediately, not just next time the app wakes.

    res.status(200).send('OK');
  } catch (err) {
    console.error('Inbound parse failed', err);
    res.status(500).send('Internal error');
  }
});

module.exports = router;
