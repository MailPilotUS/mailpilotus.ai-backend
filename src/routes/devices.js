const express = require('express');
const { Expo } = require('expo-server-sdk');
const { PushTokens, Tasks } = require('../store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const expo = new Expo();

// POST /v1/devices  { token, platform }
// Registers (or re-registers) this device's Expo push token against the
// signed-in user, so the backend knows where to send push notifications
// (daily follow-up summary, due/overdue reminders, etc). Called once on
// app launch/login - safe to call repeatedly, upserts on the token itself.
router.post('/', async (req, res) => {
  const { token, platform } = req.body;
  if (!token || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ error: 'Invalid Expo push token' });
  }
  await PushTokens.upsert({ ownerId: req.userId, token, platform: platform || 'unknown' });
  res.json({ ok: true });
});

// POST /v1/devices/test-notification
// Sends a real push to every device registered for the signed-in user,
// with their actual current Follow-Up count. Exists purely to verify the
// end-to-end push pipeline (device registration -> Expo -> real device)
// during development - the eventual scheduled daily summary is separate.
router.post('/test-notification', async (req, res) => {
  const tokens = await PushTokens.findAllByOwner(req.userId);
  if (tokens.length === 0) {
    return res.status(400).json({ error: 'No registered devices for this account' });
  }
  const followUpCount = (await Tasks.listByOwnerAndStatus(req.userId, 'follow_up')).length;
  const messages = tokens
    .filter((t) => Expo.isExpoPushToken(t.token))
    .map((t) => ({
      to: t.token,
      sound: 'default',
      title: 'MailPilotUS',
      body: `You have ${followUpCount} follow-up${followUpCount === 1 ? '' : 's'} waiting.`,
      data: { screen: 'FollowUp' },
    }));
  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (err) {
      console.error('Error sending push chunk:', err);
    }
  }
  res.json({ sent: messages.length, tickets });
});

module.exports = router;
