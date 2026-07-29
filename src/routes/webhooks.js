const express = require('express');
const { Users } = require('../store');

const router = express.Router();

const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';

/**
 * RevenueCat webhook — the single place we learn about trial starts,
 * renewals, cancellations, billing issues, etc. for BOTH the App Store and
 * Google Play (and Stripe/Web Billing), since the client app purchases
 * through RevenueCat. Configure this URL in the RevenueCat dashboard under
 * Project Settings > Integrations > Webhooks, and set the same secret in
 * REVENUECAT_WEBHOOK_SECRET so we can verify the Authorization header.
 *
 * Event types we care about (RevenueCat "event.type"):
 *   INITIAL_PURCHASE, RENEWAL      -> subscriptionStatus = 'active'
 *   TRIAL_STARTED                  -> subscriptionStatus = 'trialing'
 *   CANCELLATION                   -> leave status as-is until it actually
 *                                     lapses (user can keep access through
 *                                     the paid period even after cancelling)
 *   EXPIRATION                     -> subscriptionStatus = 'expired'
 *   BILLING_ISSUE                  -> leave status, but flag for a
 *                                     "update payment method" prompt (TODO)
 */
router.post('/revenuecat', express.json(), (req, res) => {
  const auth = req.headers.authorization || '';
  if (REVENUECAT_WEBHOOK_SECRET && auth !== `Bearer ${REVENUECAT_WEBHOOK_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  const event = req.body?.event;
  if (!event) return res.status(400).send('Missing event');

  const appUserId = event.app_user_id;
  const user = Users.findById(appUserId);
  if (!user) return res.status(200).send('Unknown user, ignoring'); // ack anyway

  switch (event.type) {
    case 'TRIAL_STARTED':
      Users.updateSubscription(user.id, {
        status: 'trialing',
        trialEndsAt: event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null,
      });
      break;
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
      Users.updateSubscription(user.id, { status: 'active' });
      break;
    case 'EXPIRATION':
      Users.updateSubscription(user.id, { status: 'expired' });
      break;
    // CANCELLATION and BILLING_ISSUE intentionally don't downgrade access
    // immediately — the user keeps access until the paid period actually
    // expires, matching "subscription may be cancelled at any time."
    default:
      break;
  }

  res.status(200).send('OK');
});

module.exports = router;
