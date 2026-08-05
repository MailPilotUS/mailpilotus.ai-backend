const express = require('express');
const multer = require('multer');
const { simpleParser } = require('mailparser');
const { Users, Tasks } = require('../store');
const router = express.Router();
const upload = multer();

/**
 * Inbound email webhook.
 *
 * How mail actually gets here: mailpilotus.ai's MX records point the
 * `fly.mailpilotus.ai` subdomain at an inbound email parsing provider
 * (SendGrid Inbound Parse or Mailgun Routes — see /docs/deployment-guide.docx,
 * "Setting up the forwarding address"). That provider receives the raw SMTP
 * message addressed to e.g. jane.k4f9@fly.mailpilotus.ai and POSTs it here
 * as multipart/form-data (SendGrid's format is assumed below; Mailgun's
 * field names differ slightly but the parsing approach is the same).
 *
 * We look up which MailPilotus user owns that address, then create a new
 * Follow-Up task from the ORIGINAL sender/subject of the forwarded message
 * (mail clients set the forwarded email's From/Subject inside the body as
 * "Fwd: ..." — we take the outer envelope's to-address to find the user,
 * and parse the raw MIME to recover the original from/subject/snippet).
 *
 * IMPORTANT: the outer message's From header is always the person doing the
 * forwarding (they're the one who sent this email to the MailPilotUS
 * address) — it is NOT the original sender. Gmail, Outlook, and Apple Mail
 * all insert a plain-text header block into the forwarded message body that
 * looks something like:
 *
 *   ---------- Forwarded message ---------
 *   From: DIANE SPECTOR <poofdlg@aol.com>
 *   Date: Sun, Aug 2, 2026 at 3:58 PM
 *   Subject: 2 dri fit shirts
 *   To: jane.k4f9@fly.mailpilotus.ai
 *
 * extractOriginalSender() scans the
