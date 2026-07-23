# 脊小树项目文件说明

这是一份给后续简单修改用的项目说明。项目是微信小程序，主要代码在 `miniprogram/`，云函数在 `cloudfunctions/`。

## 一、整体目录

```text
脊小树/
├── miniprogram/                  小程序前端代码
│   ├── app.js                    小程序启动入口，初始化云开发
│   ├── app.json                  小程序全局配置、页面列表、底部 tab
│   ├── app.wxss                  全局公共样式
│   ├── envList.js                云环境列表，目前基本未使用
│   ├── sitemap.json              小程序搜索收录规则
│   ├── pages/                    所有页面
│   ├── components/               自定义组件
│   └── 1_custom-tab-bar/         自定义底部 tabbar 组件
├── cloudfunctions/
│   └── quickstartFunctions/      云函数，负责设备验证、报告生成等
├── project.config.json           微信开发者工具项目配置
├── project.private.config.json   微信开发者工具本机私人配置
├── uploadCloudFunction.sh        上传云函数脚本
└── README.md                     云开发模板说明
```

## 二、微信小程序文件规则

每个页面一般都有 4 个文件：

```text
xxx.js      页面数据和点击逻辑
xxx.wxml    页面结构，相当于 HTML
xxx.wxss    页面样式，相当于 CSS
xxx.json    页面标题、组件等配置
```

以后修改时可以按这个规律找：

- 改文字、按钮、页面布局：先看 `.wxml`
- 改颜色、间距、大小、圆角：看 `.wxss`
- 改点击后发生什么、数据怎么变：看 `.js`
- 改页面顶部标题：看 `.json` 的 `navigationBarTitleText`
- 新增页面：需要在 `miniprogram/app.json` 的 `pages` 里注册

## 三、全局文件

### `miniprogram/app.js`

小程序启动入口。

主要作用：

- 设置云开发环境 ID：`cloud1-d9g2c4cucc9ffa585`
- 调用 `wx.cloud.init()` 初始化云开发
- 后续前端调用云函数、数据库都依赖这里初始化

常见修改：

- 如果换云开发环境，修改 `globalData.env`

### `miniprogram/app.json`

全局配置文件。

主要作用：

- `pages`：注册所有页面路径
- `window`：设置全局顶部导航栏颜色、标题
- `tabBar`：设置底部四个主入口

当前底部 tab：

- 监测：`pages/monitor/monitor`
- 数据：`pages/data/data`
- 乐园：`pages/game/game`
- 我的：`pages/profile/profile`

常见修改：

- 改底部 tab 名字：修改 `tabBar.list[].text`
- 新增页面：把页面路径加入 `pages`
- 改全局顶部标题：修改 `window.navigationBarTitleText`

注意：项目里还有 `miniprogram/1_custom-tab-bar/`，但当前 `app.json` 里没有配置 `"custom": true`，所以主要还是原生 tabBar 配置。

### `miniprogram/app.wxss`

全局样式。

主要作用：

- 设置页面背景色
- 去掉按钮默认边框
- 定义通用 `.container`

常见修改：

- 全局背景色：改 `page { background: ... }`
- 按钮默认样式：改 `button` 相关规则

### `miniprogram/envList.js`

云环境列表文件。目前 `envList` 是空数组，实际云环境写在 `app.js` 里。

### `miniprogram/sitemap.json`

小程序页面搜索收录规则。当前配置是允许所有页面。

### `project.config.json`

微信开发者工具项目配置。

主要作用：

- 指定小程序源码目录：`miniprogramRoot`
- 指定云函数目录：`cloudfunctionRoot`
- 指定 appid：`wx7e2961fc078f1925`
- 指定基础库版本：`3.15.2`

一般不需要频繁修改。

## 四、主要页面

### 1. 登录/设备绑定页

目录：`miniprogram/pages/login/`

文件：

- `login.wxml`：设备代号、设备密钥输入框，绑定按钮，体验模式按钮
- `login.wxss`：登录页 logo、输入框、按钮样式
- `login.js`：登录逻辑
- `login.json`：顶部标题“设备绑定”

核心逻辑：

- 打开页面时读取本地 `boundDevice`
- 如果已经绑定设备，自动跳到监测页
- 点击“绑定并登录”时调用云函数 `quickstartFunctions`
- 云函数参数 `type: 'verifyDevice'`
- 登录成功后把设备信息保存到本地缓存 `boundDevice`
- 点击“先体验完整功能”会写入模拟设备 `DEMO-001`

常见修改：

