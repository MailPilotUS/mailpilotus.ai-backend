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
 * Extract the original sender information from a forwarded email.
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
 * SendGrid inbound email webhook.
 */
router.post(
  '/sendgrid',
  upload.any(),
  async (req, res) => {
    try {
      /*
       * TEMPORARY DIAGNOSTIC LOGGING
       *
       * This tells us whether SendGrid is sending the iPhone
       * screenshot as an attachment.
       *
       * We intentionally log metadata only — not the actual
       * email body or attachment contents.
       */
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
       * Determine which MailPilotUs forwarding address
       * received the message.
       */
      const toAddress = (req.body.to || '').match(
        /[\w.+-]+@fly\.mailpilotus\.ai/i
      )?.[0];

      if (!toAddress) {
        return res
          .status(400)
          .send(
            'No recognizable MailPilotus address in To'
          );
      }

      /*
       * Find the MailPilotUs user who owns this forwarding
       * address.
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
       * SendGrid may provide the complete raw MIME email
       * in the "email" field.
       */
      const rawEmail = req.body.email;

      const parsed = rawEmail
        ? await simpleParser(rawEmail)
        : null;

      const bodyText =
        parsed?.text ||
        req.body.text ||
        '';

      /*
       * Try to identify the original sender information
       * inside the forwarded message.
       */
      const forwarded =
        extractOriginalSender(bodyText);

      /*
       * The outer From address belongs to the MailPilotUs
       * user who forwarded the message.
       */
      const forwarderAddress =
        parsed?.from?.value?.[0]?.address ||
        req.body.from ||
        undefined;

      /*
       * Determine the subject.
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
       * Determine the original sender.
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
       * Store the forwarded message body.
       */
      const bodySource =
        forwarded?.bodyAfterHeader ||
        bodyText;

      const snippet =
        bodySource.slice(0, 160);

      const body = bodySource;

      /*
       * Create the Follow-Up task.
       *
       * IMPORTANT:
       * We are NOT changing attachment storage yet.
       * First we need to see exactly how SendGrid delivers
       * the iPhone screenshot.
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
  }
);

module.exports = router;
