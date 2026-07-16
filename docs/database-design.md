# 数据库设计草案

本文档定义后端需要长期保存的数据。第一阶段可以用 SQLite 快速开发，正式联调或比赛演示可切换到 MySQL。

## 设计原则

- 数据库保存可追溯事实和统计结果，不保存 Wi-Fi 密码、明文 Token、手机号或真实班级信息。
- 学生信息在比赛演示阶段使用匿名编号，例如 `STU-DEMO-001`。
- 风险表述使用坐姿行为风险提示或筛查参考，不存储医学诊断结论。
- 原始坐姿记录和聚合统计分开保存，避免每次打开报表都扫描大量原始数据。

## 主要实体关系

```text
users
  └─ user_student_links ─ students
                         └─ device_bindings ─ devices
                         └─ posture_records
                         └─ daily_stats
                         └─ risk_assessments
                         └─ reports
```

## users

用户账号表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `user_id` | varchar | 对外用户编号 |
| `username` | varchar | 登录名 |
| `password_hash` | varchar | 密码哈希 |
| `role` | enum | `parent`、`school_admin`、`doctor`、`admin` |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

## students

学生匿名档案表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `student_id` | varchar | 对外学生编号 |
| `display_code` | varchar | 页面展示用匿名编号 |
| `school_id` | varchar | 学校编号，可为空 |
| `class_id` | varchar | 班级编号，可为空 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

比赛演示阶段不要保存真实姓名、手机号或真实班级名称。

## user_student_links

用户和学生关系表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `user_id` | varchar | 用户编号 |
| `student_id` | varchar | 学生编号 |
| `relation` | varchar | `guardian`、`viewer` 等 |
| `created_at` | datetime | 创建时间 |

## devices

设备表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `device_id` | varchar | 设备编号 |
| `device_token_hash` | varchar | 设备 Token 哈希 |
| `firmware_version` | varchar | 固件版本 |
| `model_version` | varchar | 模型或规则版本 |
| `battery_level` | integer | 电量百分比 |
| `online_status` | enum | `online`、`offline`、`unknown` |
| `last_seen_at` | datetime | 最后上传时间 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

## device_bindings

设备和学生绑定关系表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `device_id` | varchar | 设备编号 |
| `student_id` | varchar | 学生编号 |
| `bound_by_user_id` | varchar | 绑定操作用户 |
| `active` | boolean | 是否当前有效 |
| `bound_at` | datetime | 绑定时间 |
| `unbound_at` | datetime | 解绑时间，可为空 |

## posture_records

坐姿原始记录表。设备每次上传后写入该表，是统计、趋势和报告的基础。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `device_id` | varchar | 设备编号 |
| `student_id` | varchar | 学生编号 |
| `session_id` | varchar | 会话编号 |
| `seq` | integer | 设备递增序号 |
| `timestamp_ms` | bigint | 设备端毫秒时间戳 |
| `recorded_at` | datetime | 后端换算后的记录时间 |
| `posture` | enum | 坐姿分类 |
| `confidence` | decimal | 置信度 |
| `pressure_left` | integer | 左侧归一化压力，0~1000 |
| `pressure_right` | integer | 右侧归一化压力，0~1000 |
| `pressure_front` | integer | 前侧归一化压力，0~1000 |
| `pressure_back` | integer | 后侧归一化压力，0~1000 |
| `pressure_center` | integer | 中央归一化压力，0~1000 |
| `raw_pressure_left` | integer/null | 左侧传感器 ADC 原始值，0~4095 |
| `raw_pressure_right` | integer/null | 右侧传感器 ADC 原始值，0~4095 |
| `raw_pressure_front` | integer/null | 前侧传感器 ADC 原始值，0~4095 |
| `raw_pressure_back` | integer/null | 后侧传感器 ADC 原始值，0~4095 |
| `raw_pressure_center` | integer/null | 中央传感器 ADC 原始值，0~4095 |
| `total_pressure` | integer | 总压力 |
| `left_right_diff` | integer | 左右压力差 |
| `front_back_diff` | integer | 前后压力差 |
| `center_x` | decimal | 压力中心横向偏移 |
| `center_y` | decimal | 压力中心纵向偏移 |
| `asymmetry_index` | decimal | 压力不对称指数 |
| `tilt_x` | decimal | 横向倾角 |
| `tilt_y` | decimal | 前后倾角 |
| `shake_level` | decimal | 晃动强度 |
| `posture_duration_s` | integer | 当前坐姿持续秒数 |
| `sitting_duration_s` | integer | 连续就坐秒数 |
| `warning_active` | boolean | 是否处于提醒状态 |
| `reminder_count` | integer | 累计提醒次数 |
| `battery_level` | integer | 电量百分比 |
| `recognition_source` | enum | `mock`、`rule`、`neural_network` |
| `model_version` | varchar | 模型或规则版本 |
| `firmware_version` | varchar | 固件版本 |
| `created_at` | datetime | 入库时间 |

