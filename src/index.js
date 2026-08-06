require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const taskRoutes = require('./routes/tasks');
const contactRoutes = require('./routes/contacts');
const inboundRoutes = require('./routes/inbound');
const webhookRoutes = require('./routes/webhooks');
const billingRoutes = require('./routes/billing');
const stripeWebhookRoutes = require('./routes/stripeWebhook');
const googleAuthRoutes = require('./routes/googleAuth');
const app = express();
app.use(cors());
app.use('/billing', stripeWebhookRoutes); // must come BEFORE express.json() — needs raw body for Stripe signature check
app.use(express.json());
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/v1/auth', authRoutes);
app.use('/v1/me', meRoutes);
app.use('/v1/tasks', taskRoutes);
app.use('/v1/contacts', contactRoutes);
app.use('/inbound', inboundRoutes); // e.g. /inbound/sendgrid
app.use('/webhooks', webhookRoutes); // e.g. /webhooks/revenuecat
app.use('/billing', billingRoutes); // create-checkout-session
app.use('/auth/google', googleAuthRoutes); // e.g. /auth/google/connect, /auth/google/callback
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`MailPilotus backend listening on :${port}`);
});
