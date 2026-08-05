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
 *
 * IMPORTANT: the outer message's From header is always the person doing the
 * forwarding (they're the one who sent this email to the MailPilotUS
 * address) — it is NOT the original sender. Gmail, Outlook, and Apple Mail
 * all insert a plain-text header block into the forwarded message body that
 * looks something like:
 *
 *   ---------- Forwarded message ---------
 *   From: DIANE SPECTOR <poofdlg@aol.com>
 *   Date: Sun, Aug 2, 2026 at 3:58 PM
 *   Subject: 2 dri fit shirts
 *   To: jane.k4f9@fly.mailpilotus.ai
 *
 * extractOriginalSender() scans the message body for that block and pulls
 * out the real sender's name/address/subject, and also returns the body
 * text with that boilerplate header stripped off (for a cleaner snippet).
 * If no such block is found (e.g. someone types a fresh email directly
 * to their MailPilotUS address instead of forwarding one), we fall back
 * to the outer envelope's From address, same as before.
 */
function extractOriginalSender(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);

  let fromLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^From:\s*.+@.+/i.test(lines[i].trim())) {
      fromLineIdx = i;
      break;
    }
  }
  if (fromLineIdx === -1) return null;

  const fromLine = lines[fromLineIdx].trim();
  const withName = fromLine.match(/^From:\s*(.*?)\s*<([^>]+)>\s*$/i);
  const addressOnly = fromLine.match(/^From:\s*([^\s<]+@[^\s>]+)\s*$/i);

  let fromName;
  let fromAddress;
  if (withName) {
    fromName = withName[1];
    fromAddress = withName[2];
  } else if (addressOnly) {
    fromAddress = addressOnly[1];
  } else {
    return null;
  }

  // Scan the next few lines for Subject/Date/Sent/To, which Gmail/Outlook/
  // Apple Mail all include in the forwarded header block (order varies by
  // client). Stop at the first blank line or unrecognized line — that's
  // where the actual forwarded message content begins.
  let origSubject = null;
  let bodyStartIdx = fromLineIdx + 1;
  for (let i = fromLineIdx + 1; i < Math.min(lines.length, fromLineIdx + 6); i++) {
    const line = lines[i].trim();
    if (/^Subject:\s*/i.test(line)) {
      origSubject = line.replace(/^Subject:\s*/i, '').trim();
    }
    if (/^(Date|Sent|To|Subject|Cc):/i.test(line)) {
      bodyStartIdx = i + 1;
    } else if (line === '') {
      bodyStartIdx = i + 1;
      break;
    } else {
      break;
    }
  }

  const bodyAfterHeader = lines.slice(bodyStartIdx).join('\n').trim();

  return {
    fromName: fromName ? fromName.replace(/^["']|["']$/g, '').trim() : undefined,
    fromAddress: fromAddress.trim(),
    origSubject,
    bodyAfterHeader,
  };
}

router.post('/sendgrid', upload.any(), async (req, res) => {
  try {
    const toAddress = (req.body.to || '').match(/[\w.+-]+@fly\.mailpilotus\.ai/i)?.[0];
    if (!toAddress) return res.status(400).send('No recognizable MailPilotus address in To');
    const user = await Users.findByForwardingAddress(toAddress.toLowerCase());
    if (!user) return res.status(404).send('Unknown MailPilotus address');

    const rawEmail = req.body.email; // SendGrid provides the full raw MIME in `email`
    const parsed = rawEmail ? await simpleParser(rawEmail) : null;
    const bodyText = parsed?.text || req.body.text || '';

    const forwarded = extractOriginalSender(bodyText);

    const rawSubject =
      forwarded?.origSubject || parsed?.subject || req.body.subject || '(no subject)';
    const subject = rawSubject.replace(/^(fwd?:\s*)+/i, ''); // strip leading "Fwd:" noise

    const fromAddress =
      forwarded?.fromAddress || parsed?.from?.value?.[0]?.address || req.body.from || 'unknown@sender';
    const fromName = forwarded?.fromName || parsed?.from?.value?.[0]?.name;

    const snippetSource = forwarded?.bodyAfterHeader || bodyText;
    const snippet = snippetSource.slice(0, 160);

    await Tasks.create({
      ownerId: user.id,
      fromAddress,
      fromName,
      subject,
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