- 改输入框提示文字：改 `login.wxml`
- 改登录按钮文字：改 `login.wxml`
- 改体验设备编号：改 `login.js` 的 `useDemoDevice()`
- 改设备验证逻辑：改云函数 `cloudfunctions/quickstartFunctions/index.js` 的 `verifyDevice`

### 2. 实时监测页

目录：`miniprogram/pages/monitor/`

文件：

- `monitor.wxml`：风险卡片、设备状态条、坐姿卡片、热力图、控制按钮、风险说明弹窗
- `monitor.wxss`：监测页卡片、热力图、弹窗、按钮样式
- `monitor.js`：实时监测和模拟数据逻辑
- `monitor.json`：顶部标题“脊小树 · 监测”

核心数据：

- `riskLevel`：风险等级，`low`、`medium`、`high`
- `riskLevelText`：显示的“低/中/高”
- `riskColor`：风险颜色
- `postureName`：当前坐姿名称
- `postureIcon`：坐姿图标
- `heatmapRows`：热力图显示数据
- `vibrationEnabled`：是否开启振动提醒
- `deviceConnected`：设备是否连接

核心逻辑：

- `onLoad()` 初始化热力图和设备状态
- `onShow()` 设置 tab 选中状态，并启动模拟数据刷新
- `startMockDataRefresh()` 每 6 秒调用一次 `mockUpdatePosture()`
- `mockUpdatePosture()` 随机生成坐姿、风险、热力图
- 不是低风险时，会弹出提示并调用 `wx.vibrateShort()`
- `manualRefresh()` 手动同步一次模拟数据
- `goToDeviceManage()` 跳转到设备管理页

常见修改：

- 改刷新频率：修改 `startMockDataRefresh()` 里的 `6000`
- 关闭自动模拟刷新：注释 `onShow()` 里的 `this.startMockDataRefresh()`
- 改坐姿类型和文案：修改 `mockUpdatePosture()` 里的 `postures`
- 改热力图颜色：修改 `getColor(value)`
- 改热力图大小：修改 `initHeatmap()` 和 `generateRandomHeatmap()` 的 `rows`、`cols`
- 改风险说明弹窗文字：改 `monitor.wxml` 底部弹窗内容

### 3. 数据趋势页

目录：`miniprogram/pages/data/`

文件：

- `data.wxml`：日/周/月/年切换、折线图 canvas、姿态占比、指标卡片
- `data.wxss`：趋势页 tab、图表卡片、指标卡片样式
- `data.js`：图表绘制和模拟数据
- `data.json`：顶部标题“数据趋势”

核心逻辑：

- `currentTab` 控制当前显示日、周、月、年
- `postureData` 是姿态分布占比数据
- `drawLineChart()` 获取 canvas 尺寸
- `paintLineChart()` 用 `wx.createCanvasContext` 绘制折线图
- `valuesMap` 里保存不同时间维度的模拟 PAI 数据

常见修改：

- 改趋势数据：修改 `paintLineChart()` 里的 `valuesMap`
- 改姿态占比：修改 `postureData`
- 改今日指标：修改 `todayCorrectMinutes`、`maxContinuous`、`totalReminders`
- 改图表颜色：修改 `ctx.setStrokeStyle('#3498DB')`

### 4. 乐园成长页

目录：`miniprogram/pages/game/`

文件：

- `game.wxml`：成长树、今日得分、进度条、排行榜预览
- `game.wxss`：成长卡片、得分卡片、排行榜样式
- `game.js`：成长值和排行榜模拟数据
- `game.json`：顶部标题“乐园”

核心逻辑：

- `growthValue`：成长值
- `treeStage`：成长阶段，1 种子、2 小芽、3 小树、4 大树
- `updateTreeStage()` 根据成长值计算阶段
- `topThree` 是排行榜前三名
- `goToRanking()` 跳转完整排行榜

常见修改：

- 改成长值：修改 `growthValue`
- 改阶段门槛：修改 `updateTreeStage()`
- 改排行榜前三名：修改 `topThree`
- 改鼓励语：修改 `encourageText`

### 5. 排行榜页

目录：`miniprogram/pages/ranking/`

文件：

- `ranking.wxml`：我的排名、今日得分、排行榜列表
- `ranking.wxss`：排行榜列表样式
- `ranking.js`：排行榜模拟数据
- `ranking.json`：顶部标题“班级排行榜”

核心数据：

- `myRank`：我的排名
- `myScore`：我的得分
- `rankingList`：排行榜列表

常见修改：

