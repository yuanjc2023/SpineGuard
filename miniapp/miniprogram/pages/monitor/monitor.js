const telemetryService = require('../../services/telemetry');
const gardenService = require('../../services/garden');

// pages/monitor/monitor.js
Page({
  data: {
    riskLevel: 'low',
    riskLevelText: '低',
    riskColor: '#2ECC71',
    riskAngle: 120,
    riskMsg: '继续保持 🌟',
    postureName: '标准坐姿',
    postureIcon: '🧘',
    encourageText: '保持挺拔，小树在长大🌱',
    sensorReadings: [],
    vibrationEnabled: true,
    lastSyncTime: '刚刚',
    deviceStatusText: '坐垫已连接',
    deviceStatusClass: 'online',
    deviceSyncText: '刚刚同步',
    deviceBatteryText: '--',
    backrestDistanceText: '--',
    deviceConnected: true,
    telemetryMode: telemetryService.getTelemetryMode(),
    protocolVersion: null,
    pressureSourceText: '等待遥测',
    showRiskModal: false,
  },

  onLoad() {
    this.loadDeviceQuickState();
    this.refreshTelemetry().catch(() => {});
  },

  onReady() {
    const query = wx.createSelectorQuery();
    query.select('#pressureHeatmap').fields({ node: true, size: true }).exec((result) => {
      const canvasInfo = result && result[0];
      if (!canvasInfo || !canvasInfo.node) return;
      const canvas = canvasInfo.node;
      const ctx = canvas.getContext('2d');
      const windowInfo = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : { pixelRatio: 1 };
      const dpr = Math.min(windowInfo.pixelRatio || 1, 2);
      canvas.width = Math.round(canvasInfo.width * dpr);
      canvas.height = Math.round(canvasInfo.height * dpr);
      ctx.scale(dpr, dpr);
      this.heatmapCanvas = canvas;
      this.heatmapCtx = ctx;
      this.heatmapCanvasSize = { width: canvasInfo.width, height: canvasInfo.height };
      this.canvasReady = true;
      this.drawPressureHeatmap();
    });
  },

  onShow() {
    this.monitorVisible = true;
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    this.loadDeviceQuickState();
    this.startTelemetryRefresh();
    this.startRealtimeTelemetry();
  },

  onHide() {
    this.monitorVisible = false;
    this.stopTelemetryRefresh();
    this.stopRealtimeTelemetry();
  },

  onUnload() {
    this.monitorVisible = false;
    this.stopTelemetryRefresh();
    this.stopRealtimeTelemetry();
  },

  onHeatmapTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this.heatmapDrag = {
      x: touch.x !== undefined ? touch.x : touch.clientX,
      y: touch.y !== undefined ? touch.y : touch.clientY,
      yaw: this.heatmapYaw !== undefined ? this.heatmapYaw : -45,
      pitch: this.heatmapPitch !== undefined ? this.heatmapPitch : -35.264
    };
  },

  onHeatmapTouchMove(e) {
    const touch = e.touches && e.touches[0];
    if (!touch || !this.heatmapDrag) return;
    const x = touch.x !== undefined ? touch.x : touch.clientX;
    const y = touch.y !== undefined ? touch.y : touch.clientY;
    this.heatmapYaw = this.heatmapDrag.yaw + (x - this.heatmapDrag.x) * 0.75;
    this.heatmapPitch = Math.max(-52, Math.min(-28, this.heatmapDrag.pitch + (y - this.heatmapDrag.y) * 0.28));
    this.scheduleHeatmapDraw();
  },

  onHeatmapTouchEnd() {
    this.heatmapDrag = null;
  },

  scheduleHeatmapDraw() {
    if (this.heatmapFramePending) return;
    this.heatmapFramePending = true;
    const render = () => {
      this.heatmapFramePending = false;
      this.drawPressureHeatmap();
    };
    if (this.heatmapCanvas && typeof this.heatmapCanvas.requestAnimationFrame === 'function') {
      this.heatmapCanvas.requestAnimationFrame(render);
    } else {
      setTimeout(render, 16);
    }
  },

  resetHeatmapView() {
    this.heatmapYaw = -45;
    this.heatmapPitch = -35.264;
    this.heatmapDrag = null;
    this.drawPressureHeatmap();
    wx.showToast({ title: '视角已复位', icon: 'none', duration: 800 });
  },

  setSensorReadings(sensorReadings) {
    this.setData({ sensorReadings }, () => {
      this.scheduleHeatmapDraw();
    });
  },

  startTelemetryRefresh() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refreshTelemetry().catch(() => {});
    }, telemetryService.refreshIntervalMs);
  },

  stopTelemetryRefresh() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  startRealtimeTelemetry() {
    if (this.realtimeSocket || telemetryService.getTelemetryMode() === 'Mock') return;
    this.realtimeSocket = telemetryService.subscribeStudent({
      onOpen: () => {
        this.reconnectDelay = 2000;
        this.stopTelemetryRefresh();
        this.setData({ deviceSyncText: 'WebSocket 实时同步' });
      },
      onData: (telemetry) => this.applyTelemetry(telemetry),
      onError: (error) => console.warn('实时连接异常，将回退轮询', error),
      onClose: () => {
        this.realtimeSocket = null;
        if (!this.monitorVisible) return;
        this.startTelemetryRefresh();
        clearTimeout(this.reconnectTimer);
        const delay = this.reconnectDelay || 2000;
        this.reconnectTimer = setTimeout(() => this.startRealtimeTelemetry(), delay);
        this.reconnectDelay = Math.min(30000, delay * 2);
      }
    });
  },

  stopRealtimeTelemetry() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.realtimeSocket) this.realtimeSocket.close({ code: 1000, reason: 'page hidden' });
    this.realtimeSocket = null;
  },

  loadDeviceQuickState() {
    const saved = wx.getStorageSync('vibrationEnabled');
    const deviceState = wx.getStorageSync('deviceState') || {};
    const connected = deviceState.connected !== undefined ? deviceState.connected : true;
    const battery = deviceState.battery !== undefined && deviceState.battery !== null ? deviceState.battery : null;
    const lastSync = deviceState.lastSync || (connected ? '刚刚' : '已断开');
    this.setData({
      vibrationEnabled: saved !== undefined ? saved : this.data.vibrationEnabled,
      deviceConnected: connected,
      deviceBatteryText: battery == null || battery === '--' ? '--' : `${battery}%`,
      lastSyncTime: lastSync,
      deviceStatusText: connected ? '坐垫已连接' : '设备未连接',
      deviceSyncText: connected ? `${lastSync}同步` : '点击连接',
      deviceStatusClass: connected ? 'online' : 'offline'
    });
  },

  refreshTelemetry() {
    const boundDevice = wx.getStorageSync('boundDevice') || {};
    const deviceId = boundDevice.deviceCode || telemetryService.defaultDeviceId;
    return telemetryService.getLatestTelemetry(deviceId).then((telemetry) => this.applyTelemetry(telemetry)).catch((error) => {
      console.error('获取遥测失败', error);
      this.setData({
        postureName: '暂无坐姿数据',
        postureIcon: '◌',
        riskLevelText: '--',
        riskColor: '#A5AEA8',
        riskMsg: '等待后端收到设备遥测',
        encourageText: '请确认后端、设备绑定和数据上传状态',
        sensorReadings: [],
        protocolVersion: null,
        pressureSourceText: '等待有效遥测',
        backrestDistanceText: '--',
        deviceConnected: false,
        deviceStatusText: '设备未连接',
        deviceStatusClass: 'offline',
        deviceSyncText: '同步失败'
      });
      throw error;
    });
  },

  applyTelemetry(telemetry) {
    this.setData({
      postureName: telemetry.postureName,
      postureIcon: telemetry.postureIcon,
      riskLevel: telemetry.riskLevel,
      riskLevelText: telemetry.riskLevelText,
      riskColor: telemetry.riskColor,
      riskAngle: telemetry.riskAngle,
      riskMsg: telemetry.riskMsg,
      encourageText: telemetry.encourageText,
      vibrationEnabled: telemetry.vibrationEnabled,
      deviceBatteryText: telemetry.batteryLevel == null ? '--' : `${telemetry.batteryLevel}%`,
      backrestDistanceText: telemetry.backrestDistanceText,
      deviceConnected: true,
      deviceStatusText: '坐垫已连接',
      deviceStatusClass: 'online',
      lastSyncTime: '刚刚',
      deviceSyncText: `刚刚同步 · ${telemetryService.getTelemetryMode()}`,
      telemetryMode: telemetryService.getTelemetryMode(),
      protocolVersion: telemetry.protocolVersion,
      pressureSourceText: telemetry.protocolVersion === 2
        ? 'V2 · 归一化值 / 12-bit ADC'
        : 'V1 历史 · ADC不可用'
    });
    // 乐园页读取该值，将实时识别结果映射为小树的即时视觉状态。
      wx.setStorageSync('currentPosture', telemetry.postureName);
      wx.setStorageSync('currentPostureCode', telemetry.postureCode);
    this.setSensorReadings(telemetry.sensorReadings);
    gardenService.recordTelemetry(telemetry).catch((error) => console.warn('Mock 乐园遥测结算失败', error));
      if (telemetry.warningActive && telemetry.riskLevel !== 'low') {
        wx.showToast({ title: `检测到${telemetry.postureName}，请纠正`, icon: 'none', duration: 2000 });
      if (this.data.vibrationEnabled) {
        wx.vibrateShort({ type: 'light' });
      }
      }
    return telemetry;
  },

  drawPressureHeatmap() {
    if (!this.canvasReady || !this.monitorVisible) return;

    const ctx = this.heatmapCtx;
    const canvasSize = this.heatmapCanvasSize;
    if (!ctx || !canvasSize) return;
    const width = canvasSize.width;
    const height = canvasSize.height;
    const unit = width / 560;
    ctx.clearRect(0, 0, width, height);
    const sensors = this.data.sensorReadings.length ? this.data.sensorReadings : [
      { id: 'left', x: 0.2, y: 0.5, value: 0 },
      { id: 'right', x: 0.8, y: 0.5, value: 0 },
      { id: 'front', x: 0.5, y: 0.2, value: 0 },
      { id: 'back', x: 0.5, y: 0.8, value: 0 },
      { id: 'center', x: 0.5, y: 0.5, value: 0 }
    ];
    const columns = 32;
    const rows = 32;
    const pressureGridKey = sensors.map((sensor) => `${sensor.id}:${sensor.value}`).join('|');
    if (this.pressureGridKey !== pressureGridKey) {
      this.pressureGridKey = pressureGridKey;
      this.pressureGridColors = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
          const pressure = this.interpolatePressure((col + 0.5) / columns, (row + 0.5) / rows, sensors);
          this.pressureGridColors.push(this.getHeatColor(pressure));
        }
      }
    }
    const yawDegrees = this.heatmapYaw !== undefined ? this.heatmapYaw : -45;
    const pitchDegrees = this.heatmapPitch !== undefined ? this.heatmapPitch : -35.264;
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    const centerX = width / 2;
    const centerY = height * 0.51;
    const seatThickness = 0.34;
    // 与 Web 首页模型保持一致：宽座垫、内嵌热力面，以及向后微倾的曲面靠背。
    const seatHalfX = 1.15;
    const seatHalfZ = 0.89;
    const surfaceHalfX = 1.11;
    const surfaceHalfZ = 0.85;
    const backrestAnchorZ = 0.78;
    const backrestDepth = 0.27;
    const backrestTilt = -0.1;

    // 座垫与靠背使用同一正交投影，旋转时保持现有的稳定立体风格。
    const projectRaw = (x, y, z) => {
      const rotatedX = x * Math.cos(yaw) - z * Math.sin(yaw);
      const yawZ = x * Math.sin(yaw) + z * Math.cos(yaw);
      const rotatedY = y * Math.cos(pitch) - yawZ * Math.sin(pitch);
      const rotatedZ = y * Math.sin(pitch) + yawZ * Math.cos(pitch);
      return {
        x: rotatedX,
        y: rotatedY,
        depth: rotatedZ
      };
    };

    const sampleCubic = (start, control1, control2, end, steps = 6) => {
      const points = [];
      for (let index = 1; index <= steps; index++) {
        const t = index / steps;
        const inverse = 1 - t;
        points.push({
          x: inverse ** 3 * start.x
            + 3 * inverse ** 2 * t * control1.x
            + 3 * inverse * t ** 2 * control2.x
            + t ** 3 * end.x,
          y: inverse ** 3 * start.y
            + 3 * inverse ** 2 * t * control1.y
            + 3 * inverse * t ** 2 * control2.y
            + t ** 3 * end.y
        });
      }
      return points;
    };
    const backrestWebSegments = [
      [{ x: -2.02, y: -1.48 }, { x: -2.3, y: -1.08 }, { x: -2.34, y: 0.42 }, { x: -1.76, y: 1.3 }],
      [{ x: -1.76, y: 1.3 }, { x: -1.28, y: 1.64 }, { x: -0.62, y: 1.58 }, { x: 0, y: 1.4 }],
      [{ x: 0, y: 1.4 }, { x: 0.62, y: 1.58 }, { x: 1.28, y: 1.64 }, { x: 1.76, y: 1.3 }],
      [{ x: 1.76, y: 1.3 }, { x: 2.34, y: 0.42 }, { x: 2.3, y: -1.08 }, { x: 2.02, y: -1.48 }],
      [{ x: 2.02, y: -1.48 }, { x: 1.34, y: -1.34 }, { x: 0.72, y: -1.12 }, { x: 0, y: -1.12 }],
      [{ x: 0, y: -1.12 }, { x: -0.72, y: -1.12 }, { x: -1.34, y: -1.34 }, { x: -2.02, y: -1.48 }]
    ];
    const backrestOutline2D = [{ x: -2.02, y: -1.48 }];
    backrestWebSegments.forEach((segment) => {
      backrestOutline2D.push(...sampleCubic(segment[0], segment[1], segment[2], segment[3]));
    });
    const tiltBackrestPoint = (x, y, depthOffset = 0) => ({
      x,
      y: y * Math.cos(backrestTilt) - depthOffset * Math.sin(backrestTilt),
      z: backrestAnchorZ + y * Math.sin(backrestTilt) + depthOffset * Math.cos(backrestTilt)
    });
    const createBackrestOutline = (depthOffset = 0) => backrestOutline2D.map((point) => {
      const x = point.x * 0.52;
      const y = -(point.y + 1.48) * 0.66;
      return tiltBackrestPoint(x, y, depthOffset);
    });
    const backrestFrontWorld = createBackrestOutline(0);
    const backrestBackWorld = createBackrestOutline(backrestDepth);

    // 完整座椅边界只用于居中；缩放保持固定，避免拖动时模型呼吸缩放。
    const rawBounds = [];
    const addBounds = (minXValue, maxXValue, minYValue, maxYValue, minZValue, maxZValue) => {
      [minXValue, maxXValue].forEach((x) => {
        [minYValue, maxYValue].forEach((y) => {
          [minZValue, maxZValue].forEach((z) => rawBounds.push(projectRaw(x, y, z)));
        });
      });
    };
    addBounds(-seatHalfX, seatHalfX, 0, seatThickness, -seatHalfZ, seatHalfZ);
    backrestFrontWorld.concat(backrestBackWorld).forEach((point) => {
      rawBounds.push(projectRaw(point.x, point.y, point.z));
    });
    const minX = Math.min(...rawBounds.map((point) => point.x));
    const maxX = Math.max(...rawBounds.map((point) => point.x));
    const minY = Math.min(...rawBounds.map((point) => point.y));
    const maxY = Math.max(...rawBounds.map((point) => point.y));
    const safeWidth = Math.max(80, width - 48 * unit);
    const safeHeight = Math.max(80, height - 58 * unit);
    // 3.72 覆盖允许俯仰角内的最大投影高度，旋转到极限也不会越出画布。
    const scale = Math.min(safeWidth / 3.34, safeHeight / 3.72);
    const rawCenterX = (minX + maxX) / 2;
    const rawCenterY = (minY + maxY) / 2;
    const project3D = (x, y, z) => {
      const raw = projectRaw(x, y, z);
      return {
        x: centerX + (raw.x - rawCenterX) * scale,
        y: centerY + (raw.y - rawCenterY) * scale,
        depth: raw.depth
      };
    };
    const projectSurface = (u, v, y = 0) => project3D(
      (u - 0.5) * surfaceHalfX * 2,
      y,
      (v - 0.5) * surfaceHalfZ * 2
    );
    const topCorners = [projectSurface(0, 0), projectSurface(1, 0), projectSurface(1, 1), projectSurface(0, 1)];
    const polygon = (points, fill, stroke, lineWidth) => {
      ctx.beginPath();
      points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth || Math.max(1, 2 * unit); ctx.stroke(); }
    };
    const boxFaces = (bounds, colors, includeTop = true) => {
      const { minX: bx0, maxX: bx1, minY: by0, maxY: by1, minZ: bz0, maxZ: bz1 } = bounds;
      const vertices = [
        project3D(bx0, by0, bz0), project3D(bx1, by0, bz0), project3D(bx1, by0, bz1), project3D(bx0, by0, bz1),
        project3D(bx0, by1, bz0), project3D(bx1, by1, bz0), project3D(bx1, by1, bz1), project3D(bx0, by1, bz1)
      ];
      const definitions = [
        { key: 'top', ids: [0, 1, 2, 3] }, { key: 'bottom', ids: [4, 7, 6, 5] },
        { key: 'front', ids: [0, 4, 5, 1] }, { key: 'back', ids: [3, 2, 6, 7] },
        { key: 'left', ids: [0, 3, 7, 4] }, { key: 'right', ids: [1, 5, 6, 2] }
      ];
      return definitions.filter((face) => includeTop || face.key !== 'top').map((face) => {
        const points = face.ids.map((id) => vertices[id]);
        return {
          points,
          depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length,
          color: colors[face.key]
        };
      });
    };

    // 地面阴影增强座椅与界面的空间关系。
    ctx.save();
    ctx.shadowColor = 'rgba(35, 83, 68, 0.22)';
    ctx.shadowBlur = Math.max(2, 12 * unit);
    ctx.fillStyle = 'rgba(35, 83, 68, 0.18)';
    ctx.beginPath();
    ctx.ellipse(centerX, height * 0.79, width * 0.30, height * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const seatFaces = boxFaces(
      {
        minX: -seatHalfX,
        maxX: seatHalfX,
        minY: 0,
        maxY: seatThickness,
        minZ: -seatHalfZ,
        maxZ: seatHalfZ
      },
      {
        top: '#2E7680',
        bottom: '#244F61',
        front: '#4C8995',
        back: '#2C5968',
        left: '#376A78',
        right: '#61A9B0'
      }
    );
    const backrestFront = backrestFrontWorld.map((point) => project3D(point.x, point.y, point.z));
    const backrestBack = backrestBackWorld.map((point) => project3D(point.x, point.y, point.z));
    const backrestFaces = [{
      points: backrestBack.slice().reverse(),
      depth: backrestBack.reduce((sum, point) => sum + point.depth, 0) / backrestBack.length,
      color: '#234854'
    }, {
      points: backrestFront,
      depth: backrestFront.reduce((sum, point) => sum + point.depth, 0) / backrestFront.length,
      color: '#3C7582'
    }];
    backrestFront.forEach((point, index) => {
      const nextIndex = (index + 1) % backrestFront.length;
      const points = [point, backrestFront[nextIndex], backrestBack[nextIndex], backrestBack[index]];
      const edgePosition = index / backrestFront.length;
      backrestFaces.push({
        points,
        depth: points.reduce((sum, item) => sum + item.depth, 0) / points.length,
        color: edgePosition < 0.18
          ? '#5DA8B1'
          : edgePosition < 0.68 ? '#315F6D' : '#548F98'
      });
    });
    const bodyFaces = backrestFaces.concat(seatFaces).sort((a, b) => a.depth - b.depth);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 12 * unit;
    ctx.shadowBlur = 18 * unit;
    ctx.shadowColor = 'rgba(35, 83, 68, 0.2)';
    bodyFaces.forEach((face) => polygon(face.points, face.color, '#63BDCA', Math.max(1, 2 * unit)));
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    // 曲面内饰板沿用 Web 的收边比例，并跟随靠背倾角。
    const panelCenterY = -0.94;
    const backrestPanelWorld = backrestOutline2D.map((point) => {
      const outerX = point.x * 0.52;
      const outerY = -(point.y + 1.48) * 0.66;
      const baseX = outerX * 0.91;
      const baseY = panelCenterY + (outerY - panelCenterY) * 0.88;
      return tiltBackrestPoint(baseX, baseY, -0.018);
    });
    const backrestPanel = backrestPanelWorld.map((point) => project3D(point.x, point.y, point.z));
    const panelTop = Math.min(...backrestPanel.map((point) => point.y));
    const panelBottom = Math.max(...backrestPanel.map((point) => point.y));
    const panelGradient = ctx.createLinearGradient(0, panelTop, 0, panelBottom);
    panelGradient.addColorStop(0, '#173E49');
    panelGradient.addColorStop(0.52, '#245966');
    panelGradient.addColorStop(1, '#2F6C75');
    polygon(backrestPanel, panelGradient, '#75D3DE', Math.max(1.5, 4 * unit));

    // 靠背上方中央的小型测距传感器模组，和曲面保持同一倾角。
    const rangeSensorPlate = [
      tiltBackrestPoint(-0.17, -1.72, -0.035),
      tiltBackrestPoint(0.17, -1.72, -0.035),
      tiltBackrestPoint(0.17, -1.46, -0.035),
      tiltBackrestPoint(-0.17, -1.46, -0.035)
    ].map((point) => project3D(point.x, point.y, point.z));
    polygon(rangeSensorPlate, '#071D27', '#7CEAF0', Math.max(1.5, 3 * unit));
    const sensorWorldCenter = tiltBackrestPoint(0, -1.59, -0.045);
    const sensorCenter = project3D(sensorWorldCenter.x, sensorWorldCenter.y, sensorWorldCenter.z);
    ctx.beginPath();
    ctx.fillStyle = '#42E3EF';
    ctx.arc(sensorCenter.x, sensorCenter.y, Math.max(3.2, 6.5 * unit), 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(108, 241, 246, 0.38)';
    ctx.lineWidth = Math.max(1, 2 * unit);
    ctx.arc(sensorCenter.x, sensorCenter.y, Math.max(7, 13 * unit), 0, Math.PI * 2);
    ctx.stroke();

    // 坐垫顶面仍只由左、右、前、后、中心五点 FSR 插值生成。
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const u0 = col / columns;
        const u1 = (col + 1) / columns;
        const v0 = row / rows;
        const v1 = (row + 1) / rows;
        const points = [
          projectSurface(u0, v0),
          projectSurface(u1, v0),
          projectSurface(u1, v1),
          projectSurface(u0, v1)
        ];
        const cellCenterX = points.reduce((sum, point) => sum + point.x, 0) / 4;
        const cellCenterY = points.reduce((sum, point) => sum + point.y, 0) / 4;
        const expanded = points.map((point) => {
          const dx = point.x - cellCenterX;
          const dy = point.y - cellCenterY;
          const length = Math.sqrt(dx * dx + dy * dy) || 1;
          const overlap = Math.max(0.45, unit);
          return { x: point.x + dx / length * overlap, y: point.y + dy / length * overlap };
        });
        ctx.beginPath();
        ctx.moveTo(expanded[0].x, expanded[0].y);
        expanded.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.closePath();
        ctx.fillStyle = this.pressureGridColors[row * columns + col];
        ctx.fill();
      }
    }

    // 青色包边与曲面靠背共同构成一体化立体座椅。
    ctx.beginPath();
    ctx.moveTo(topCorners[0].x, topCorners[0].y);
    topCorners.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.strokeStyle = '#5BC4D7';
    ctx.lineWidth = Math.max(2.5, 7 * unit);
    ctx.stroke();

    sensors.forEach((sensor) => {
      const point = projectSurface(sensor.x, sensor.y);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.lineWidth = Math.max(2.5, 6 * unit);
      ctx.arc(point.x, point.y, Math.max(5, 10 * unit), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = 'rgba(45, 113, 104, 0.42)';
      ctx.arc(point.x, point.y, Math.max(2, 4 * unit), 0, Math.PI * 2);
      ctx.fill();
    });
  },

  interpolatePressure(x, y, sensors) {
    let weightedPressure = 0;
    let totalWeight = 0;
    // 与 Web 首页一致的五点 FSR 高斯扩散半径。
    const spread = 0.26;

    sensors.forEach((sensor) => {
      const deltaX = x - sensor.x;
      const deltaY = y - sensor.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      const weight = Math.exp(-distanceSquared / (2 * spread * spread));
      weightedPressure += sensor.value * weight;
      totalWeight += weight;
    });

    return weightedPressure / totalWeight;
  },

  getHeatColor(value) {
    const stops = [
      { value: 0, color: [32, 57, 88] },
      { value: 24, color: [39, 174, 213] },
      { value: 48, color: [64, 222, 170] },
      { value: 68, color: [240, 224, 91] },
      { value: 84, color: [255, 139, 71] },
      { value: 100, color: [255, 63, 105] }
    ];
    const target = Math.max(0, Math.min(100, value));
    let start = stops[0];
    let end = stops[stops.length - 1];

    for (let i = 0; i < stops.length - 1; i++) {
      if (target <= stops[i + 1].value) {
        start = stops[i];
        end = stops[i + 1];
        break;
      }
    }

    const ratio = (target - start.value) / (end.value - start.value || 1);
    const color = start.color.map((channel, index) => Math.round(channel + (end.color[index] - channel) * ratio));
    return `rgb(${color.join(',')})`;
  },

  toggleVibration(e) {
    this.setData({ vibrationEnabled: e.detail.value });
    wx.setStorageSync('vibrationEnabled', e.detail.value);
  },

  goToDeviceManage() {
    wx.navigateTo({ url: '/pages/device-manage/device-manage' });
  },

  manualRefresh() {
    wx.showLoading({ title: '同步中...' });
    this.refreshTelemetry().then(() => {
      wx.hideLoading();
      wx.showToast({ title: '同步成功', icon: 'success' });
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '同步失败', icon: 'none' });
    });
  },

  showRiskHelp() {
    this.setData({ showRiskModal: true });
  },
  closeRiskModal() {
    this.setData({ showRiskModal: false });
  },
  preventClose() {},
});
