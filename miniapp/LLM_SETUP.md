# 大模型 API 配置

本项目通过微信云函数调用大模型。API Key 只保存在云函数环境变量中，不能写入小程序前端文件。

## 已接入的功能

1. `AI 运动建议`：进入页面或切换日期时生成 3 个低强度运动建议。
2. `报告中心`：点击“生成新报告”时生成周度健康建议。
3. `坐姿 AI 助手`：通过云函数生成今日坐姿分析，并根据统计上下文回答追问。

实时压力图、坐姿风险判断和设备连接不调用大模型。它们需要即时响应，应继续基于传感器数据和规则运行。

## 配置环境变量

打开微信开发者工具的“云开发”，进入当前环境 `cloud1-d9g2c4cucc9ffa585`，在云函数 `quickstartFunctions` 的环境变量设置中添加：

| 名称 | 填写内容 |
| --- | --- |
| `LLM_API_KEY` | 你的大模型 API Key |
| `LLM_BASE_URL` | OpenAI 兼容接口根地址，不含 `/chat/completions` |
| `LLM_MODEL` | 需要调用的模型名称 |

示例：

| 服务商 | `LLM_BASE_URL` 示例 | `LLM_MODEL` 示例 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 其他兼容服务 | 服务商提供的 `/v1` 地址 | 服务商提供的模型 ID |

不要把 `LLM_API_KEY` 写入 `miniprogram/`、`app.js`、`project.config.json`，也不要提交到 Git。

## 部署与验证

1. 在开发者工具中右键 `cloudfunctions/quickstartFunctions`，选择“上传并部署：云端安装依赖”。
2. 在云开发控制台确认三个环境变量已保存。
3. 重新编译小程序。
4. 打开“坐姿 AI 助手”页，等待“今日坐姿分析”生成完成；也可打开“AI运动建议”页，或在“报告中心”点击“生成新报告”。

没有配置环境变量、模型接口报错或模型返回格式不符合要求时，页面会继续显示本地预设建议，保证页面可用。

## 接口约定

云函数会向以下地址发起 POST 请求：

```text
{LLM_BASE_URL}/chat/completions
```

请求格式为 OpenAI Chat Completions 兼容格式，并使用请求头：

```text
Authorization: Bearer {LLM_API_KEY}
```

若你的服务商不兼容该格式，需要修改 `cloudfunctions/quickstartFunctions/index.js` 中的 `callLlm()`。
