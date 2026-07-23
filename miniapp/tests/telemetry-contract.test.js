const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mapTelemetry } = require('../miniprogram/utils/mapTelemetry');
const { createMockTelemetry } = require('../miniprogram/mocks/telemetry');
function sharedFile(name) {
  const candidates = [
    path.resolve(__dirname, '../../shared', name),
    path.resolve(__dirname, '../../SpineGuard/shared', name)
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`找不到 shared/${name}`);
  return resolved;
}
const schemaPath = sharedFile('schema.json');
const examplePath = sharedFile('example.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));

assert.equal(schema.properties.protocol_version.const, 2);
assert.ok(schema.required.includes('raw_pressure'));

const mappedV2 = mapTelemetry(example);
assert.equal(mappedV2.protocolVersion, 2);
assert.deepEqual(mappedV2.rawPressure, example.raw_pressure);
assert.equal(mappedV2.sensorReadings[0].normalizedValue, example.pressure.left);
assert.equal(mappedV2.sensorReadings[0].rawValue, example.raw_pressure.left);
assert.equal(mappedV2.batteryLevel, null);
assert.equal(mappedV2.tiltX, null);
assert.equal(mappedV2.backrest.distanceMm, example.backrest.distance_mm);
assert.equal(mappedV2.backrestDistanceText, '8.8 cm');
assert.equal(mappedV2.recognitionSource, 'lightgbm');

const historicalV1 = Object.assign({}, example, { protocol_version: 1 });
delete historicalV1.raw_pressure;
const mappedV1 = mapTelemetry(historicalV1);
assert.equal(mappedV1.protocolVersion, 1);
assert.equal(mappedV1.rawPressure, null);
assert.equal(mappedV1.sensorReadings[0].rawValue, null);
assert.equal(mappedV1.sensorReadings[0].rawValueText, '--');

const invalidV2 = Object.assign({}, example);
delete invalidV2.raw_pressure;
assert.throws(() => mapTelemetry(invalidV2), /raw_pressure/);
assert.throws(() => mapTelemetry(Object.assign({}, example, { protocol_version: 3 })), /不支持的遥测协议/);

const mock = createMockTelemetry('SG-CONTRACT-001');
assert.equal(mock.protocol_version, 2);
assert.ok(mock.raw_pressure);
assert.deepEqual(mapTelemetry(mock).rawPressure, mock.raw_pressure);

console.log('Mini Program telemetry contract OK: shared V2, historical V1 and Mock V2 are compatible.');
