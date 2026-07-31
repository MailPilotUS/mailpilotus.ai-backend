const express = require('express');
const { Contacts } = require('../store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// POST /v1/contacts  { deviceContactId, name, email?, phone? }
// Upserts a contact the user has picked from their device address book so
// task-assignment history ("assigned to J. Cole") survives even if the
// device contact changes later.
router.post('/', async (req, res) => {
  const { deviceContactId, name, email, phone } = req.body;
  if (!deviceContactId || !name) {
    return res.status(400).json({ error: 'deviceContactId and name are required' });
  }
  const contact = await Contacts.upsert({ ownerId: req.userId, deviceContactId, name, email, phone });
  res.json({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone });
});

module.exports = router;



Let me know once done, and we'll move to file 4 of 7 (inbound.js — the one that handles incoming email).
