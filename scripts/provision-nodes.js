const dotenv = require('dotenv');
const readline = require('readline');

dotenv.config();

function readLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return Promise.reject(new Error('Run this command in an interactive terminal so credentials can be entered safely.'));
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
    throw new Error('Refusing to provision nodes on localhost.');
  }
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

async function provisionNodes(prisma, email) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('A valid existing account email is required.');
  }

  const { Prisma } = require('@prisma/client');
  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true }
    });
    if (!user) throw new Error('Target account was not found; no nodes were created.');

    const existingNodes = await transaction.node.findMany({
      where: { nodeId: { in: [1, 2] } },
      select: { nodeId: true }
    });
    if (existingNodes.length) {
      throw new Error('Node 1 or Node 2 is already registered; no changes were made.');
    }

    await transaction.node.createMany({
      data: [1, 2].map((nodeId) => ({
        userId: user.id,
        nodeId,
        name: `Node ${nodeId}`,
        isActive: true,
        mode: 'manual'
      }))
    });

    const createdNodes = await transaction.node.findMany({
      where: { userId: user.id, nodeId: { in: [1, 2] } },
      select: { nodeId: true },
      orderBy: { nodeId: 'asc' }
    });
    if (createdNodes.length !== 2 || createdNodes.some((node, index) => node.nodeId !== index + 1)) {
      throw new Error('Provisioning verification failed; transaction rolled back.');
    }

    return createdNodes.map((node) => node.nodeId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function main() {
  const connectionString = await readHiddenLine('Production PostgreSQL DATABASE_URL (input is hidden): ');
  const dbTarget = describeDatabase(connectionString);
  process.env.DATABASE_URL = connectionString;

  const email = await readLine('Email of the existing account that should own Node 1 and Node 2: ');
  const confirmation = await readLine(`Type PROVISION NODES 1 AND 2 for ${dbTarget} to continue: `);
  if (confirmation !== `PROVISION NODES 1 AND 2 for ${dbTarget}`) {
    throw new Error('Target confirmation did not match; no changes were made.');
  }

  const { prisma } = require('../src/config/database');
  try {
    const nodeIds = await provisionNodes(prisma, email);
    console.log(`Provisioned hardware node IDs ${nodeIds.join(' and ')} for the selected account in ${dbTarget}. Mode is manual; no MQTT commands were sent.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Node provisioning failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { describeDatabase, provisionNodes };
