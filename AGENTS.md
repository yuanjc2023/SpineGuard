# Codex协作说明

- 修改遥测字段时，同步更新`shared/schema.json`、后端模型、Web类型、小程序解析和固件结构。
- 模拟数据必须标记`recognition_source=mock`。
- 不提交Wi-Fi密码、Token、学生姓名、手机号或真实班级信息。
- 风险结果只能表述为坐姿行为风险提示或筛查参考，不得表述为医学诊断。
- 后端验证：`pytest`
- Web验证：`npm run build`
- 固件验证：`idf.py build`
