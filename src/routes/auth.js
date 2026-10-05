const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Resend } = require('resend');
const { Users } = require('../store');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const resend = new Resend(process.env.RESEND_API_KEY);

const WEB_DOMAIN =
  process.env.WEB_DOMAIN ||
  'https://mailpiloyus-app-web.vercel.app';

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: 'email and password required',
    });
  }

  if (await Users.findByEmail(email)) {
    return res.status(409).json({
      error: 'Account already exists',
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await Users.create({
    email,
    passwordHash,
  });

  const token = signToken(user.id);

  res.json({
    token,
    user: publicUser(user),
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await Users.findByEmail(email);

  if (!user) {
    return res.status(401).json({
      error: 'Invalid email or password',
    });
  }

  const ok = await bcrypt.compare(
    password,
    user.passwordHash
  );

  if (!ok) {
    return res.status(401).json({
      error: 'Invalid email or password',
    });
  }

  const token = signToken(user.id);

  res.json({
    token,
    user: publicUser(user),
  });
});

// POST /forgot-password
// Body: { email }
//
// Always returns a generic response so this endpoint cannot
// be used to determine whether an email address has an account.
//
// Creates a one-hour password-reset token and sends the reset
// link through Resend.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'email is required',
    });
  }

  const user = await Users.findByEmail(email);

  if (user) {
    const resetToken = crypto
      .randomBytes(32)
      .toString('hex');

    const resetTokenExpiry = new Date(
      Date.now() + 60 * 60 * 1000
    );

    await Users.setResetToken(user.id, {
      resetToken,
      resetTokenExpiry,
    });

    const resetLink =
      `${WEB_DOMAIN}/reset-password?token=${resetToken}`;

    try {
      const { data, error } = await resend.emails.send({
        from: 'MailPilotUS <support@mailpilotus.com>',
        to: [user.email],
        subject: 'Reset your MailPilotUS password',

        html: `
          <p>We received a request to reset your MailPilotUS password.</p>

          <p>
            <a href="${resetLink}">
              Reset your password
            </a>
          </p>

          <p>This link expires in 1 hour.</p>

          <p>
            If you didn't request this password reset,
            you can safely ignore this email.
          </p>
        `,
      });

      if (error) {
        throw new Error(
          error.message || 'Resend failed to send reset email'
        );
      }

      console.log(
        'Password reset email sent with Resend:',
        data?.id
      );
    } catch (err) {
      console.error(
        'Failed to send reset email:',
        err.message
      );
    }
  }

  res.json({
    message:
      'If an account exists with that email, a reset link has been sent.',
  });
});

// POST /reset-password
// Body: { token, password }
//
// Verifies the token, updates the password, and clears the
// reset token so it cannot be reused.
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: 'token and password are required',
    });
  }

  const user = await Users.findByResetToken(token);

  if (!user) {
    return res.status(400).json({
      error: 'Invalid or expired reset link',
    });
  }

  const passwordHash = await bcrypt.hash(
    password,
    10
  );

  await Users.resetPassword(
    user.id,
    passwordHash
  );

  res.json({
    message: 'Password updated successfully.',
  });
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
