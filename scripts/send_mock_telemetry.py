import itertools, random, time, httpx
URL="http://127.0.0.1:8000/api/v1/device/telemetry"
profiles={
 "empty":(0,0,0,0,0),"normal":(520,510,430,620,760),
 "left_lean":(850,260,430,610,700),"right_lean":(250,860,420,600,700),
 "front_lean":(520,510,850,250,650),"back_lean":(510,520,260,860,690)
}
seq=0
reminder_count=0

def pressure_features(vals):
    left,right,front,back,center=vals
    total=sum(vals)
    lr=left-right
    fb=front-back
    center_x=round(lr/max(left+right,1),2)
    center_y=round(fb/max(front+back,1),2)
    asym=round((abs(lr)+abs(fb))/max(total,1),2)
    return {
      "total_pressure":total,"left_right_diff":lr,"front_back_diff":fb,
      "center_x":max(-1,min(1,center_x)),"center_y":max(-1,min(1,center_y)),
      "asymmetry_index":max(0,min(1,asym))
    }

for posture in itertools.cycle(profiles):
    start=time.time()
    for _ in range(10):
        seq+=1
        vals=[max(0,min(1000,v+random.randint(-35,35))) for v in profiles[posture]]
        warning=posture not in ("empty","normal")
        if warning:
            reminder_count+=1
        data={
          "protocol_version":1,"device_id":"SG-0001","session_id":"S-MOCK-001","seq":seq,
          "timestamp_ms":int(time.time()*1000),"posture":posture,"confidence":round(random.uniform(.88,.99),2),
          "pressure":dict(zip(["left","right","front","back","center"],vals)),
          "pressure_features":pressure_features(vals),
          "imu":{"tilt_x":round(random.uniform(-3,3),2),"tilt_y":round(random.uniform(-3,3),2),"shake_level":round(random.uniform(0,0.08),2)},
          "posture_duration_s":int(time.time()-start),"sitting_duration_s":0 if posture=="empty" else seq,
          "vibration_enabled":True,"warning_active":warning,
          "reminder_count":reminder_count,"battery_level":95,
          "recognition_source":"mock","model_version":"mock-v0.1","firmware_version":"0.1.0"
        }
        r=httpx.post(URL,headers={"X-Device-Token":"dev-token"},json=data,timeout=5);r.raise_for_status()
        print(posture,vals);time.sleep(1)
