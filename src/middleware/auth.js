const express = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { Users } = require('../store');
const router = express.Router();
/**
 * Google OAuth (Gmail contacts) connect flow.
 *
 * Mounted at /auth/google in src/index.js, matching the redirect URI
 * registered in Google Cloud Console:
 *   https://mailpilotus-ai-backend.onrender.com/auth/google/callback
 *
 * Flow:
 *  1. The app calls GET /auth/google/connect?token=<mailpilotus JWT> in a
 *     browser/WebView (a full-page redirect, not a fetch - so the JWT has
 *     to travel as a query param here rather than an Authorization header).
 *  2. We verify that JWT to find out which MailPilotus user is connecting,
 *     then redirect to Google's consent screen with that user's id packed
 *     into a short-lived signed `state` value (Google echoes `state` back
 *     to us untouched, so this is how we know who to attach tokens to).
 *  3. Google redirects back to /auth/google/callback with a `code`. We
 *     verify `state`, exchange `code` for access/refresh tokens, and save
 *     them on the User row.
 */
function getOAuthClient() {
  const backendUrl = process.env.BACKEND_URL || 'https://mailpilotus-ai-backend.onrender.com';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${backendUrl}/auth/google/callback`
  );
}
router.get('/connect', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  let userId;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    userId = payload.sub;
  } catch (e) {
    return res.status(401).send('Invalid or expired token');
  }
  const state = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent', // force a fresh refresh_token even on repeat connects
    scope: ['https://www.googleapis.com/auth/contacts.readonly'],
    state,
  });
  res.redirect(url);
});
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');
  let userId;
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    userId = payload.userId;
  } catch (e) {
    return res.status(401).send('Invalid or expired state - please try connecting again.');
  }
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    await Users.saveGoogleTokens(userId, {
      googleAccessToken: tokens.access_token,
      googleRefreshToken: tokens.refresh_token, // only present on first-ever consent
      googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    });
    res.send(`
      <html>
        <body style="font-family: -apple-system, sans-serif; text-align:center; padding-top: 80px;">
          <h2>Gmail connected!</h2>
          <p>You can close this window and return to MailPilotus.</p>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('Google OAuth callback failed', e);
    res.status(500).send('Something went wrong connecting your Gmail account. Please try again.');
  }
});
module.exports = router;
