const express = require('express');
const { Tasks, Contacts } = require('../store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /v1/tasks?status=follow_up|assigned|done
router.get('/', async (req, res) => {
  const status = req.query.status || 'follow_up';
  const tasks = await Tasks.listByOwnerAndStatus(req.userId, status);
  const serialized = await Promise.all(tasks.map(Tasks.serialize));
  res.json(serialized);
});

router.post('/:id/assign', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) return res.status(404).json({ error: 'Not found' });
  const contact = await Contacts.findById(req.body.contactId);
  if (!contact || contact.ownerId !== req.userId)
    return res.status(400).json({ error: 'Unknown contact' });
  const updated = await Tasks.assign(task.id, contact.id);
  res.json(await Tasks.serialize(updated));
});

router.post('/:id/unassign', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) return res.status(404).json({ error: 'Not found' });
  const updated = await Tasks.unassign(task.id);
  res.json(await Tasks.serialize(updated));
});

router.post('/:id/complete', async (req, res) => {
  const task = await Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) return res.status(404).json({ error: 'Not found' });
  const updated = await Tasks.complete(task.id);
  res.json(await Tasks.serialize(updated));
});

module.exports = router;
