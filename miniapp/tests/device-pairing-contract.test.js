const assert = require('node:assert/strict');

const requests = [];
global.wx = {
  getStorageSync(key) {
    if (key === 'accessToken') return 'test-jwt';
    if (key === 'dataMode') return 'api';
    return '';
  },
  getDeviceInfo() {
    return { platform: 'devtools' };
  },
  request(options) {
    requests.push(options);
    if (options.url === 'http://192.168.4.1/api/status') {
      options.success({
        statusCode: 200,
        data: {
          device_id: 'SG-PAIR-001',
          device_name: 'SpineGuard Pair Test',
          claim_code: '654321',
          connected: false,
          provisioning: true
        }
      });
      return;
    }
    const path = new URL(options.url).pathname;
    if (path.endsWith('/devices/pair')) {
      options.success({
        statusCode: 200,
        data: {
          ok: true,
          data: {
            pairing_id: 'PAIR-TEST-001',
            device_id: 'SG-PAIR-001',
            student_id: 'STU-PAIR-001',
            status: 'pending',
            expires_at: '2026-07-23T22:00:00+08:00',
            completed_at: null,
            binding: null,
            message: 'Waiting for the device to connect and register'
          }
        }
      });
      return;
    }
    options.success({
      statusCode: 200,
      data: {
        ok: true,
        data: {
          pairing_id: 'PAIR-TEST-001',
          status: options.method === 'DELETE' ? 'cancelled' : 'pending'
        }
      }
    });
  }
};

const telemetry = require('../miniprogram/services/telemetry');

(async () => {
  const pairing = await telemetry.pairDevice('SG-PAIR-001', 'STU-PAIR-001', '654321');
  assert.equal(pairing.status, 'pending');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].data.device_id, 'SG-PAIR-001');
  assert.equal(requests[0].data.student_id, 'STU-PAIR-001');
  assert.equal(requests[0].data.claim_code, '654321');
  assert.equal(requests[0].header.Authorization, 'Bearer test-jwt');

  await telemetry.getPairingStatus('PAIR-TEST-001');
  assert.match(requests[1].url, /\/devices\/pairings\/PAIR-TEST-001$/);
  assert.equal(requests[1].method, 'GET');

  const cancelled = await telemetry.cancelPairing('PAIR-TEST-001');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(requests[2].method, 'DELETE');

  const localStatus = await telemetry.getLocalDeviceStatus();
  assert.equal(localStatus.device_id, 'SG-PAIR-001');
  assert.equal(localStatus.claim_code, '654321');
  assert.equal(requests[3].url, 'http://192.168.4.1/api/status');
  assert.equal(requests[3].method, 'GET');

  console.log('Mini Program backend pairing and hardware SoftAP contracts OK.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
