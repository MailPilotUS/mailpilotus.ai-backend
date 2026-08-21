const express = require('express');
const { Contacts } = require('../store');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

// GET /v1/contacts
// Returns all contacts the user has manually saved, for populating the
// Assign screen. Contacts work with any email provider (Gmail, Outlook,
// iCloud, etc.) since MailPilotUS never connects to an external account -
// the user just types the person's name/email/phone in once and it's
// saved for future assignments.
router.get('/', async (req, res) => {
  const contacts = await Contacts.findAllByOwner(req.userId);
  res.json(
    contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone }))
  );
});

// POST /v1/contacts  { name, email?, phone? }
// Creates a new saved contact for this user.
router.post('/', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const contact = await Contacts.create({
    ownerId: req.userId,
    name: name.trim(),
    email: email || undefined,
    phone: phone || undefined,
  });
  res.json({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone });
});

module.exports = router;
