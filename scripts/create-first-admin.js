const dotenv = require('dotenv');
const bcrypt = require('bcrypt');

dotenv.config();

const MIN_PASSWORD_LENGTH = 12;

function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(new Error('Run this command in an interactive terminal so secrets can be entered safely.'));
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function finish(error) {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw || false);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    }

    function onData(data) {
      for (const character of data.toString('utf8')) {
        const code = character.charCodeAt(0);
        if (code === 3) {
          finish(new Error('Cancelled.'));
          return;
        }
        if (code === 13 || code === 10) {
          finish();
          return;
        }
        if (code === 8 || code === 127) {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (code >= 32) value += character;
      }
    }

    process.stdin.on('data', onData);
  });
}

function describeDatabase(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Refusing to create a production admin on localhost.');
  }
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

async function main() {
  const [email, name, ...extra] = process.argv.slice(2);
  if (!email || !name || extra.length || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: npm run db:create-first-admin -- <admin-email> <admin-name>');
  }

  const normalizedEmail = email.toLowerCase();
  const connectionString = await readHiddenLine('Production PostgreSQL DATABASE_URL (input is hidden): ');
  const dbTarget = describeDatabase(connectionString);
  process.env.DATABASE_URL = connectionString;

  const confirmation = await readHiddenLine(`Type CREATE FIRST ADMIN for ${dbTarget} to continue: `);
  if (confirmation !== `CREATE FIRST ADMIN for ${dbTarget}`) {
    throw new Error('Target confirmation did not match; no changes were made.');
  }

  const password = await readHiddenLine(`New admin password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (password.length < MIN_PASSWORD_LENGTH || /^\d+$/.test(password) || /^(.)\1+$/.test(password)) {
    throw new Error(`Use a non-repetitive password of at least ${MIN_PASSWORD_LENGTH} characters; no changes were made.`);
  }
  const passwordConfirmation = await readHiddenLine('Confirm new admin password: ');
  if (password !== passwordConfirmation) throw new Error('Passwords do not match; no changes were made.');

  const { Prisma } = require('@prisma/client');
  const { prisma } = require('../src/config/database');
  try {
    await prisma.$transaction(async (transaction) => {
      const admins = await transaction.user.count({ where: { role: 'admin' } });
      if (admins > 0) throw new Error('An administrator already exists; no changes were made.');

      await transaction.user.create({
        data: {
          email: normalizedEmail,
          name,
          password: await bcrypt.hash(password, 12),
          role: 'admin',
          settings: { create: {} }
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } finally {
    await prisma.$disconnect();
  }

  console.log(`Created the first admin account ${normalizedEmail} in ${dbTarget}. No existing data was deleted.`);
}

main().catch((error) => {
  console.error(`First-admin setup failed: ${error.message}`);
  process.exitCode = 1;
});
