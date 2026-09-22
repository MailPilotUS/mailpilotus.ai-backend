const express = require('express');
const multer = require('multer');
const { simpleParser } = require('mailparser');
const { Users, Tasks } = require('../store');

const router = express.Router();

const upload = multer({
  limits: {
    fieldSize: 25 * 1024 * 1024,
  },
});

/**
 * Extract original sender information from a forwarded email.
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

  const withName = fromLine.match(
    /^From:\s*(.*?)\s*<([^>]+)>\s*$/i
  );

  const addressOnly = fromLine.match(
    /^From:\s*([^\s<]+@[^\s>]+)\s*$/i
  );

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

  let origSubject = null;
  let bodyStartIdx = fromLineIdx + 1;

  for (
    let i = fromLineIdx + 1;
    i < Math.min(lines.length, fromLineIdx + 6);
    i++
  ) {
    const line = lines[i].trim();

    if (/^Subject:\s*/i.test(line)) {
      origSubject = line
        .replace(/^Subject:\s*/i, '')
        .trim();
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

  const bodyAfterHeader = lines
    .slice(bodyStartIdx)
    .join('\n')
    .trim();

  return {
    fromName: fromName
      ? fromName.replace(/^["']|["']$/g, '').trim()
      : undefined,

    fromAddress: fromAddress.trim(),

    origSubject,

    bodyAfterHeader,
  };
}

/**
 * SendGrid inbound webhook.
 */
router.post('/sendgrid', upload.any(), async (req, res) => {
  try {
    console.log('=== INBOUND SENDGRID MESSAGE ===');

    console.log(
      'Body fields:',
      Object.keys(req.body || {})
    );

    console.log(
      'Uploaded files:',
      (req.files || []).map((file) => ({
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      }))
    );

    /*
     * Find the MailPilotUs forwarding address.
     */
    const toAddress = (req.body.to || '').match(
      /[\w.+-]+@fly\.mailpilotus\.ai/i
    )?.[0];

    if (!toAddress) {
      return res
        .status(400)
        .send('No recognizable MailPilotus address in To');
    }

    /*
     * Find the MailPilotUs user.
     */
    const user =
      await Users.findByForwardingAddress(
        toAddress.toLowerCase()
      );

    if (!user) {
      return res
        .status(404)
        .send('Unknown MailPilotus address');
    }

    /*
     * Parse the full raw MIME email.
     */
    const rawEmail = req.body.email;

    const parsed = rawEmail
      ? await simpleParser(rawEmail)
      : null;

    /*
     * DIAGNOSTIC:
     *
     * Apple Mail may place an attached screenshot inside
     * the raw MIME message instead of SendGrid exposing it
     * through req.files.
     *
     * We log metadata ONLY.
     */
    console.log(
      'Parsed MIME attachments:',
      (parsed?.attachments || []).map((attachment) => ({
        filename: attachment.filename || null,
        contentType: attachment.contentType || null,
        size:
          attachment.size ||
          attachment.content?.length ||
          0,
        contentDisposition:
          attachment.contentDisposition || null,
        cid: attachment.cid || null,
      }))
    );

    /*
     * Also identify image attachments specifically.
     */
    const imageAttachments =
      (parsed?.attachments || []).filter(
        (attachment) =>
          attachment.contentType &&
          attachment.contentType.startsWith('image/')
      );

    console.log(
      'Image attachment count:',
      imageAttachments.length
    );

    console.log(
      'Image attachment types:',
      imageAttachments.map((attachment) => ({
        filename: attachment.filename || null,
        contentType: attachment.contentType,
        size:
          attachment.size ||
          attachment.content?.length ||
          0,
      }))
    );

    /*
     * Continue processing the message normally.
     */
    const bodyText =
      parsed?.text ||
      req.body.text ||
      '';

    const forwarded =
      extractOriginalSender(bodyText);

    /*
     * Address of the person forwarding the message.
     */
    const forwarderAddress =
      parsed?.from?.value?.[0]?.address ||
      req.body.from ||
      undefined;

    /*
     * Determine subject.
     */
    const rawSubject =
      forwarded?.origSubject ||
      parsed?.subject ||
      req.body.subject ||
      '(no subject)';

    const subject = rawSubject.replace(
      /^(fwd?:\s*)+/i,
      ''
    );

    /*
     * Determine sender.
     */
    const fromAddress =
      forwarded?.fromAddress ||
      parsed?.from?.value?.[0]?.address ||
      req.body.from ||
      'unknown@sender';

    const fromName =
      forwarded?.fromName ||
      parsed?.from?.value?.[0]?.name;

    /*
     * Message body.
     */
    const bodySource =
      forwarded?.bodyAfterHeader ||
      bodyText;

    const snippet =
      bodySource.slice(0, 160);

    const body = bodySource;

    /*
     * Keep existing Follow-Up creation working.
     */
    await Tasks.create({
      ownerId: user.id,
      fromAddress,
      fromName,
      forwarderAddress,
      subject,
      snippet,
      body,
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error(
      'Inbound parse failed',
      err
    );

    res
      .status(500)
      .send('Internal error');
  }
});

module.exports = router;
