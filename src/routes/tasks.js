const express = require('express');
const sgMail = require('@sendgrid/mail');
const { Tasks, Contacts } = require('../store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// GET /v1/tasks?status=follow_up|assigned|done
router.get('/', async (req, res) => {
  try {
    const status = req.query.status || 'follow_up';
    const tasks = await Tasks.listByOwnerAndStatus(req.userId, status);
    const serialized = await Promise.all(tasks.map(Tasks.serialize));

    res.json(serialized);
  } catch (err) {
    console.error('List tasks failed:', err);
    res.status(500).json({ error: 'Could not load tasks' });
  }
});

// POST /v1/tasks/text
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
      sourceType: 'text',
    });

    const serialized = await Tasks.serialize(task);

    return res.status(201).json({
      ...serialized,
      sourceType: 'text',
    });
  } catch (err) {
    console.error('Create text task failed:', err);

    return res.status(500).json({
      error: 'Could not create text follow-up',
    });
  }
});

// POST /v1/tasks/reminder
router.post('/reminder', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const entity = String(req.body?.entity || '').trim();
    const dueDate = req.body?.dueDate || null;

    if (!title) {
      return res.status(400).json({
        error: 'Reminder title is required',
      });
    }

    const task = await Tasks.create({
      ownerId: req.userId,
      fromAddress: '',
      fromName: entity || 'Standalone Reminder',
      forwarderAddress: null,
      subject: title,
      snippet: entity,
      body: title,
      sourceType: 'reminder',
      dueDate,
    });

    let updated = task;

    if (dueDate && Tasks.setDueDate) {
      updated = await Tasks.setDueDate(task.id, dueDate);
    }

    const serialized = await Tasks.serialize(updated);

    return res.status(201).json({
      ...serialized,
      sourceType: 'reminder',
      entity,
    });
  } catch (err) {
    console.error('Create reminder failed:', err);

    return res.status(500).json({
      error: 'Could not create reminder',
      detail: err.message,
    });
  }
});

// PATCH /v1/tasks/:id/reminder
router.patch('/:id/reminder', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const title = String(req.body?.title || '').trim();
    const entity = String(req.body?.entity || '').trim();
    const dueDate = req.body?.dueDate || null;

    if (!title) {
      return res.status(400).json({
        error: 'Reminder title is required',
      });
    }

    let updated;

    if (Tasks.updateReminder) {
      updated = await Tasks.updateReminder(
        task.id,
        title,
        entity,
        dueDate
      );
    } else {
      return res.status(501).json({
        error: 'Reminder editing is not enabled in the task store yet',
      });
    }

    const serialized = await Tasks.serialize(updated);

    return res.json({
      ...serialized,
      sourceType: 'reminder',
      entity,
    });
  } catch (err) {
    console.error('Update reminder failed:', err);

    return res.status(500).json({
      error: 'Could not update reminder',
      detail: err.message,
    });
  }
});

/*
 * GET /v1/tasks/:id/original-image
 *
 * Returns the original screenshot/image attached to a Follow-Up.
 *
 * Authentication is required and the task must belong to the
 * currently logged-in user.
 */
router.get('/:id/original-image', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({
        error: 'Not found',
      });
    }

    if (!task.originalImage) {
      return res.status(404).json({
        error: 'This follow-up does not contain an original image',
      });
    }

    const contentType =
      task.originalImageType || 'application/octet-stream';

    const filename =
      task.originalImageName || 'original-image';

    res.setHeader(
      'Content-Type',
      contentType
    );

    res.setHeader(
      'Content-Disposition',
      `inline; filename="${filename.replace(/"/g, '')}"`
    );

    res.setHeader(
      'Cache-Control',
      'private, max-age=300'
    );

    return res.send(
      Buffer.from(task.originalImage)
    );
  } catch (err) {
    console.error(
      'Load original image failed:',
      err
    );

    return res.status(500).json({
      error: 'Could not load original image',
    });
  }
});

// DELETE /v1/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!Tasks.delete) {
      return res.status(501).json({
        error: 'Task deletion is not enabled in the task store yet',
      });
    }

    await Tasks.delete(task.id);

    return res.status(204).send();
  } catch (err) {
    console.error('Delete task failed:', err);

    return res.status(500).json({
      error: 'Could not delete task',
    });
  }
});

// POST /v1/tasks/:id/assign
router.post('/:id/assign', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const contact = await Contacts.findById(req.body.contactId);

    if (!contact || contact.ownerId !== req.userId) {
      return res.status(400).json({
        error: 'Unknown contact',
      });
    }

    const updated = await Tasks.assign(
      task.id,
      contact.id
    );

    if (contact.email) {
      const originalSenderLabel = task.fromName
        ? `${task.fromName} <${task.fromAddress}>`
        : task.fromAddress;

      try {
        await sgMail.send({
          to: contact.email,
          from: 'support@mailpilotus.com',
          replyTo: task.forwarderAddress || undefined,

          subject: `Fwd: ${task.subject} (from ${
            task.fromName || task.fromAddress
          })`,

          html: `
            <p>Hi ${contact.name.split(' ')[0]},</p>
            <p>This email was assigned to you via MailPilotUS. Please follow up.</p>
            <hr />
            <p>
              <strong>From:</strong> ${originalSenderLabel}<br/>
              <strong>Subject:</strong> ${task.subject}
            </p>
            <div>
              ${(task.body || task.snippet || '').replace(
                /\n/g,
                '<br/>'
              )}
            </div>
          `,
        });
      } catch (err) {
        console.error(
          'Failed to send assign notification email:',
          err.message
        );
      }
    }

    res.json(
      await Tasks.serialize(updated)
    );
  } catch (err) {
    console.error('Assign task failed:', err);

    res.status(500).json({
      error: 'Could not assign task',
    });
  }
});

// POST /v1/tasks/:id/unassign
router.post('/:id/unassign', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const updated = await Tasks.unassign(task.id);

    res.json(
      await Tasks.serialize(updated)
    );
  } catch (err) {
    console.error('Unassign task failed:', err);

    res.status(500).json({
      error: 'Could not unassign task',
    });
  }
});

// POST /v1/tasks/:id/complete
router.post('/:id/complete', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const updated = await Tasks.complete(task.id);

    res.json(
      await Tasks.serialize(updated)
    );
  } catch (err) {
    console.error('Complete task failed:', err);

    res.status(500).json({
      error: 'Could not complete task',
    });
  }
});

// PATCH /v1/tasks/:id/due-date
router.patch('/:id/due-date', async (req, res) => {
  try {
    const task = await Tasks.findById(req.params.id);

    if (!task || task.ownerId !== req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const updated = await Tasks.setDueDate(
      task.id,
      req.body.dueDate || null
    );

    res.json(
      await Tasks.serialize(updated)
    );
  } catch (err) {
    console.error('Set due date failed:', err);

    res.status(500).json({
      error: 'Could not set due date',
    });
  }
});

module.exports = router;