建议索引：

```text
(device_id, timestamp_ms)
(student_id, timestamp_ms)
(student_id, posture, timestamp_ms)
```

## daily_stats

每日统计表，供报告和趋势页快速读取。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `student_id` | varchar | 学生编号 |
| `stat_date` | date | 统计日期 |
| `total_sitting_s` | integer | 总就坐时长 |
| `normal_sitting_s` | integer | 标准坐姿时长 |
| `poor_sitting_s` | integer | 非标准坐姿时长 |
| `normal_ratio` | decimal | 标准坐姿占比 |
| `left_lean_count` | integer | 左倾次数 |
| `right_lean_count` | integer | 右倾次数 |
| `front_lean_count` | integer | 前倾次数 |
| `back_lean_count` | integer | 后倾次数 |
| `reminder_count` | integer | 提醒次数 |
| `avg_asymmetry_index` | decimal | 平均压力不对称指数 |
| `max_poor_posture_duration_s` | integer | 单次最长非标准坐姿时长 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

## risk_assessments

风险提示表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `student_id` | varchar | 学生编号 |
| `period_start` | date | 统计周期开始 |
| `period_end` | date | 统计周期结束 |
| `risk_level` | enum | `green`、`yellow`、`red` |
| `risk_score` | integer | 风险分，建议 `0~100` |
| `risk_reasons` | json | 风险提示原因列表 |
| `suggestion` | text | 行为建议和筛查参考 |
| `created_at` | datetime | 创建时间 |

## reports

报告表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `student_id` | varchar | 学生编号 |
| `report_type` | enum | `daily`、`weekly`、`monthly` |
| `period_start` | date | 周期开始 |
| `period_end` | date | 周期结束 |
| `summary_json` | json | 规则统计摘要 |
| `content` | text | 报告正文 |
| `generated_by` | enum | `rule`、`llm` |
| `created_at` | datetime | 创建时间 |

## reminder_events

提醒事件表，可选。用于分析提醒触发次数和触发原因。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `device_id` | varchar | 设备编号 |
| `student_id` | varchar | 学生编号 |
| `timestamp_ms` | bigint | 触发时间 |
| `posture` | enum | 触发时坐姿 |
| `reason` | varchar | 触发原因 |
| `created_at` | datetime | 入库时间 |

## notifications

小程序通知表。用于家长端、小程序端查看系统通知、风险提示、提醒和报告生成提示。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `notification_id` | varchar | 对外通知编号 |
| `user_id` | varchar nullable | 指定接收用户，空表示不限用户 |
| `student_id` | varchar nullable | 指定关联学生，家长可查看自己关联学生的通知 |
| `notification_type` | enum | `system`、`risk`、`reminder`、`report` |
| `title` | varchar | 通知标题 |
| `content` | text | 通知内容 |
| `read_at` | datetime nullable | 已读时间 |
| `created_at` | datetime | 创建时间 |
