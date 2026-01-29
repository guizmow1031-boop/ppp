const { onCall, onRequest } = require('firebase-functions/v2/https');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();

const config = functions.config();
const stripeSecretKey = config.stripe && config.stripe.secret ? config.stripe.secret : null;
const webhookSecret = config.stripe && config.stripe.webhook ? config.stripe.webhook : null;
const appDomain = (config.app && config.app.domain) ? config.app.domain : 'http://127.0.0.1:5500';

if (!stripeSecretKey) {
  console.warn('⚠️ STRIPE_SECRET_KEY is not set');
}

const stripe = stripeSecretKey ? Stripe(stripeSecretKey) : null;

exports.createCheckoutSession = onCall(async (request) => {
  const auth = request.auth;
  const data = request.data || {};

  if (!auth) {
    throw new Error('AUTH_REQUIRED');
  }

  if (!stripe) {
    throw new Error('STRIPE_NOT_CONFIGURED');
  }

  const priceId = data.priceId;
  if (!priceId) {
    throw new Error('PRICE_ID_REQUIRED');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: auth.uid,
    metadata: {
      uid: auth.uid,
      priceId
    },
    success_url: `${appDomain}/inador/index.html?checkout=success`,
    cancel_url: `${appDomain}/inador/index.html?checkout=cancel`
  });

  return { url: session.url };
});

exports.stripeWebhook = onRequest(async (req, res) => {
  if (!stripe || !webhookSecret) {
    res.status(500).send('Stripe not configured');
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.metadata && session.metadata.uid ? session.metadata.uid : session.client_reference_id;

      if (uid) {
        const db = admin.firestore();
        const eventRef = db.collection('stripeEvents').doc(event.id);
        const eventSnap = await eventRef.get();

        if (eventSnap.exists) {
          console.log(`ℹ️ Event déjà traité: ${event.id}`);
        } else {
          const userRef = db.collection('users').doc(uid);
          await db.runTransaction(async (tx) => {
            tx.set(eventRef, { createdAt: admin.firestore.FieldValue.serverTimestamp() });
            tx.set(userRef, { credits: admin.firestore.FieldValue.increment(100) }, { merge: true });
          });
          console.log(`✅ +100 crédits ajoutés à ${uid}`);
        }
      } else {
        console.warn('⚠️ UID manquant dans le webhook');
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler error');
  }
});
