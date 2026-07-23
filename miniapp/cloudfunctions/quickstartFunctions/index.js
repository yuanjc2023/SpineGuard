const cloud = require("wx-server-sdk");
const https = require("https");
const { URL } = require("url");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const getLlmConfig = () => {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || "").replace(/\/$/, "");
  const model = process.env.LLM_MODEL;

  if (!apiKey || !baseUrl || !model) {
    return null;
  }

  return { apiKey, baseUrl, model };
};

const postJson = (url, headers, data) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const request = https.request({
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    method: "POST",
    headers: Object.assign({
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data)
    }, headers),
    timeout: 25000
  }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`LLM request failed with status ${response.statusCode}`));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("LLM returned invalid JSON"));
      }
    });
  });

  request.on("timeout", () => {
    request.destroy(new Error("LLM request timed out"));
  });
  request.on("error", reject);
  request.write(data);
  request.end();
});

const parseModelJson = (content) => {
  const normalized = String(content || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(normalized);
};

const callLlm = async (messages) => {
  const config = getLlmConfig();
  if (!config) {
    return { success: false, errMsg: "LLM environment variables are not configured" };
  }

  try {
    const result = await postJson(`${config.baseUrl}/chat/completions`, {
      Authorization: `Bearer ${config.apiKey}`
    }, JSON.stringify({
      model: config.model,
      temperature: 0.4,
      messages
    }));
    const choices = result.choices || [];
    const message = choices[0] && choices[0].message;
    const content = message && message.content;
    return { success: true, data: parseModelJson(content) };
  } catch (error) {
    console.error("LLM request failed:", error.message);
    return { success: false, errMsg: "AI service is temporarily unavailable" };
  }
};

const sanitizeSportsAdvice = (data) => {
  if (!data || typeof data.riskTip !== "string" || !Array.isArray(data.sports)) {
    return null;
  }
  const sports = data.sports.slice(0, 3).map((sport) => ({
    name: String(sport.name || "").slice(0, 20),
    amount: String(sport.amount || "").slice(0, 20),
    desc: String(sport.desc || "").slice(0, 100)
  })).filter((sport) => sport.name && sport.amount && sport.desc);

  if (sports.length !== 3) {
    return null;
  }
  return { riskTip: data.riskTip.slice(0, 80), sports };
};

const generateAiSportsAdvice = async (event) => {
  const date = String(event.date || formatDate(new Date()));
  const postureContext = String(event.postureContext || "近期以标准坐姿为主").slice(0, 160);
  const result = await callLlm([
    {
      role: "system",
      content: "你是儿童坐姿健康助手。只给出低强度、适合日常活动的建议，不诊断疾病、不替代医生。必须只返回 JSON，不要 Markdown。JSON 格式：{\"riskTip\":\"不超过40字的今日重点\",\"sports\":[{\"name\":\"运动名称\",\"amount\":\"时长或次数\",\"desc\":\"不超过60字的安全动作说明\"},{...},{...}]}。sports 必须恰好 3 项。"
    },
    {
      role: "user",
      content: `日期：${date}\n近期姿势数据：${postureContext}\n请生成今天的运动建议。`
    }
  ]);

  const advice = result.success && sanitizeSportsAdvice(result.data);
  if (!advice) {
    return { success: false, errMsg: result.errMsg || "AI response format is invalid" };
  }
  return { success: true, advice };
};

const buildSummaryFromContext = (context) => {
  const daily = context && context.daily_stat ? context.daily_stat : {};
  const history = context && context.history_summary ? context.history_summary : {};
  const postureCounts = history.posture_counts || {};
  const historyTotal = Number(history.sample_count || 0);
  const historyNormal = Number(postureCounts.normal || 0);
  const historyPoor = Math.max(0, historyTotal - historyNormal - Number(postureCounts.empty || 0) - Number(postureCounts.unknown || 0));
  const normalSitting = Number(daily.normal_sitting_s !== undefined ? daily.normal_sitting_s : historyNormal * 10);
  const poorSitting = Number(daily.poor_sitting_s !== undefined ? daily.poor_sitting_s : historyPoor * 10);
  const totalSitting = Number(daily.total_sitting_s !== undefined ? daily.total_sitting_s : normalSitting + poorSitting);
  const reminderCount = Number(daily.reminder_count || 0);
  const asymmetry = Number(daily.avg_asymmetry_index !== undefined ? daily.avg_asymmetry_index : history.avg_asymmetry_index || 0);
  const riskLevel = asymmetry >= 0.35 || reminderCount >= 10 ? "red" : asymmetry >= 0.2 || reminderCount >= 5 ? "yellow" : "green";
  const suggestion = riskLevel === "red"
    ? "今天异常坐姿偏多，建议缩短连续学习时间，并检查桌椅高度。"
    : riskLevel === "yellow"
      ? "今天坐姿存在轻微波动，建议每 30 分钟起身活动并重新坐正。"
      : "今天坐姿整体稳定，继续保持双脚平放和背部自然挺直。";
  return {
    normal_sitting_s: normalSitting,
    poor_sitting_s: poorSitting,
    total_sitting_s: totalSitting,
    reminder_count: reminderCount,
    avg_asymmetry_index: asymmetry,
    risk: {
      risk_level: riskLevel,
      suggestion
    }
  };
};

const buildRuleReport = (date, context) => {
  const summary = buildSummaryFromContext(context);
  const total = Number(summary.total_sitting_s || summary.normal_sitting_s + summary.poor_sitting_s);
  const normalPercent = total > 0 ? Math.round(summary.normal_sitting_s / total * 100) : 0;
  const content = total > 0
    ? `今天标准坐姿占比约 ${normalPercent}%，非标准坐姿约 ${Math.round(summary.poor_sitting_s / 60)} 分钟，提醒 ${summary.reminder_count} 次。${summary.risk.suggestion}`
    : "今天暂未收到足够的坐姿记录，连接坐垫并使用一段时间后再查看分析。";
  return {
    report_type: "daily",
    period_start: date,
    period_end: date,
    summary,
    content,
    generated_by: "rule",
    created_at: new Date().toISOString()
  };
};

const sanitizeDailyReport = (data, fallback) => {
  if (!data || typeof data.content !== "string") return fallback;
  const report = Object.assign({}, fallback, {
    content: data.content.slice(0, 240),
    generated_by: "llm"
  });
  if (data.risk_suggestion && report.summary && report.summary.risk) {
    report.summary.risk.suggestion = String(data.risk_suggestion).slice(0, 100);
  }
  return report;
};

const generateDailyPostureReport = async (event) => {
  const date = String(event.date || formatDate(new Date()));
  const context = event.context || {};
  const fallback = buildRuleReport(date, context);
  const result = await callLlm([
    {
      role: "system",
      content: "你是儿童坐姿健康助手。根据坐姿统计生成温和、可执行的日常建议，不诊断疾病，不替代医生。必须只返回 JSON，不要 Markdown。JSON 格式：{\"content\":\"不超过120字的今日坐姿总结\",\"risk_suggestion\":\"不超过60字的建议\"}。"
    },
    {
      role: "user",
      content: `日期：${date}\n坐姿统计：${JSON.stringify(fallback.summary)}\n请生成今日坐姿分析。`
    }
  ]);
  const report = result.success ? sanitizeDailyReport(result.data, fallback) : fallback;
  return { success: true, report };
};

const answerFromSummary = (message, report) => {
  const summary = report && report.summary ? report.summary : {};
  const risk = summary.risk || {};
  const normal = Number(summary.normal_sitting_s || 0);
  const poor = Number(summary.poor_sitting_s || 0);
  const total = Number(summary.total_sitting_s || normal + poor);
  const normalPercent = total > 0 ? Math.round(normal / total * 100) : 0;
  const reminderCount = Number(summary.reminder_count || 0);
  const asymmetry = Number(summary.avg_asymmetry_index || 0);
  const question = String(message || "");
  if (!total) return "今天暂时没有足够的坐姿数据。请确认坐垫已绑定并持续上传一段时间后再来查看。";
  if (/压力|均衡|左右|重心|对称/.test(question)) {
    const level = asymmetry < 0.15 ? "整体较均衡" : asymmetry < 0.3 ? "存在轻微不均衡" : "不均衡较明显";
    return `今天的平均压力不对称指数为 ${asymmetry.toFixed(2)}，${level}。建议双脚平放、臀部坐在坐垫中央。`;
  }
  if (/提醒|纠正|异常/.test(question)) {
    return `今天记录到 ${reminderCount} 次坐姿提醒，非标准坐姿约 ${Math.round(poor / 60)} 分钟。${risk.suggestion || "建议提醒后及时回到自然坐姿。"}`;
  }
  if (/放松|运动|休息|建议|肩|颈|腰/.test(question)) {
    return `${risk.suggestion || "建议每学习 40 到 60 分钟起身活动。"} 可以做肩颈放松、扩胸运动和远眺。`;
  }
  return `今天标准坐姿占比约 ${normalPercent}%，非标准坐姿约 ${Math.round(poor / 60)} 分钟，共提醒 ${reminderCount} 次。${risk.suggestion || "继续保持双脚平放，并定时起身活动。"}`;
};

const sanitizeAssistantReply = (data, fallback) => {
  if (!data || typeof data.reply !== "string" || !data.reply.trim()) return fallback;
  return data.reply.slice(0, 240);
};

const assistantChat = async (event) => {
  const date = String(event.date || formatDate(new Date()));
  const message = String(event.message || "").slice(0, 300);
  const report = event.report || buildRuleReport(date, event.context || {});
  const fallback = answerFromSummary(message, report);
  const history = Array.isArray(event.history) ? event.history.slice(-8) : [];
  const result = await callLlm([
    {
      role: "system",
      content: "你是儿童坐姿健康助手。回答只能基于提供的坐姿统计和对话，不做疾病诊断，不替代医生。回答要简短、具体、温和。必须只返回 JSON，不要 Markdown。JSON 格式：{\"reply\":\"不超过120字的回答\"}。"
    },
    ...history.map((item) => ({
      role: item.role === "user" ? "user" : "assistant",
      content: String(item.content || "").slice(0, 300)
    })),
    {
      role: "user",
      content: `日期：${date}\n坐姿统计：${JSON.stringify(report.summary || {})}\n用户问题：${message}`
    }
  ]);
  const reply = result.success ? sanitizeAssistantReply(result.data, fallback) : fallback;
  return { success: true, data: { reply, generated_by: result.success ? "llm" : "rule" } };
};
// 获取openid
const getOpenId = async () => {
  // 获取基础信息
  const wxContext = cloud.getWXContext();
  return {
    openid: wxContext.OPENID,
    appid: wxContext.APPID,
    unionid: wxContext.UNIONID,
  };
};

// 获取小程序二维码
const getMiniProgramCode = async () => {
  // 获取小程序二维码的buffer
  const resp = await cloud.openapi.wxacode.get({
    path: "pages/login/login",
  });
  const { buffer } = resp;
  // 将图片上传云存储空间
  const upload = await cloud.uploadFile({
    cloudPath: "code.png",
    fileContent: buffer,
  });
  return upload.fileID;
};

// 创建集合
const createCollection = async () => {
  try {
    // 创建集合
    await db.createCollection("sales");
    await db.collection("sales").add({
      // data 字段表示需新增的 JSON 数据
      data: {
        region: "华东",
        city: "上海",
        sales: 11,
      },
    });
    await db.collection("sales").add({
      // data 字段表示需新增的 JSON 数据
      data: {
        region: "华东",
        city: "南京",
        sales: 11,
      },
    });
    await db.collection("sales").add({
      // data 字段表示需新增的 JSON 数据
      data: {
        region: "华南",
        city: "广州",
        sales: 22,
      },
    });
    await db.collection("sales").add({
      // data 字段表示需新增的 JSON 数据
      data: {
        region: "华南",
        city: "深圳",
        sales: 22,
      },
    });
    return {
      success: true,
    };
  } catch (e) {
    // 这里catch到的是该collection已经存在，从业务逻辑上来说是运行成功的，所以catch返回success给前端，避免工具在前端抛出异常
    return {
      success: true,
      data: "create collection success",
    };
  }
};

// 查询数据
const selectRecord = async () => {
  // 返回数据库查询结果
  return await db.collection("sales").get();
};

// 更新数据
const updateRecord = async (event) => {
  try {
    // 遍历修改数据库信息
    for (let i = 0; i < event.data.length; i++) {
      await db
        .collection("sales")
        .where({
          _id: event.data[i]._id,
        })
        .update({
          data: {
            sales: event.data[i].sales,
          },
        });
    }
    return {
      success: true,
      data: event.data,
    };
  } catch (e) {
    return {
      success: false,
      errMsg: e,
    };
  }
};

// 新增数据
const insertRecord = async (event) => {
  try {
    const insertRecord = event.data;
    // 插入数据
    await db.collection("sales").add({
      data: {
        region: insertRecord.region,
        city: insertRecord.city,
        sales: Number(insertRecord.sales),
      },
    });
    return {
      success: true,
      data: event.data,
    };
  } catch (e) {
    return {
      success: false,
      errMsg: e,
    };
  }
};

// 删除数据
const deleteRecord = async (event) => {
  try {
    await db
      .collection("sales")
      .where({
        _id: event.data._id,
      })
      .remove();
    return {
      success: true,
    };
  } catch (e) {
    return {
      success: false,
      errMsg: e,
    };
  }
};


// 验证设备代号和密钥
const verifyDevice = async (event) => {
  const { deviceCode, deviceKey } = event;
  if (!deviceCode || !deviceKey) {
    return { success: false, errMsg: '设备代号和密钥不能为空' };
  }

  const db = cloud.database();
  const devicesCollection = db.collection('devices');
  
  try {
    // 查询是否存在该设备代号
    const res = await devicesCollection.where({
      deviceCode: deviceCode
    }).get();

    if (res.data.length === 0) {
      return { success: false, errMsg: '设备代号不存在' };
    }

    const device = res.data[0];
    // 验证密钥
    if (device.deviceKey !== deviceKey) {
      return { success: false, errMsg: '密钥错误' };
    }

    // 获取当前用户的openid
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    // 检查设备是否已被其他用户绑定
    if (device.boundOpenid && device.boundOpenid !== openid) {
      return { success: false, errMsg: '该设备已被其他用户绑定，请使用正确的设备' };
    }

    // 如果未绑定，则绑定当前用户
    if (!device.boundOpenid) {
      await devicesCollection.doc(device._id).update({
        data: {
          boundOpenid: openid,
          lastActiveTime: db.serverDate()
        }
      });
    } else {
      // 更新最近活跃时间
      await devicesCollection.doc(device._id).update({
        data: {
          lastActiveTime: db.serverDate()
        }
      });
    }

    // 返回设备信息（不含密钥）
    return {
      success: true,
      deviceInfo: {
        deviceCode: device.deviceCode,
        nickName: device.nickName || '',
        boundOpenid: openid
      }
    };
  } catch (err) {
    console.error(err);
    return { success: false, errMsg: '数据库查询失败' };
  }
};

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const generateWeeklyReport = async () => {
  const wxContext = cloud.getWXContext();
  const pai = 0.21;
  const report = {
    date: formatDate(new Date()),
    type: "周报",
    riskLevel: "low",
    riskText: "低风险",
    pai,
    curve: [0.22, 0.2, pai, 0.18, 0.19],
    postureBreakdown: [
      { name: "标准坐姿", percent: 62 },
      { name: "左/右倾", percent: 18 },
      { name: "前倾", percent: 12 },
      { name: "其他", percent: 8 }
    ],
    advice: "本周坐姿整体稳定，建议继续保持每 30 分钟主动活动一次。",
    createTime: db.serverDate()
  };

  const aiResult = await callLlm([
    {
      role: "system",
      content: "你是儿童坐姿健康助手。根据提供的周度坐姿数据，给出一条不超过80字、语气温和、可执行的日常建议。不要诊断疾病，不要 Markdown。必须只返回 JSON：{\"advice\":\"建议内容\"}。"
    },
    {
      role: "user",
      content: `风险等级：${report.riskText}\n压力不对称指数 PAI：${report.pai}\n姿势占比：${report.postureBreakdown.map((item) => `${item.name}${item.percent}%`).join("，")}`
    }
  ]);
  if (aiResult.success && aiResult.data && typeof aiResult.data.advice === "string") {
    report.advice = aiResult.data.advice.slice(0, 100);
  }

  try {
    await db.collection("reports").add({
      data: {
        _openid: wxContext.OPENID,
        date: report.date,
        riskLevel: report.riskLevel,
        pai: report.pai,
        postureBreakdown: report.postureBreakdown,
        advice: report.advice,
        createTime: report.createTime
      },
    });
  } catch (err) {
    console.error(err);
  }

  return {
    success: true,
    report: Object.assign({}, report, {
      id: `${report.date}-${report.riskLevel}`,
      createTime: Date.now()
    })
  };
};

// const getOpenId = require('./getOpenId/index');
// const getMiniProgramCode = require('./getMiniProgramCode/index');
// const createCollection = require('./createCollection/index');
// const selectRecord = require('./selectRecord/index');
// const updateRecord = require('./updateRecord/index');
// const fetchGoodsList = require('./fetchGoodsList/index');
// const genMpQrcode = require('./genMpQrcode/index');
// 云函数入口函数
exports.main = async (event, context) => {
  switch (event.type) {
    case "getOpenId":
      return await getOpenId();
    case "getMiniProgramCode":
      return await getMiniProgramCode();
    case "createCollection":
      return await createCollection();
    case "selectRecord":
      return await selectRecord();
    case "updateRecord":
      return await updateRecord(event);
    case "insertRecord":
      return await insertRecord(event);
    case "deleteRecord":
      return await deleteRecord(event);
    case "verifyDevice":
  return await verifyDevice(event);
    case "generateWeeklyReport":
      return await generateWeeklyReport();
    case "generateAiSportsAdvice":
      return await generateAiSportsAdvice(event);
    case "generateDailyPostureReport":
      return await generateDailyPostureReport(event);
    case "assistantChat":
      return await assistantChat(event);
  }
};
