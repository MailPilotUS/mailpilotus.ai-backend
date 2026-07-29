const express = require('express');
const { Tasks, Contacts } = require('../store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /v1/tasks?status=follow_up|assigned|done
router.get('/', (req, res) => {
  const status = req.query.status || 'follow_up';
  const tasks = Tasks.listByOwnerAndStatus(req.userId, status).map(Tasks.serialize);
  res.json(tasks);
});

router.post('/:id/assign', (req, res) => {
  const task = Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) return res.status(404).json({ error: 'Not found' });
  const contact = Contacts.findById(req.body.contactId);
  if (!contact || contact.ownerId !== req.userId)
    return res.status(400).json({ error: 'Unknown contact' });
  const updated = Tasks.assign(task.id, contact.id);
  res.json(Tasks.serialize(updated));
});

router.post('/:id/unassign', (req, res) => {
  const task = Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) return res.status(404).json({ error: 'Not found' });
  const updated = Tasks.unassign(task.id);
  res.json(Tasks.serialize(updated));
});

router.post('/:id/complete', (req, res) => {
  const task = Tasks.findById(req.params.id);
  if (!task || task.ownerId !== req.userId) return res.status(404).json({ error: 'Not found' });
  const updated = Tasks.complete(task.id);
  res.json(Tasks.serialize(updated));
});

module.exports = router;
