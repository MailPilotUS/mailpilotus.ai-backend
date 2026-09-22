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
    const toAddress = (req.body.to || '').match(
      /[\w.+-]+@fly\.mailpilotus\.ai/i
    )?.[0];

    if (!toAddress) {
      return res
        .status(400)
        .send('No recognizable MailPilotus address in To');
    }

    const user = await Users.findByForwardingAddress(
      toAddress.toLowerCase()
    );

    if (!user) {
      return res
        .status(404)
        .send('Unknown MailPilotus address');
    }

    /*
     * Parse the complete raw MIME email.
     */
    const rawEmail = req.body.email;

    const parsed = rawEmail
      ? await simpleParser(rawEmail)
      : null;

    /*
     * Look for an image attachment.
     *
     * Our iPhone test confirmed that the forwarded
     * screenshot appears here as image/png.
     */
    const imageAttachment =
      (parsed?.attachments || []).find(
        (attachment) =>
          attachment.contentType &&
          attachment.contentType.startsWith('image/') &&
          attachment.content
      ) || null;

    if (imageAttachment) {
      console.log('Inbound screenshot detected:', {
        filename: imageAttachment.filename || null,
        contentType: imageAttachment.contentType,
        size:
          imageAttachment.size ||
          imageAttachment.content.length,
      });
    }

    /*
     * Get the plain-text portion of the message.
     */
    const bodyText =
      parsed?.text ||
      req.body.text ||
      '';

    const forwarded =
      extractOriginalSender(bodyText);

    /*
     * Address of the person who forwarded the message.
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
     * Create the Follow-Up.
     *
     * If an image was attached, save the actual binary
     * screenshot plus its type and filename.
     */
    await Tasks.create({
      ownerId: user.id,
      fromAddress,
      fromName,
      forwarderAddress,
      subject,
      snippet,
      body,

      originalImage:
        imageAttachment?.content || null,

      originalImageType:
        imageAttachment?.contentType || null,

      originalImageName:
        imageAttachment?.filename || null,
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
