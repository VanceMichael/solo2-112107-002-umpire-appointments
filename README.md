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

## 业务编排引擎（`src/`）

来源服务之上的领域模型把协会派遣、名册、证件分册、行程确认、场馆签退、跨场调任、替补与补助接成一条可追溯链路。`npm test` 运行全部用例（含来源服务原有用例与 `test/` 下的业务用例）。

- `src/identity.mjs`：名册按“协会 + 裁判号”定身份；协会内别名换号，跨协会同号（如 `n/O1`、`e/O1`）是两个人，任何路径都不自动合并；无上下文消歧时挂 `identity-ambiguous` 待核对。
- `src/certificates.mjs`：证件只在注明的赛制/级别内适用（高级别覆盖低级别）；`through` 含当日、`revoked_day` 自赛地零时生效、续证 `from_day` 当日零时生效。分册按当日索引发布，某批次 503/404 时即使历史批次装载过也撤回可查标记，资格判 `unverifiable` 并列出缺哪一册。
- `src/schedule.mjs`：保留每场修订历史；提前或分场改期后，行程与承诺按新时间窗重算。
- `src/travel.mjs`：只认 `confirmed` 行程；转场要求同一交通确认同时满足两边报到时限，外地场距前一场实际签退至少 30 分钟。
- `src/commitments.mjs`：已确认派遣、已接受替补、场馆签退是硬占用；`assigned`、待确认取消只软标记，不阻塞也不产生第二份全额。
- `src/substitutions.mjs` + `League`：一个原派只允许一项生效替补；同场同角色不得两项确认替补；候选须同时过资格、行程、外部场次冲突、调任确认四道门槛。门户 503 保留本地 `proposed`，可凭同一 key 重试，inspect 404 显式挂待核对。
- `src/delegations.mjs`：接收与释放双方都 `confirmed` 旧承诺才解除；pending 期间下一场不可派发。
- `src/attendance.mjs`：按场/角色/事实号保存实际执裁区间；同场同角色重叠送场馆复核，重复事实号只承认一次。派遣页挂名不代表到场，执裁事实只来自这里。
- `src/subsidy.mjs`：实际执裁按分钟计费，已出发未上场计空跑费；已确认凭据留原单（`retained`），判定变更另列 `adjustments` 差额；同场同角色多张全场全额识别为重复补领。

### 入口与演示

- `League.loadBundle(phase, pages)` 直接吃阶段页面（离线测试用），`League.ingest(client, phase)` 经 `SourceClient` 走 HTTP 拉取。
- 排裁判视角：`substitutionDesk(game)`（候选门槛、改期依据、查不到的资格）与 `personalRecord(identity)`（资格、行程、承诺、调任、签退）。
- 结补助视角：`gameView(game)` 与 `subsidyDossier(game)`（实际执裁区间、联系替补的原因与时间线、还等哪家协会或场馆核对）。
- `node scenarios/run-league.mjs` 启动来源服务并跑完 opening → interim → confirmed 三阶段的替补提出、门户对账与赛后补助裁决。
