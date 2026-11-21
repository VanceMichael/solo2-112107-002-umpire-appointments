# 外派裁判替补的履约凭据采集

县级联赛的赛务办公室按场次与裁判角色保存派遣、协会证件、签到和补助凭据。 这些上游资料可通过本地合成接口查阅。赛程、协会和费用登记各自出件。赛程时间带 UTC 偏移，证件日期按赛地日历。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式和本地门户交互。服务重启会清空临时门户请求。

## 来源协议

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

证件 through 含当日，revoked_day 自当天零时起生效，时间用比赛当地时区。travel 只有 confirmed 是可用到达凭据。外地场在前一场签退后至少 30 分钟才可开始。attendance 是实际签退，可能包含已派遣端未承认的现场事项。fees 给出按实际分钟计费的分和空跑费，重叠区间由场馆决定，对按场及角色重复补领的事实号只承认一次。portal 支持 substitute 和 inspect。
delegations 是委派双方各自的确认，receiving_decision 与 releasing_decision 都 confirmed 方能承接旧任职承诺，旧场实际签退仍以场馆为准。replacement 请求与原 dispatch.ref 驱动，同一场次不得同时有两项确认的替补。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`schedule`, `dispatch`, `roster`, `license-index`, `north-cert`, `east-cert`, `travel`, `attendance`, `expense`, `fees`, `delegations`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `result`。合成门户保留请求并提供回执查询。

`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。
