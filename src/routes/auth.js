const express = require('express');
const bcrypt = require('bcryptjs');
const { Users } = require('../store');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (Users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = Users.create({ email, passwordHash });
  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = Users.findByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    forwardingAddress: user.forwardingAddress,
    subscriptionStatus: user.subscriptionStatus,
    trialEndsAt: user.trialEndsAt,
  };
}

module.exports = router;
module.exports.publicUser = publicUser;