- 改排行榜人员和分数：修改 `ranking.js` 的 `rankingList`
- 改我的排名：修改 `myRank`
- 改我的得分：修改 `myScore`

### 6. 我的页

目录：`miniprogram/pages/profile/`

文件：

- `profile.wxml`：用户信息、设备状态、功能菜单
- `profile.wxss`：头像、菜单列表样式
- `profile.js`：菜单跳转和解绑逻辑
- `profile.json`：顶部标题“我的”

菜单入口：

- 设备管理
- 孩子信息
- AI运动建议
- 报告中心
- 帮助与反馈
- 关于我们
- 解除设备绑定

核心逻辑：

- `onLoad()` 从 `boundDevice` 读取设备编号
- `onShow()` 设置底部 tab 选中“我的”
- `unbindDevice()` 清空本地缓存，并跳回登录页
- `goToXXX()` 都是页面跳转函数

常见修改：

- 改菜单文字：改 `profile.wxml`
- 改菜单跳转：改 `profile.js` 对应 `goToXXX`
- 改默认昵称：改 `profile.js` 的 `userInfo.nickName`

### 7. 设备管理页

目录：`miniprogram/pages/device-manage/`

文件：

- `device-manage.wxml`：设备信息、连接、校准、振动设置、学习模式、免打扰、自检、固件升级、解绑
- `device-manage.wxss`：设备管理页所有卡片和设置项样式
- `device-manage.js`：设备状态、设置保存、按钮逻辑
- `device-manage.json`：顶部标题“设备管理”

核心本地缓存：

- `boundDevice`：绑定设备信息
- `deviceState`：设备连接、电量、同步时间等状态
- `deviceSettings`：触发时间、振动强度、学习模式、免打扰等设置
- `vibrationEnabled`：振动提醒开关

核心逻辑：

- `loadDeviceState()` 从本地缓存读取设备和设置
- `toggleConnection()` 模拟连接/断开蓝牙
- `calibratePosture()` 模拟坐姿校准
- `saveSettings()` 保存设置到本地缓存
- `runSelfCheck()` 模拟一键自检
- `upgradeFirmware()` 弹窗提示当前已是最新版本
- `unbindDevice()` 清空本地缓存并回到登录页

常见修改：

- 改默认设备信息：修改 `device`
- 改振动触发选项：修改 `triggerOptions`
- 改振动强度选项：修改 `strengthOptions`
- 改提醒间隔：修改 `intervalOptions`
- 改学习时长：修改 `studyDurationOptions`
- 改自检项目：修改 `selfCheckItems`

### 8. 孩子信息页

目录：`miniprogram/pages/child-info/`

文件：

- `child-info.wxml`：姓名、性别、年级、班级表单
- `child-info.wxss`：表单样式
- `child-info.js`：读取和保存孩子信息
- `child-info.json`：顶部标题“孩子信息”

核心逻辑：

- 页面打开先读取本地缓存 `childInfo`
- 如果本地没有，尝试从云数据库 `children` 集合读取
- 保存时先写本地缓存，再尝试写云数据库
- 云数据库有记录就更新，没有记录就新增

常见修改：

- 改默认性别/年级：修改 `form`
- 改年级范围：修改 `gradeOptions`
- 改保存校验：修改 `saveChildInfo()`
- 改云数据库集合名：修改 `collection('children')`

### 9. AI运动建议页

目录：`miniprogram/pages/ai-sports/`

文件：

- `ai-sports.wxml`：日期切换、推荐重点、运动列表
- `ai-sports.wxss`：日期栏、建议卡片、运动卡片样式
- `ai-sports.js`：请求云函数生成运动建议，接口不可用时使用本地方案
- `ai-sports.json`：顶部标题“AI运动建议”

核心逻辑：

- `onLoad()` 默认显示今天
- `prevDay()`、`nextDay()` 前后切换日期
- `loadAiAdvice(date)` 调用云函数 `generateAiSportsAdvice`
- `getSportLibrary(dateKey)` 是模型不可用时的本地降级方案
- API Key 仅保存在云函数环境变量，不能放在小程序前端

常见修改：

- 改推荐运动内容：修改 `getSportLibrary()` 里的 `plans`
- 改模型提示词或接口：修改云函数 `callLlm()`、`generateAiSportsAdvice()`
- 改日期显示格式：修改 `formatDisplayDate()`
- 改前后切换逻辑：修改 `shiftDate()`

### 10. 报告中心页

目录：`miniprogram/pages/report-center/`

文件：

