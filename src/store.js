/**
 * Minimal in-memory data store so this backend runs immediately with
 * `npm start` for local development and demoing the flow end-to-end.
 *
 * For production, replace every function body here with the equivalent
 * Prisma Client call against the schema in prisma/schema.prisma (Postgres).
 * The function signatures are written so that swap is close to 1:1.
 */
const { nanoid } = require('nanoid');

const db = {
  usersByEmail: new Map(),
  usersById: new Map(),
  usersByForwardingAddress: new Map(),
  tasksById: new Map(),
  contactsById: new Map(),
};

function makeForwardingAddress(email) {
  const local = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const suffix = nanoid(4).toLowerCase();
  return `${local}.${suffix}@fly.mailpilotus.ai`;
}

const Users = {
  create({ email, passwordHash }) {
    const id = nanoid();
    const user = {
      id,
      email,
      passwordHash,
      forwardingAddress: makeForwardingAddress(email),
      revenueCatAppUserId: id,
      subscriptionStatus: 'none',
      trialEndsAt: null,
      createdAt: new Date().toISOString(),
    };
    db.usersByEmail.set(email, user);
    db.usersById.set(id, user);
    db.usersByForwardingAddress.set(user.forwardingAddress, user);
    return user;
  },
  findByEmail(email) {
    return db.usersByEmail.get(email) || null;
  },
  findById(id) {
    return db.usersById.get(id) || null;
  },
  findByForwardingAddress(address) {
    return db.usersByForwardingAddress.get(address.toLowerCase()) || null;
  },
  updateSubscription(id, { status, trialEndsAt }) {
    const user = db.usersById.get(id);
    if (!user) return null;
    user.subscriptionStatus = status;
    user.trialEndsAt = trialEndsAt ?? user.trialEndsAt;
    return user;
  },
};

const Contacts = {
  upsert({ ownerId, deviceContactId, name, email, phone }) {
    const existing = [...db.contactsById.values()].find(
      (c) => c.ownerId === ownerId && c.deviceContactId === deviceContactId
    );
    if (existing) {
      Object.assign(existing, { name, email, phone });
      return existing;
    }
    const id = nanoid();
    const contact = { id, ownerId, deviceContactId, name, email, phone, createdAt: new Date().toISOString() };
    db.contactsById.set(id, contact);
    return contact;
  },
  findById(id) {
    return db.contactsById.get(id) || null;
  },
};

const Tasks = {
  create({ ownerId, fromAddress, fromName, subject, snippet }) {
    const id = nanoid();
    const task = {
      id,
      ownerId,
      fromAddress,
      fromName,
      subject,
      snippet,
      status: 'follow_up',
      assignedToId: null,
      assignedAt: null,
      receivedAt: new Date().toISOString(),
      completedAt: null,
    };
    db.tasksById.set(id, task);
    return task;
  },
  listByOwnerAndStatus(ownerId, status) {
    return [...db.tasksById.values()]
      .filter((t) => t.ownerId === ownerId && t.status === status)
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  },
  findById(id) {
    return db.tasksById.get(id) || null;
  },
  assign(id, contactId) {
    const task = db.tasksById.get(id);
    if (!task) return null;
    task.status = 'assigned';
    task.assignedToId = contactId;
    task.assignedAt = new Date().toISOString();
    return task;
  },
  unassign(id) {
    const task = db.tasksById.get(id);
    if (!task) return null;
    task.status = 'follow_up';
    task.assignedToId = null;
    task.assignedAt = null;
    return task;
  },
  complete(id) {
    const task = db.tasksById.get(id);
    if (!task) return null;
    task.status = 'done';
    task.completedAt = new Date().toISOString();
    return task;
  },
  serialize(task) {
    const contact = task.assignedToId ? Contacts.findById(task.assignedToId) : null;
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
