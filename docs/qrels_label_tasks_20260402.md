# Qrels Label Tasks

- queries: `/home/shuwen/fto/data_sources/queries.jsonl`
- qrels: `/home/shuwen/fto/data_sources/qrels.jsonl`
- min_samples_per_query: `8`
- min_low_per_query: `3`
- min_medium_per_query: `2`
- min_high_per_query: `1`

| query_id | status | total | low | medium | high | need_low | need_medium | need_high | query | desc |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| q1 | needs_labels | 4 | 0 | 2 | 2 | 3 | 0 | 0 | active electromagnetic shielding high power dynamic wireless charging | 高功率动态无线充电场景下的主动电磁屏蔽与漏磁抑制 |
| q2 | needs_labels | 4 | 1 | 2 | 1 | 2 | 0 | 0 | on board vehicle wireless charging system shared components | 车载无线充电系统、共享组件与整车供电架构 |
| q3 | needs_labels | 4 | 0 | 2 | 2 | 3 | 0 | 0 | wireless charging leakage flux shielding safety shield | 无线充电过程中的漏磁降低、电磁屏蔽和安全保护结构 |
| q4 | needs_labels | 4 | 0 | 2 | 2 | 3 | 0 | 0 | multiple coil arrays wireless power transfer power feeding coil unit | 多线圈阵列、供电侧线圈单元与非接触供电结构 |
| q5 | needs_labels | 4 | 1 | 2 | 1 | 2 | 0 | 0 | battery pack thermal management heat pipe cooling | 电池包与储能单元的热管理、散热和热管方案 |
| q6 | needs_labels | 4 | 1 | 1 | 2 | 2 | 1 | 0 | electrochemical energy storage cooling heating temperature control | 车辆电化学储能系统的冷却、加热与温控方案 |
| q7 | needs_labels | 4 | 1 | 1 | 2 | 2 | 1 | 0 | foldable multifunctional wireless charging device | 折叠式、便携式和多功能无线充电设备 |
| q8 | needs_labels | 4 | 1 | 1 | 2 | 2 | 1 | 0 | foreign object detection antenna alignment vehicle guidance wireless charging | 无线充电区域中的异物检测、天线对准和车辆引导 |
| q9 | needs_labels | 4 | 1 | 2 | 1 | 2 | 0 | 0 | smart bracelet mobile device intelligent inductive charger | 面向移动设备、手环和多设备的智能无线充电 |
| q10 | needs_labels | 4 | 2 | 1 | 1 | 1 | 1 | 0 | charging dock thermal management temperature detection heat dissipation | 充电底座和手持电子设备中的热管理、温度检测与散热设计 |
| q11 | needs_labels | 4 | 0 | 2 | 2 | 3 | 0 | 0 | flux coupled magnetic conductor coil structure wireless power transmission | 磁通耦合、磁导体结构与无线功率传输线圈设计 |
| q12 | needs_labels | 4 | 0 | 2 | 2 | 3 | 0 | 0 | electric vehicle charging pad protective shield wireless charging | 电动汽车充电系统、充电垫与屏蔽防护方案 |

## Suggested Batch Fill

### q1

- query: `active electromagnetic shielding high power dynamic wireless charging`
- desc: 高功率动态无线充电场景下的主动电磁屏蔽与漏磁抑制
- current counts: low=0 medium=2 high=2 total=4
- suggested additions: `low:1, low:1, low:1, medium:2`

### q2

- query: `on board vehicle wireless charging system shared components`
- desc: 车载无线充电系统、共享组件与整车供电架构
- current counts: low=1 medium=2 high=1 total=4
- suggested additions: `low:1, low:1, medium:2, low:1`

### q3

- query: `wireless charging leakage flux shielding safety shield`
- desc: 无线充电过程中的漏磁降低、电磁屏蔽和安全保护结构
- current counts: low=0 medium=2 high=2 total=4
- suggested additions: `low:1, low:1, low:1, medium:2`

### q4

- query: `multiple coil arrays wireless power transfer power feeding coil unit`
- desc: 多线圈阵列、供电侧线圈单元与非接触供电结构
- current counts: low=0 medium=2 high=2 total=4
- suggested additions: `low:1, low:1, low:1, medium:2`

### q5

- query: `battery pack thermal management heat pipe cooling`
- desc: 电池包与储能单元的热管理、散热和热管方案
- current counts: low=1 medium=2 high=1 total=4
- suggested additions: `low:1, low:1, medium:2, low:1`

### q6

- query: `electrochemical energy storage cooling heating temperature control`
- desc: 车辆电化学储能系统的冷却、加热与温控方案
- current counts: low=1 medium=1 high=2 total=4
- suggested additions: `low:1, low:1, medium:2, medium:2`

### q7

- query: `foldable multifunctional wireless charging device`
- desc: 折叠式、便携式和多功能无线充电设备
- current counts: low=1 medium=1 high=2 total=4
- suggested additions: `low:1, low:1, medium:2, medium:2`

### q8

- query: `foreign object detection antenna alignment vehicle guidance wireless charging`
- desc: 无线充电区域中的异物检测、天线对准和车辆引导
- current counts: low=1 medium=1 high=2 total=4
- suggested additions: `low:1, low:1, medium:2, medium:2`

### q9

- query: `smart bracelet mobile device intelligent inductive charger`
- desc: 面向移动设备、手环和多设备的智能无线充电
- current counts: low=1 medium=2 high=1 total=4
- suggested additions: `low:1, low:1, medium:2, low:1`

### q10

- query: `charging dock thermal management temperature detection heat dissipation`
- desc: 充电底座和手持电子设备中的热管理、温度检测与散热设计
- current counts: low=2 medium=1 high=1 total=4
- suggested additions: `low:1, medium:2, medium:2, low:1`

### q11

- query: `flux coupled magnetic conductor coil structure wireless power transmission`
- desc: 磁通耦合、磁导体结构与无线功率传输线圈设计
- current counts: low=0 medium=2 high=2 total=4
- suggested additions: `low:1, low:1, low:1, medium:2`

### q12

- query: `electric vehicle charging pad protective shield wireless charging`
- desc: 电动汽车充电系统、充电垫与屏蔽防护方案
- current counts: low=0 medium=2 high=2 total=4
- suggested additions: `low:1, low:1, low:1, medium:2`

