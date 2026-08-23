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
  async saveGoogleTokens(id, { googleAccessToken, googleRefreshToken, googleTokenExpiry }) {
    return prisma.user.update({
      where: { id },
      data: {
        googleAccessToken,
        ...(googleRefreshToken ? { googleRefreshToken } : {}),
        googleTokenExpiry,
      },
    });
  },
  async setResetToken(id, { resetToken, resetTokenExpiry }) {
    return prisma.user.update({
      where: { id },
      data: { resetToken, resetTokenExpiry },
    });
  },
  async findByResetToken(token) {
    return prisma.user.findFirst({
      where: { resetToken: token, resetTokenExpiry: { gt: new Date() } },
    });
  },
  async resetPassword(id, passwordHash) {
    return prisma.user.update({
      where: { id },
      data: { passwordHash, resetToken: null, resetTokenExpiry: null },
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
  async create({ ownerId, name, email, phone }) {
    return prisma.contact.create({
      data: { ownerId, name, email, phone },
    });
  },
  async findAllByOwner(ownerId) {
    return prisma.contact.findMany({
      where: { ownerId },
      orderBy: { name: 'asc' },
    });
  },
  async findById(id) {
    return prisma.contact.findUnique({ where: { id } });
  },
};
const Tasks = {
  async create({ ownerId, fromAddress, fromName, forwarderAddress, subject, snippet, body }) {
    return prisma.task.create({
      data: {
        ownerId,
        fromAddress,
        fromName,
        forwarderAddress,
        subject,
        snippet,
        body,
        status: 'follow_up',
      },
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
      forwarderAddress: task.forwarderAddress,
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
const PushTokens = {
  // Upserts on the token itself (not ownerId) so re-installs, account
  // switches on the same device, etc. don't create duplicate rows.
  async upsert({ ownerId, token, platform }) {
    return prisma.pushToken.upsert({
      where: { token },
      update: { ownerId, platform },
      create: { ownerId, token, platform },
    });
  },
  async findAllByOwner(ownerId) {
    return prisma.pushToken.findMany({ where: { ownerId } });
  },
  async remove(token) {
    return prisma.pushToken.deleteMany({ where: { token } });
  },
};
module.exports = { Users, Contacts, Tasks, PushTokens };
