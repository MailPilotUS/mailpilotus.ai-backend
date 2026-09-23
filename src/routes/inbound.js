const express = require('express');
const multer = require('multer');
const { simpleParser } = require('mailparser');
const { Expo } = require('expo-server-sdk');
const { Users, Tasks, PushTokens } = require('../store');

const router = express.Router();
const expo = new Expo();

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
 * Send a push notification to all registered devices
 * belonging to a MailPilotUs user.
 *
 * Push failures NEVER prevent the Follow-Up from being created.
 */
async function sendNewFollowUpNotification(
  ownerId,
  taskId,
  subject,
  fromName
) {
  try {
    const tokens = await PushTokens.findAllByOwner(ownerId);

    if (!tokens || tokens.length === 0) {
      console.log(
        'No registered push devices for user:',
        ownerId
      );
      return;
    }

    const validTokens = tokens.filter((record) =>
      Expo.isExpoPushToken(record.token)
    );

    if (validTokens.length === 0) {
      console.log(
        'No valid Expo push tokens for user:',
        ownerId
      );
      return;
    }

    const cleanSubject =
      subject && subject !== '(no subject)'
        ? subject
        : 'New Follow-Up';

    const sender =
      fromName && fromName.trim()
        ? fromName.trim()
        : null;

    const notificationBody = sender
      ? `${sender}: ${cleanSubject}`
      : cleanSubject;

    const messages = validTokens.map((record) => ({
      to: record.token,
      sound: 'default',
      title: 'MailPilotUs',
      body: notificationBody,

      data: {
        screen: 'FollowUp',
        taskId,
      },
    }));

    const chunks =
      expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
      try {
        const tickets =
          await expo.sendPushNotificationsAsync(chunk);

        console.log(
          'New Follow-Up push sent:',
          tickets
        );
      } catch (err) {
        console.error(
          'Error sending Follow-Up push chunk:',
          err
        );
      }
    }
  } catch (err) {
    console.error(
      'New Follow-Up notification failed:',
      err
    );
  }
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
    const createdTask = await Tasks.create({
      ownerId: user.id,
      fromAddress,
      fromName,
      forwarderAddress,
      subject,
      snippet,
      body,

      sourceType: 'email',

      originalImage:
        imageAttachment?.content || null,

      originalImageType:
        imageAttachment?.contentType || null,

      originalImageName:
        imageAttachment?.filename || null,
    });

    /*
     * Immediately acknowledge SendGrid.
     *
     * The Follow-Up is safely stored at this point.
     */
    res.status(200).send('OK');

    /*
     * Now send the user's push notification.
     *
     * A push failure cannot undo or interfere with
     * the Follow-Up that was just created.
     */
    sendNewFollowUpNotification(
      user.id,
      createdTask.id,
      subject,
      fromName
    ).catch((err) => {
      console.error(
        'Background Follow-Up notification error:',
        err
      );
    });
  } catch (err) {
    console.error(
      'Inbound parse failed',
      err
    );

    if (!res.headersSent) {
      res
        .status(500)
        .send('Internal error');
    }
  }
});

module.exports = router;
