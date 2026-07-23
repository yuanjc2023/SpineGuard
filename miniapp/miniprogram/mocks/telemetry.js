const profiles = [
  {
    posture: 'normal', confidence: 0.96,
    pressure: { left: 520, right: 510, front: 430, back: 620, center: 760 },
    pressure_features: { total_pressure: 2840, left_right_diff: 10, front_back_diff: -190, center_x: 0.02, center_y: -0.16, asymmetry_index: 0.08 },
    imu: { tilt_x: 1.2, tilt_y: -0.5, shake_level: 0.03 }, warning_active: false
  },
  {
    posture: 'left_lean', confidence: 0.93,
    pressure: { left: 850, right: 260, front: 430, back: 610, center: 700 },
    pressure_features: { total_pressure: 2850, left_right_diff: 590, front_back_diff: -180, center_x: -0.48, center_y: -0.12, asymmetry_index: 0.42 },
    imu: { tilt_x: -12.4, tilt_y: -1.8, shake_level: 0.08 }, warning_active: true
  },
  {
    posture: 'front_lean', confidence: 0.94,
    pressure: { left: 520, right: 510, front: 850, back: 250, center: 650 },
    pressure_features: { total_pressure: 2780, left_right_diff: 10, front_back_diff: 600, center_x: 0.01, center_y: 0.52, asymmetry_index: 0.36 },
    imu: { tilt_x: 0.8, tilt_y: 18.6, shake_level: 0.05 }, warning_active: true
  },
  {
    posture: 'right_lean', confidence: 0.92,
    pressure: { left: 250, right: 860, front: 420, back: 600, center: 700 },
    pressure_features: { total_pressure: 2830, left_right_diff: -610, front_back_diff: -180, center_x: 0.51, center_y: -0.12, asymmetry_index: 0.43 },
    imu: { tilt_x: 13.1, tilt_y: -1.1, shake_level: 0.07 }, warning_active: true
  },
  {
    posture: 'back_lean', confidence: 0.91,
    pressure: { left: 510, right: 520, front: 260, back: 860, center: 690 },
    pressure_features: { total_pressure: 2840, left_right_diff: -10, front_back_diff: -600, center_x: 0.01, center_y: -0.53, asymmetry_index: 0.35 },
    imu: { tilt_x: -0.4, tilt_y: -16.2, shake_level: 0.04 }, warning_active: true
  },
  {
    posture: 'empty', confidence: 0.99,
    pressure: { left: 0, right: 0, front: 0, back: 0, center: 0 },
    pressure_features: { total_pressure: 0, left_right_diff: 0, front_back_diff: 0, center_x: 0, center_y: 0, asymmetry_index: 0 },
    imu: { tilt_x: 0, tilt_y: 0, shake_level: 0 }, warning_active: false
  },
  {
    posture: 'unknown', confidence: 0.38,
    pressure: { left: 330, right: 710, front: 640, back: 300, center: 470 },
    pressure_features: { total_pressure: 2450, left_right_diff: -380, front_back_diff: 340, center_x: 0.31, center_y: 0.29, asymmetry_index: 0.41 },
    imu: { tilt_x: 4.2, tilt_y: 5.8, shake_level: 0.48 }, warning_active: false
  }
];

let sequence = 0;

/** Returns a raw V2 DTO that fully matches SpineGuard/shared/schema.json. */
function createMockTelemetry(deviceId) {
  const profile = profiles[sequence % profiles.length];
  sequence += 1;
  return Object.assign({
    protocol_version: 2,
    device_id: deviceId || 'SG-0001',
    device_name: '脊小树 Mock 坐垫',
    session_id: 'S-MOCK-001',
    seq: sequence,
    timestamp_ms: Date.now(),
    occupied: profile.posture !== 'empty',
    ratio_valid: profile.posture !== 'empty'
  }, profile, {
    raw_pressure: {
      left: profile.pressure.left * 4,
      right: profile.pressure.right * 4,
      front: profile.pressure.front * 4,
      back: profile.pressure.back * 4,
      center: profile.pressure.center * 4
    },
    backrest: {
      online: true,
      data_ready: true,
      valid: profile.posture !== 'empty',
      distance_mm: profile.posture === 'empty' ? null : 92,
      range_status: 0
    },
    posture_duration_s: profile.posture === 'normal' ? 12 + sequence : 6 + sequence,
    sitting_duration_s: 600 + sequence,
    applied_config_version: 1,
    vibration_enabled: true,
    vibration_effective_enabled: true,
    reminder_due: false,
    reminder_suppressed: false,
    vibration_active: Boolean(profile.warning_active),
    vibration_position: {
      left_lean: 'left', right_lean: 'right', front_lean: 'front', back_lean: 'back'
    }[profile.posture] || null,
    reminder_count: profile.warning_active ? sequence : 0,
    reminder_cooldown_remaining_s: 0,
    reminder_config: {
      mode: 'normal',
      trigger_duration_s: 300,
      vibration_duration_s: 10,
      cooldown_s: 600,
      intensity_percent: 40
    },
    battery_level: 86,
    power_source: 'power_bank',
    wifi_rssi_dbm: -52,
    sensor_status: {
      fsr: { left: 'ok', right: 'ok', front: 'ok', back: 'ok', center: 'ok', all_ok: true, baseline_valid: true },
      tof: { online: true, valid: true },
      motor: { control_ready: true, self_test_completed: true, power_verified: false }
    },
    command_status: { id: null, type: 'none', status: 'idle', progress_percent: 0, error: null },
    device_credential_mode: 'per_device_secret',
    recognition_source: 'mock',
    model_version: 'mock-lightgbm-v2',
    firmware_version: '0.5.0-device-management'
  });
}

module.exports = { createMockTelemetry };
