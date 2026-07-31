const express = require('express');
const { Users } = require('../store');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const user = await Users.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(user));
});

module.exports = router;
