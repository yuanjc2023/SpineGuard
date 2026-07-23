# 学校管理端接口适配与未完成报告

更新日期：2026-07-14

本次只修改 `/Users/nting233/Documents/物联网/web`，没有修改 SpineGuard 后端或微信云函数。

## 已适配

| 功能 | 数据来源 |
|---|---|
| 班级、学生和设备基本数据 | `GET /admin/overview`、`GET /admin/classes`、`GET /admin/classes/{class_id}/students`、`GET /students`、`GET /devices` |
| 学生实时姿态与班级当前姿态构成 | `GET /students/{student_id}/latest` |
| 今日标准坐姿率、监测时长和异常构成 | `GET /students/{student_id}/stats/daily` |
| 今日姿态人数趋势 | `GET /students/{student_id}/history` 前端聚合 |
| 标准坐姿率榜和进步榜 | 每日/每周统计接口 |
| 学生树木阶段与实时姿态 | `GET /students/{student_id}/garden` 和最新遥测 |
| 风险名单、等级、分数和建议 | `GET /admin/risk-students` |
| 设备查看和重新绑定学生 | `GET /devices`、`POST /devices/bind` |
| 学生日报、周报和月报 | `POST /students/{student_id}/reports/generate` |
| 全校原始记录 CSV/Excel 导出 | `GET /admin/export` |
| 风险学生异常记录 ZIP/Excel 导出 | `GET /admin/risk-students/export` |

## 部分适配

### 设备与学生归属

`GET /devices` 不返回当前有效绑定的 `student_id`。页面只能通过学生最新遥测中的 `device_id` 反向匹配，因此从未上传数据的设备无法显示归属。

建议扩展设备列表返回：

```json
{
  "device_id": "SG-0001",
  "student_id": "STU-001",
  "binding_active": true
}
```

### 班级统计请求数

后端没有班级当日统计和班级历史趋势接口。当前页面通过逐学生请求后在前端聚合，小规模班级可以使用，学生较多时请求数会明显增加。

建议增加：

```text
GET /api/v1/admin/classes/{class_id}/stats/daily?date=YYYY-MM-DD
GET /api/v1/admin/classes/{class_id}/stats/trend?from=&to=&bucket=30m
```

## 当前无法完成

| 功能 | 缺失内容 | 建议后端变更 |
|---|---|---|
| 解除设备绑定 | 没有解绑接口 | 增加 `DELETE /devices/{device_id}/binding` |
| 标记维修 | 设备模型没有维修状态字段和更新接口 | 增加 `maintenance_status`、`maintenance_note` 和 PATCH 接口 |
| 班级日报/周报生成与导出 | 只有学生报告接口 | 增加班级报告生成、列表和下载接口 |
| 设备运行报告导出 | 只有原始姿态记录导出 | 增加设备在线、电量、最近上传和固件版本导出 |
| 历史离线人数趋势 | 遥测历史中没有离线事件 | 记录设备在线状态变化事件，或由班级趋势接口返回离线设备数 |
| 今日新增风险、风险下降 | 管理接口只返回每个学生最新风险评估 | 增加风险历史列表或变化摘要 |
| 连续异常天数 | 风险对象不返回连续天数 | 增加 `consecutive_risk_days` |
| 班级筛选导出 | `/admin/export` 只支持全校时间范围 | 增加可选 `class_id` 和 `student_id` 查询参数 |

## 前端降级策略

- 不可用的设备解绑和维修操作显示为禁用按钮，并显示缺少接口的提示。
- 风险变化和连续天数显示 `--`，不在前端伪造历史数据。
- 历史趋势中只统计实际存在的姿态遥测，不将“没有记录”当作“设备离线”。
- 所有成长、风险、报告和导出内容仍以后端返回结果为准。
