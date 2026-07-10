# ESP32-S3固件

当前已支持：
- GPIO4/ADC1_CH3读取左侧FSR；
- GPIO5/ADC1_CH4读取右侧FSR；
- 串口输出统一JSON；
- 配置Wi-Fi后，每5秒向FastAPI上传一次；
- 前、后、中3路暂时填0。

## 配置

```powershell
idf.py set-target esp32s3
idf.py menuconfig
```

进入`SpineGuard`配置：
- Wi-Fi名称和密码；
- 后端地址，例如`http://192.168.1.20:8000/api/v1/device/telemetry`；
- 设备Token；
- 设备ID。

注意：ESP32和运行后端的电脑必须在同一局域网，后端地址不能写`127.0.0.1`。

## 编译和烧录

```powershell
idf.py build
idf.py -p COM4 flash monitor
```

另外3个FSR到货后，再增加GPIO6、GPIO7、GPIO8及空载校准、EMA滤波和正式模型。
