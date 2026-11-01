process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/jamur_monitor';
process.env.JWT_SECRET = 'unit-test-secret-value-at-least-32-characters';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { app } = require('../src');

describe('HTTP API', () => {
  test('health endpoint returns the standard success envelope', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, message: 'OK' });
    expect(response.body.data.status).toBe('healthy');
    expect(response.body.timestamp).toBeTruthy();
  });

  test('protected routes reject requests without a JWT', async () => {
    const response = await request(app).get('/api/nodes');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ success: false, message: 'Authentication required' });
  });

  test('CORS preflight allows Flutter Web JWT requests', async () => {
    const response = await request(app)
      .options('/api/nodes')
      .set('Origin', 'http://localhost:61610')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-headers']).toMatch(
      /authorization/i,
    );
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('MQTT debug endpoints require authentication', async () => {
    const status = await request(app).get('/api/debug/mqtt/status');
    const messages = await request(app).get('/api/debug/mqtt/messages');
    const publish = await request(app).post('/api/debug/mqtt/publish');

    for (const response of [status, messages, publish]) {
      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Authentication required');
    }
  });

  test('account creation requires an authenticated administrator', async () => {
    const response = await request(app).post('/api/auth/register').send({
      email: 'new-user@example.com',
      name: 'New User',
      password: 'password123'
    });
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Authentication required');
  });

  test('unknown routes return an API-shaped 404', async () => {
    const response = await request(app).get('/api/not-a-route');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, message: 'Endpoint not found' });
    expect(response.body.timestamp).toBeTruthy();
  });
});