- `report-center.wxml`：生成新报告按钮、报告列表、报告详情
- `report-center.wxss`：报告列表、风险标签、详情卡片样式
- `report-center.js`：报告生成、选择、保存逻辑
- `report-center.json`：顶部标题“报告中心”

核心逻辑：

- `loadReports()` 读取本地缓存 `reports`
- 如果没有缓存，使用内置默认报告
- `createReport()` 创建一份模拟报告
- `generateReport()` 调用云函数 `generateWeeklyReport`
- 云函数失败时，前端会自动生成一份本地模拟报告
- `insertGeneratedReport()` 把新报告插入列表并保存到本地缓存

常见修改：

- 改默认报告：修改 `loadReports()` 里的 `defaults`
- 改报告结构：修改 `createReport()`
- 改报告建议文案：修改 `advice`
- 改云端报告生成：修改云函数 `generateWeeklyReport()`

### 11. 帮助与反馈页

目录：`miniprogram/pages/help-feedback/`

文件：

- `help-feedback.wxml`：常见问题列表、反馈输入框、联系方式输入框
- `help-feedback.wxss`：FAQ 和反馈表单样式
- `help-feedback.js`：展开问题、提交反馈
- `help-feedback.json`：顶部标题“帮助与反馈”

核心逻辑：

- `faqs` 保存常见问题
- `toggleFaq()` 控制展开/收起
- `submitFeedback()` 校验反馈内容
- 提交后保存到本地缓存 `feedbackList`
- 如果云数据库可用，也写入 `feedback` 集合

常见修改：

- 改常见问题：修改 `faqs`
- 改提交校验：修改 `submitFeedback()`
- 改云数据库集合名：修改 `collection('feedback')`

### 12. 关于我们页

目录：`miniprogram/pages/about/`

文件：

- `about.wxml`：产品名称、版本、说明、隐私政策、客服邮箱、客服微信
- `about.wxss`：品牌卡片和信息列表样式
- `about.js`：复制链接、邮箱、微信到剪贴板
- `about.json`：顶部标题“关于我们”

核心数据：

- `productName`
- `version`
- `privacyUrl`
- `serviceEmail`
- `serviceWechat`

常见修改：

- 改版本号：修改 `version`
- 改隐私政策链接：修改 `privacyUrl`
- 改客服邮箱/微信：修改 `serviceEmail`、`serviceWechat`
- 改产品介绍：修改 `about.wxml` 的说明文字

## 五、自定义组件

### `miniprogram/1_custom-tab-bar/`

自定义底部 tabbar 组件。

文件：

- `index.wxml`：tabbar 结构
- `index.wxss`：固定在底部的样式
- `index.js`：点击切换 tab
- `index.json`：声明这是组件

当前注意点：

- `app.json` 里没有 `"custom": true`
- 因此这个组件可能不是当前真正生效的底部 tabbar
- 如果想启用自定义 tabbar，需要在 `app.json` 的 `tabBar` 里配置 `"custom": true`

### `miniprogram/components/cloudTipModal/`

底部弹窗组件。

文件：

- `index.wxml`：遮罩、底部弹窗、关闭按钮
- `index.wxss`：遮罩和弹窗样式
- `index.js`：控制显示/隐藏
- `index.json`：声明组件

当前注意点：

- 组件里使用了 `../../images/icons/close.png`
- 当前项目文件列表里没有看到这个图片路径，使用前需要补齐图片或改成文字关闭按钮
- 目前主要页面里没有明显引用这个组件

## 六、云函数

目录：`cloudfunctions/quickstartFunctions/`

### `index.js`

云函数主文件。

已有功能：

- `getOpenId`：获取用户 openid
- `getMiniProgramCode`：生成小程序二维码并上传云存储
- `createCollection/selectRecord/updateRecord/insertRecord/deleteRecord`：微信云开发模板里的 `sales` 示例数据功能
- `verifyDevice`：验证设备代号和密钥
- `generateWeeklyReport`：生成周报
- `generateAiSportsAdvice`：生成每日运动建议

项目真正常用的是：

- `verifyDevice`
- `generateWeeklyReport`
- `generateAiSportsAdvice`

#### `verifyDevice`

用途：

- 登录页点击“绑定并登录”时调用
- 查询云数据库 `devices` 集合
- 检查 `deviceCode` 是否存在
- 检查 `deviceKey` 是否正确
- 检查设备是否已经被其他用户绑定
- 未绑定时写入当前用户 openid
- 成功后返回设备信息

云数据库 `devices` 集合至少需要字段：

