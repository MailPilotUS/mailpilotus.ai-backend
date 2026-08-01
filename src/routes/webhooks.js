const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { Users } = require('../store');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// NOTE: this route needs the raw body, not JSON-parsed — see index.js wiring instructions
router.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;

      if (userId) {
        await Users.updateSubscription(userId, { status: 'active' });
        console.log(`Subscription activated for user ${userId}`);
      } else {
        console.warn('checkout.session.completed received with no client_reference_id');
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (userId) {
        await Users.updateSubscription(userId, { status: 'canceled' });
        console.log(`Subscription canceled for user ${userId}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Error handling Stripe webhook event:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

module.exports = router;
