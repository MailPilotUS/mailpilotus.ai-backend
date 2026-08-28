const express = require('express');
const sgMail = require('@sendgrid/mail');
const { Tasks, Contacts } = require('../store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// GET /v1/tasks?status=follow_up|assigned|done
router.get('/', async (req, res) => {
  const status = req.query.status || 'follow_up';
  const tasks = await Tasks.listByOwnerAndStatus(req.userId, status);
  const serialized = await Promise.all(tasks.map(Tasks.serialize));
  res.json(serialized);
});

// POST /v1/tasks/text
// Creates a follow-up directly from a copied SMS/iMessage/Android text.
router.post('/text', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const task = await Tasks.create({
      ownerId: req.userId,
      fromAddress: '',
      fromName: 'Text Message',
      forwarderAddress: null,
      subject: text.length > 80 ? `${text.slice(0, 80)}...` : text,
      snippet: text,
      body: text,
    });

    const serialized = await Tasks.serialize(task);

    // The current database does not yet store sourceType, so include it
    // in this response so the app can immediately render the TEXT MESSAGE badge.
    return res.status(201).json({
      ...serialized,
      sourceType: 'text',
    });
  } catch (err) {
    console.error('Create text task failed:', err);
    return res.status(500).json({ error: 'Could not create text follow-up' });
  }
});

router.post('/:id/assign', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const contact = await Contacts.findById(req.body.contactId);
  if (!contact || contact.ownerId !== req.userId) {
    return res.status(400).json({ error: 'Unknown contact' });
  }

  const updated = await Tasks.assign(task.id, contact.id);

  // Actually forward the email to the assigned contact, plus a short
  // heads-up note above the forwarded content. Only sent if the contact
  // has an email on file (phone-only contacts are skipped for now).
  // Never fails the assign request itself if sending errors out.
  if (contact.email) {
    const originalSenderLabel = task.fromName
      ? `${task.fromName} <${task.fromAddress}>`
      : task.fromAddress;

    try {
      await sgMail.send({
        to: contact.email,
        from: 'support@mailpilotus.com',
        replyTo: task.forwarderAddress || undefined,
        subject: `Fwd: ${task.subject} (from ${task.fromName || task.fromAddress})`,
        html: `
          <p>Hi ${contact.name.split(' ')[0]},</p>
          <p>This email was assigned to you via MailPilotUS. Please follow up.</p>
          <hr />
          <p><strong>From:</strong> ${originalSenderLabel}<br/>
          <strong>Subject:</strong> ${task.subject}</p>
          <div>${(task.body || task.snippet || '').replace(/\n/g, '<br/>')}</div>
        `,
      });
    } catch (err) {
      console.error('Failed to send assign notification email:', err.message);
    }
  }

  res.json(await Tasks.serialize(updated));
});

router.post('/:id/unassign', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const updated = await Tasks.unassign(task.id);
  res.json(await Tasks.serialize(updated));
});

router.post('/:id/complete', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const updated = await Tasks.complete(task.id);
  res.json(await Tasks.serialize(updated));
});

router.patch('/:id/due-date', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const updated = await Tasks.setDueDate(task.id, req.body.dueDate || null);
  res.json(await Tasks.serialize(updated));
});

module.exports = router;