```js
{
  deviceCode: 'S001',
  deviceKey: 'xxxx',
  nickName: '脊小树坐姿垫',
  boundOpenid: '',
  lastActiveTime: Date
}
```

#### `generateWeeklyReport`

用途：

- 报告中心点击“生成新报告”时调用
- 报告指标目前仍为模拟数据；配置大模型后会生成个性化建议文案
- 会尝试写入云数据库 `reports` 集合
- 返回给前端展示

常见修改：

- 改报告风险等级：修改 `riskLevel`
- 改 PAI 值：修改 `pai`
- 改曲线数据：修改 `curve`
- 改建议：修改 `advice`
- 接真实数据时，应在这里查询真实坐姿数据后再生成报告

#### 大模型 API 配置

大模型用于两类需要自然语言生成的功能：每日运动建议和周报建议。实时压力图、坐姿风险判定、设备连接不调用大模型，避免高频请求产生延迟和费用。

在微信云开发中为 `quickstartFunctions` 设置以下环境变量：

- `LLM_API_KEY`：API Key
- `LLM_BASE_URL`：OpenAI 兼容接口根地址，例如 `https://api.deepseek.com/v1`
- `LLM_MODEL`：模型名称，例如 `deepseek-chat`

完整部署步骤见项目根目录的 `LLM_SETUP.md`。Key 不能写入 `miniprogram/`、`app.js` 或 Git。

### `package.json`

云函数依赖配置。

当前依赖：

- `wx-server-sdk`

### `config.json`

云函数权限配置。

当前允许调用：

- `wxacode.get`

## 七、当前本地缓存字段

项目大量使用 `wx.setStorageSync()` 保存本地数据。

常见 key：

- `boundDevice`：登录后绑定的设备信息
- `deviceState`：设备连接状态、电量、同步时间
- `deviceSettings`：设备管理页里的设置
- `vibrationEnabled`：振动提醒开关
- `childInfo`：孩子信息
- `feedbackList`：本地反馈记录
- `reports`：本地报告列表

调试时如果页面数据异常，可以在微信开发者工具里清除缓存，或者代码里临时调用：

```js
wx.clearStorageSync()
```

## 八、常见修改入口速查

### 修改页面顶部标题

改对应页面 `.json`：

```json
{
  "navigationBarTitleText": "新的标题"
}
```

### 修改底部 tab 名字

改 `miniprogram/app.json`：

```json
"tabBar": {
  "list": [
    {"pagePath": "pages/monitor/monitor", "text": "监测"}
  ]
}
```

### 修改首页/启动页

改 `miniprogram/app.json` 的 `pages` 顺序。第一个页面就是默认启动页。

当前第一个页面是：

```text
pages/login/login
```

### 修改模拟坐姿刷新

改 `miniprogram/pages/monitor/monitor.js`：

- 刷新频率：`startMockDataRefresh()`
- 坐姿列表：`mockUpdatePosture()` 的 `postures`
- 热力图：`generateMockSensorReadings()` 和 `drawPressureHeatmap()`

### 修改设备登录验证

前端入口：

```text
miniprogram/pages/login/login.js
```

云函数入口：

```text
cloudfunctions/quickstartFunctions/index.js
```

重点函数：

```js
verifyDevice()
```

### 修改报告内容

前端默认报告：

```text
miniprogram/pages/report-center/report-center.js
```

云端生成报告：

```text
cloudfunctions/quickstartFunctions/index.js
```

重点函数：

```js
generateWeeklyReport()
```

### 修改孩子信息表单

改：

```text
miniprogram/pages/child-info/child-info.wxml
miniprogram/pages/child-info/child-info.js
```

### 修改设备管理设置项

改：

```text
miniprogram/pages/device-manage/device-manage.wxml
miniprogram/pages/device-manage/device-manage.js
```

## 九、开发注意事项

1. 改完页面路径后，一定要同步修改 `app.json`。
2. 页面跳转路径要以 `/pages/.../...` 开头。
3. tabBar 页面之间用 `wx.switchTab()`，普通页面跳转用 `wx.navigateTo()`。
4. 云函数改完后，需要在微信开发者工具里重新上传部署云函数。
5. 本地缓存会影响调试结果，遇到奇怪数据先清缓存。
6. 当前很多数据是模拟数据，不是全部来自真实设备。
7. 设备验证依赖云数据库 `devices` 集合，报告依赖 `reports` 集合，孩子信息依赖 `children` 集合，反馈依赖 `feedback` 集合。
