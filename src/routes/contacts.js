const express = require('express');
const { google } = require('googleapis');
const { Contacts, Users } = require('../store');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

// POST /v1/contacts  { deviceContactId, name, email?, phone? }
// Upserts a contact the user has picked - either from their device address
// book, or (now) from their Gmail contacts via GET /v1/contacts/google
// below - so task-assignment history ("assigned to J. Cole") survives even
// if the underlying contact changes later. deviceContactId doubles as the
// Google People API resourceName (e.g. "people/c12345") when the contact
// came from Gmail.
router.post('/', async (req, res) => {
  const { deviceContactId, name, email, phone } = req.body;
  if (!deviceContactId || !name) {
    return res.status(400).json({ error: 'deviceContactId and name are required' });
  }
  const contact = await Contacts.upsert({ ownerId: req.userId, deviceContactId, name, email, phone });
  res.json({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone });
});

// GET /v1/contacts/google
// Returns the account holder's Gmail contacts, used to populate the Assign
// screen instead of the phone's local address book. Requires the user to
// have completed the /auth/google/connect flow first; responds 409 with
// { error: 'not_connected' } if they haven't, so the app can show a
// "Connect Gmail" prompt instead of an empty list.
router.get('/google', async (req, res) => {
  const user = await Users.findById(req.userId);
  if (!user || !user.googleRefreshToken) {
    return res.status(409).json({ error: 'not_connected' });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
      access_token: user.googleAccessToken,
      refresh_token: user.googleRefreshToken,
      expiry_date: user.googleTokenExpiry ? new Date(user.googleTokenExpiry).getTime() : undefined,
    });

    // googleapis auto-refreshes the access token using the refresh_token
    // when it's expired - this listener persists the new one so we don't
    // have to re-refresh on every subsequent request.
    oauth2Client.on('tokens', async (newTokens) => {
      if (newTokens.access_token) {
        try {
          await Users.saveGoogleTokens(user.id, {
            googleAccessToken: newTokens.access_token,
            googleRefreshToken: newTokens.refresh_token, // undefined on refresh; store.js keeps the existing one
            googleTokenExpiry: newTokens.expiry_date ? new Date(newTokens.expiry_date) : user.googleTokenExpiry,
          });
        } catch (e) {
          console.error('Failed to persist refreshed Google token', e);
        }
      }
    });

    const people = google.people({ version: 'v1', auth: oauth2Client });
    const result = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      personFields: 'names,emailAddresses,phoneNumbers',
    });

    const contacts = (result.data.connections || [])
      .filter((p) => p.names && p.names[0] && p.names[0].displayName)
      .map((p) => ({
        id: p.resourceName, // e.g. "people/c12345" - used as deviceContactId for de-dupe
        name: p.names[0].displayName,
        email: p.emailAddresses && p.emailAddresses[0] ? p.emailAddresses[0].value : undefined,
        phone: p.phoneNumbers && p.phoneNumbers[0] ? p.phoneNumbers[0].value : undefined,
      }));

    res.json(contacts);
  } catch (e) {
    console.error('Fetching Google contacts failed', e);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

module.exports = router;
