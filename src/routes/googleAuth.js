const express = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { Users } = require('../store');

const router = express.Router();

/**
 * Google OAuth connection flow.
 *
 * MailPilotUS uses Google authorization for:
 *
 * 1. Read-only access to Google Contacts.
 * 2. Read-only access to Gmail so MailPilotUS can
 *    recognize when a reply has been received for
 *    an email marked "Waiting for Reply".
 *
 * MailPilotUS does NOT receive permission to send,
 * delete, modify, archive, or move Gmail messages.
 *
 * Mounted at /auth/google in src/index.js.
 */
function getOAuthClient() {
  const backendUrl =
    process.env.BACKEND_URL ||
    'https://mailpilotus-ai-backend.onrender.com';

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${backendUrl}/auth/google/callback`
  );
}

/**
 * Start Google connection.
 *
 * The MailPilotUS JWT is passed in the query string
 * because this route is opened as a browser redirect.
 */
router.get('/connect', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('Missing token');
  }

  let userId;

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    userId = payload.sub;
  } catch (e) {
    return res
      .status(401)
      .send('Invalid or expired token');
  }

  const state = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

  const oauth2Client = getOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    /*
     * Offline access allows Google to provide a
     * refresh token so MailPilotUS can check for
     * replies without requiring the user to log
     * into Google every time.
     */
    access_type: 'offline',

    /*
     * Force the consent screen so an existing user
     * can grant the newly-added Gmail permission.
     */
    prompt: 'consent',

    scope: [
      /*
       * Existing Contacts permission.
       */
      'https://www.googleapis.com/auth/contacts.readonly',

      /*
       * Gmail READ ONLY.
       *
       * This allows MailPilotUS to inspect messages
       * for reply detection but does not allow it
       * to send, delete, modify, archive or move mail.
       */
      'https://www.googleapis.com/auth/gmail.readonly',
    ],

    state,
  });

  return res.redirect(url);
});

/**
 * Google OAuth callback.
 */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res
      .status(400)
      .send('Missing code or state');
  }

  let userId;

  try {
    const payload = jwt.verify(
      state,
      process.env.JWT_SECRET
    );

    userId = payload.userId;
  } catch (e) {
    return res
      .status(401)
      .send(
        'Invalid or expired state - please try connecting again.'
      );
  }

  try {
    const oauth2Client = getOAuthClient();

    const { tokens } =
      await oauth2Client.getToken(code);

    await Users.saveGoogleTokens(userId, {
      googleAccessToken:
        tokens.access_token,

      googleRefreshToken:
        tokens.refresh_token,

      googleTokenExpiry:
        tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : null,
    });

    return res.send(`
      <html>
        <body style="
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          text-align: center;
          padding: 80px 20px;
        ">
          <h2>Google connected!</h2>

          <p>
            MailPilotUS can now access your contacts
            and recognize replies to emails you are
            waiting for.
          </p>

          <p>
            You can close this window and return to
            MailPilotUS.
          </p>
        </body>
      </html>
    `);
  } catch (e) {
    console.error(
      'Google OAuth callback failed',
      e
    );

    return res
      .status(500)
      .send(
        'Something went wrong connecting your Google account. Please try again.'
      );
  }
});

module.exports = router;
