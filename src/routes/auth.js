/**
 * Postgres-backed data store via Prisma Client.
 * Replaces the in-memory store so data survives Render restarts.
 */
const { PrismaClient } = require('@prisma/client');
const { nanoid } = require('nanoid');

const prisma = new PrismaClient();

function makeForwardingAddress(email) {
  const local = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const suffix = nanoid(4).toLowerCase();
  return `${local}.${suffix}@fly.mailpilotus.ai`;
}

const Users = {
  async create({ email, passwordHash }) {
    const id = nanoid();
    const forwardingAddress = makeForwardingAddress(email);
    return prisma.user.create({
      data: {
        id,
        email,
        passwordHash,
        forwardingAddress,
        revenueCatAppUserId: id,
        subscriptionStatus: 'none',
      },
    });
  },
  async findByEmail(email) {
    return prisma.user.findUnique({ where: { email } });
  },
  async findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },
  async findByForwardingAddress(address) {
    return prisma.user.findUnique({ where: { forwardingAddress: address.toLowerCase() } });
  },
  async updateSubscription(id, { status, trialEndsAt }) {
    return prisma.user.update({
      where: { id },
      data: {
        subscriptionStatus: status,
        ...(trialEndsAt !== undefined
          ? { trialEndsAt: trialEndsAt ? new Date(trialEndsAt) : null }
          : {}),
      },
    });
  },
};

const Contacts = {
  async upsert({ ownerId, deviceContactId, name, email, phone }) {
    return prisma.contact.upsert({
      where: { ownerId_deviceContactId: { ownerId, deviceContactId } },
      update: { name, email, phone },
      create: { ownerId, deviceContactId, name, email, phone },
    });
  },
  async findById(id) {
    return prisma.contact.findUnique({ where: { id } });
  },
};

const Tasks = {
  async create({ ownerId, fromAddress, fromName, subject, snippet }) {
    return prisma.task.create({
      data: { ownerId, fromAddress, fromName, subject, snippet, status: 'follow_up' },
    });
  },
  async listByOwnerAndStatus(ownerId, status) {
    return prisma.task.findMany({
      where: { ownerId, status },
      orderBy: { receivedAt: 'desc' },
    });
  },
  async findById(id) {
    return prisma.task.findUnique({ where: { id } });
  },
  async assign(id, contactId) {
    return prisma.task.update({
      where: { id },
      data: { status: 'assigned', assignedToId: contactId, assignedAt: new Date() },
    });
  },
  async unassign(id) {
    return prisma.task.update({
      where: { id },
      data: { status: 'follow_up', assignedToId: null, assignedAt: null },
    });
  },
  async complete(id) {
    return prisma.task.update({
      where: { id },
      data: { status: 'done', completedAt: new Date() },
    });
  },
  async serialize(task) {
    const contact = task.assignedToId ? await Contacts.findById(task.assignedToId) : null;
    return {
      id: task.id,
      fromAddress: task.fromAddress,
      fromName: task.fromName,
      subject: task.subject,
      snippet: task.snippet,
      receivedAt: task.receivedAt,
      status: task.status,
      assignedTo: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      assignedAt: task.assignedAt,
      assignedByMe: true,
    };
  },
};

module.exports = { Users, Contacts, Tasks };

Steps to apply this file:

Go to https://github.com/MailPilotUS/mailpilotus.ai-backend
Click into src folder, then click on store.js
Click the pencil (edit) icon in the top right of the file view
Select all existing text in the editor (click inside it, Ctrl+A) and delete it
Paste the code block above in its place
Scroll down, and where it says "Commit changes," just click the green "Commit changes" button (default options are fine)

Let me know once that's done — then we'll move to file 2 of 7 (auth.js, a small tweak).

done

Pivoted toward refactoring authentication module syntax
Pivoted toward refactoring authentication module syntax

Great. File 2 of 7: auth.js — same file, small change (added await before the store calls since they're now real database calls).

javascript
const express = require('express');
const bcrypt = require('bcryptjs');
const { Users } = require('../store');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (await Users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await Users.create({ email, passwordHash });
  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await Users.findByEmail(email);
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



