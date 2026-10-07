const express = require('express');
const { google } = require('googleapis');
const { Expo } = require('expo-server-sdk');
const {
  Users,
  Tasks,
  PushTokens,
} = require('../store');
const {
  requireAuth,
} = require('../middleware/auth');

const router = express.Router();
const expo = new Expo();

router.use(requireAuth);

/*
 * Create an authorized Google client for a user.
 */
function createGoogleClient(user) {
  const backendUrl =
    process.env.BACKEND_URL ||
    'https://mailpilotus-ai-backend.onrender.com';

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${backendUrl}/auth/google/callback`
  );

  oauth2Client.setCredentials({
    access_token:
      user.googleAccessToken || undefined,

    refresh_token:
      user.googleRefreshToken || undefined,

    expiry_date:
      user.googleTokenExpiry
        ? new Date(
            user.googleTokenExpiry
          ).getTime()
        : undefined,
  });

  return oauth2Client;
}

/*
 * Remove common reply/forward prefixes so subjects
 * can be compared reliably.
 */
function normalizeSubject(subject) {
  return String(subject || '')
    .replace(
      /^(\s*(re|fw|fwd)\s*:\s*)+/i,
      ''
    )
    .trim()
    .toLowerCase();
}

/*
 * Read one Gmail header.
 */
function getHeader(headers, name) {
  const header = (headers || []).find(
    (item) =>
      String(item.name || '').toLowerCase() ===
      name.toLowerCase()
  );

  return header?.value || '';
}

/*
 * Extract an email address from a Gmail From header.
 */
function extractEmailAddress(value) {
  const text = String(value || '').trim();

  const angleMatch =
    text.match(/<([^>]+@[^>]+)>/);

  if (angleMatch) {
    return angleMatch[1]
      .trim()
      .toLowerCase();
  }

  const addressMatch =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );

  return addressMatch
    ? addressMatch[0].toLowerCase()
    : '';
}

/*
 * Notify the user that a reply was received.
 */
async function sendReplyReceivedNotification(
  ownerId,
  task
) {
  try {
    const tokens =
      await PushTokens.findAllByOwner(ownerId);

    const validTokens = (tokens || []).filter(
      (record) =>
        Expo.isExpoPushToken(record.token)
    );

    if (validTokens.length === 0) {
      return;
    }

    const messages = validTokens.map(
      (record) => ({
        to: record.token,
        sound: 'default',
        title: 'Reply Received',
        body:
          task.subject ||
          'A reply you were waiting for has arrived.',

        data: {
          screen: 'FollowUp',
          taskId: task.id,
        },
      })
    );

    const chunks =
      expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(
          chunk
        );
      } catch (err) {
        console.error(
          'Reply notification push failed:',
          err
        );
      }
    }
  } catch (err) {
    console.error(
      'Reply notification failed:',
      err
    );
  }
}

/*
 * POST /v1/gmail-replies/check
 *
 * Check the connected Gmail account for replies to
 * active Waiting-for-Reply tasks.
 */
router.post('/check', async (req, res) => {
  try {
    const user =
      await Users.findById(req.userId);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    if (
      !user.googleAccessToken &&
      !user.googleRefreshToken
    ) {
      return res.status(400).json({
        error: 'Google account is not connected',
        needsGoogleConnection: true,
      });
    }

    const waitingTasks =
      await Tasks.findWaitingForReply(
        req.userId
      );

    if (
      !waitingTasks ||
      waitingTasks.length === 0
    ) {
      return res.json({
        checked: 0,
        repliesFound: 0,
        tasks: [],
      });
    }

    const auth =
      createGoogleClient(user);

    const gmail = google.gmail({
      version: 'v1',
      auth,
    });

    const repliesFound = [];

    /*
     * Check each Waiting-for-Reply item separately.
     *
     * We use both sender and subject to reduce the
     * chance of matching an unrelated email.
     */
    for (const task of waitingTasks) {
      const sender = String(
        task.fromAddress || ''
      )
        .trim()
        .toLowerCase();

      const subject =
        normalizeSubject(task.subject);

      if (!sender || !subject) {
        continue;
      }

      /*
       * Only look for messages received after the
       * original Follow-Up was created.
       */
      const receivedAt =
        task.receivedAt
          ? new Date(task.receivedAt)
          : new Date();

      const afterTimestamp =
        Math.floor(
          receivedAt.getTime() / 1000
        );

      const query =
        `from:${sender} ` +
        `after:${afterTimestamp}`;

      const listResponse =
        await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: 25,
        });

      const messages =
        listResponse.data.messages || [];

      let matched = false;

      for (const message of messages) {
        const messageResponse =
          await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'metadata',
            metadataHeaders: [
              'From',
              'Subject',
              'Date',
            ],
          });

        const headers =
          messageResponse.data.payload
            ?.headers || [];

        const gmailFrom =
          extractEmailAddress(
            getHeader(headers, 'From')
          );

        const gmailSubject =
          normalizeSubject(
            getHeader(headers, 'Subject')
          );

        if (
          gmailFrom === sender &&
          gmailSubject === subject
        ) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        continue;
      }

      const updated =
        await Tasks.markReplyReceived(
          task.id
        );

      const serialized =
        await Tasks.serialize(updated);

      repliesFound.push(serialized);

      sendReplyReceivedNotification(
        req.userId,
        updated
      ).catch((err) => {
        console.error(
          'Background reply notification failed:',
          err
        );
      });
    }

    return res.json({
      checked: waitingTasks.length,
      repliesFound:
        repliesFound.length,
      tasks: repliesFound,
    });
  } catch (err) {
    console.error(
      'Gmail reply check failed:',
      err
    );

    /*
     * Google commonly returns 401/403 if Gmail
     * permission has not yet been granted.
     */
    const status =
      err?.response?.status ||
      err?.code;

    if (
      status === 401 ||
      status === 403
    ) {
      return res.status(401).json({
        error:
          'Gmail permission is required',
        needsGoogleConnection: true,
      });
    }

    return res.status(500).json({
      error:
        'Could not check Gmail for replies',
    });
  }
});

module.exports = router;
