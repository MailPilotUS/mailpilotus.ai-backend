const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { requireAuth } = require('../middleware/auth'); // adjust path if your auth middleware lives elsewhere
const { Users } = require('../store');



const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEB_DOMAIN = process.env.WEB_DOMAIN || 'https://mailpilotus.com';

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const { priceId } = req.body;
   const user = await Users.findById(req.userId);
if (!user) {
  return res.status(401).json({ error: 'User not found' });
}
    if (!priceId) {
      return res.status(400).json({ error: 'priceId is required' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      client_reference_id: user.id,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          userId: user.id,
        },
      },
      success_url: `${WEB_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${WEB_DOMAIN}/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

module.exports = router;
