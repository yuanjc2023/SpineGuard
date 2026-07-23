const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const models = require("../models.js");
function sharedFile(name) {
  const candidates = [
    path.resolve(__dirname, "../../shared", name),
    path.resolve(__dirname, "../../SpineGuard/shared", name),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`找不到 shared/${name}`);
  return resolved;
}
const sharedExamplePath = sharedFile("example.json");
const sharedSchemaPath = sharedFile("schema.json");
const sharedExample = JSON.parse(fs.readFileSync(sharedExamplePath, "utf8"));
const sharedSchema = JSON.parse(fs.readFileSync(sharedSchemaPath, "utf8"));

assert.equal(sharedSchema.properties.protocol_version.const, 2);
assert.ok(sharedSchema.required.includes("raw_pressure"));
assert.equal(sharedExample.protocol_version, sharedSchema.properties.protocol_version.const);

const mappedV2 = models.mapTelemetry(sharedExample);
assert.equal(mappedV2.protocolVersion, 2);
assert.deepEqual(mappedV2.rawPressure, sharedExample.raw_pressure);
assert.equal(mappedV2.pressure.left, sharedExample.pressure.left);
assert.equal(mappedV2.batteryLevel, null);
assert.equal(mappedV2.backrest.distanceMm, sharedExample.backrest.distance_mm);
assert.equal(mappedV2.recognitionSource, "lightgbm");
assert.equal(mappedV2.vibrationActive, true);

const historicalV1 = {...sharedExample, protocol_version: 1};
delete historicalV1.raw_pressure;
const mappedV1 = models.mapTelemetry(historicalV1);
assert.equal(mappedV1.protocolVersion, 1);
assert.equal(mappedV1.rawPressure, null);
assert.equal(mappedV1.batteryLevel, null);

const invalidV2 = {...sharedExample};
delete invalidV2.raw_pressure;
assert.throws(() => models.mapTelemetry(invalidV2), /raw_pressure/);
assert.throws(() => models.mapTelemetry({...sharedExample, protocol_version: 3}), /不支持的遥测协议/);

const storage = new Map();
global.window = global;
global.location = {search: "?mode=api", reload() {}};
global.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
global.sessionStorage = {
  getItem: (key) => storage.get(`session:${key}`) ?? null,
  setItem: (key, value) => storage.set(`session:${key}`, String(value)),
  removeItem: (key) => storage.delete(`session:${key}`),
};
global.SPINEGUARD_CONFIG = {mode: "api"};
require("../mock-api.js");

const mockV2 = global.SpineGuardMockApi.simulateTelemetry({seq: 99001});
assert.equal(mockV2.protocol_version, 2);
assert.ok(mockV2.raw_pressure);
assert.deepEqual(models.mapTelemetry(mockV2).rawPressure, mockV2.raw_pressure);
assert.equal(models.mapTelemetry(mockV2).backrest.distanceMm, 92);

(async () => {
  global.sessionStorage.setItem("sg.access_token", "mock:parent_demo");
  const completed = await global.SpineGuardMockApi.pairDevice({
    device_id: "SG-0001",
    student_id: "STU-MOCK-001",
    claim_code: "123456",
  });
  assert.equal(completed.data.status, "completed");
  assert.equal(completed.data.binding.device_id, "SG-0001");

  const pending = await global.SpineGuardMockApi.pairDevice({
    device_id: "SG-NOT-YET-ONLINE",
    student_id: "STU-MOCK-001",
    claim_code: "654321",
  });
  assert.equal(pending.data.status, "pending");
  assert.equal((await global.SpineGuardMockApi.pairingStatus(pending.data.pairing_id)).data.status, "pending");
  assert.equal((await global.SpineGuardMockApi.cancelPairing(pending.data.pairing_id)).data.status, "cancelled");

  console.log("Telemetry and device pairing contracts OK for shared V2, historical V1 and Web Mock.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
