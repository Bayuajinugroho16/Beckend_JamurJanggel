const { Prisma } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { prisma } = require('../src/config/database');
const env = require('../src/config/env');

const MIN_PASSWORD_LENGTH = 12;

function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(new Error('Run this command in an interactive terminal so the password can be entered safely.'));
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

function targetDatabase() {
  const url = new URL(env.DATABASE_URL);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

async function main() {
  const [email, name, ...extra] = process.argv.slice(2);
  if (!email || !name || extra.length || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: npm run db:reset-accounts -- <admin-email> <admin-name>');
  }

  const normalizedEmail = email.toLowerCase();
  const dbTarget = targetDatabase();
  console.log(`Target database: ${dbTarget}`);
  console.log('This permanently deletes all accounts and related database records, including all nodes.');
  console.log('Sensor history stored in InfluxDB is not deleted.');

  const backupConfirmation = await readHiddenLine('Type BACKUP-CREATED after verifying a restorable backup: ');
  if (backupConfirmation !== 'BACKUP-CREATED') throw new Error('Backup confirmation did not match; no changes were made.');

  const actionConfirmation = await readHiddenLine(`Type DELETE ALL ACCOUNTS FOR ${dbTarget} to continue: `);
  if (actionConfirmation !== `DELETE ALL ACCOUNTS FOR ${dbTarget}`) {
    throw new Error('Deletion confirmation did not match; no changes were made.');
  }

  const password = await readHiddenLine(`New admin password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (password.length < MIN_PASSWORD_LENGTH || /^\d+$/.test(password) || /^(.)\1+$/.test(password)) {
    throw new Error(`Use a non-repetitive password of at least ${MIN_PASSWORD_LENGTH} characters; no changes were made.`);
  }
  const passwordConfirmation = await readHiddenLine('Confirm new admin password: ');
  if (password !== passwordConfirmation) throw new Error('Passwords do not match; no changes were made.');

  const passwordHash = await bcrypt.hash(password, 12);
  const counts = await Promise.all([
    prisma.user.count(),
    prisma.node.count(),
    prisma.schedule.count(),
    prisma.log.count(),
    prisma.notification.count(),
    prisma.setting.count(),
    prisma.passwordResetToken.count()
  ]);
  const [users, nodes, schedules, logs, notifications, settings, resetTokens] = counts;

  console.log(`About to delete ${users} users, ${nodes} nodes, ${schedules} schedules, ${logs} logs, ${notifications} notifications, ${settings} settings, and ${resetTokens} reset tokens.`);
  const finalConfirmation = await readHiddenLine(`Type CREATE ONLY ${normalizedEmail} to apply this reset: `);
  if (finalConfirmation !== `CREATE ONLY ${normalizedEmail}`) {
    throw new Error('Final confirmation did not match; no changes were made.');
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.user.deleteMany();
    await transaction.user.create({
      data: {
        email: normalizedEmail,
        name,
        password: passwordHash,
        role: 'admin',
        settings: { create: {} }
      }
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  console.log(`Reset complete. Created the admin account ${normalizedEmail}; no nodes are assigned to it.`);
}

main()
  .catch((error) => {
    console.error(`Account reset failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
