const { provisionNodes } = require('../scripts/provision-nodes');

jest.mock('@prisma/client', () => ({
  Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } }
}));

function makePrisma({ user = { id: 8 }, existingNodes = [] } = {}) {
  const transaction = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    node: {
      findMany: jest.fn()
        .mockResolvedValueOnce(existingNodes)
        .mockResolvedValueOnce([{ nodeId: 1 }, { nodeId: 2 }]),
      createMany: jest.fn().mockResolvedValue({ count: 2 })
    }
  };

  return {
    transaction,
    $transaction: jest.fn((callback, options) => {
      expect(options).toEqual({ isolationLevel: 'Serializable' });
      return callback(transaction);
    })
  };
}

describe('provisionNodes', () => {
  test('creates only Node 1 and Node 2 for the selected account in manual mode', async () => {
    const prisma = makePrisma();

    await expect(provisionNodes(prisma, 'Farmer@example.com')).resolves.toEqual([1, 2]);

    expect(prisma.transaction.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'farmer@example.com' },
      select: { id: true }
    });
    expect(prisma.transaction.node.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 8, nodeId: 1, name: 'Node 1', isActive: true, mode: 'manual' },
        { userId: 8, nodeId: 2, name: 'Node 2', isActive: true, mode: 'manual' }
      ]
    });
  });

  test('does not create nodes when the target account does not exist', async () => {
    const prisma = makePrisma({ user: null });

    await expect(provisionNodes(prisma, 'farmer@example.com'))
      .rejects.toThrow('Target account was not found');
    expect(prisma.transaction.node.createMany).not.toHaveBeenCalled();
  });

  test('does not alter or reassign nodes when either hardware ID is already registered', async () => {
    const prisma = makePrisma({ existingNodes: [{ nodeId: 1 }] });

    await expect(provisionNodes(prisma, 'farmer@example.com'))
      .rejects.toThrow('already registered');
    expect(prisma.transaction.node.createMany).not.toHaveBeenCalled();
  });
});
