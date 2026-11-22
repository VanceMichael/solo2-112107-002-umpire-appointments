// 端到端演示：从合成来源逐阶段拉资料，驱动值班员的替补决策与赛后补助裁决。
// 运行：node scenarios/run-league.mjs（需先 npm run source）

import { once } from 'node:events';
import { makeSource } from '../source.mjs';
import { League, SourceClient } from '../src/index.mjs';

async function main() {
  const server = makeSource().listen(Number(process.env.SOURCE_PORT ?? 4173), '127.0.0.1');
  await once(server, 'listening');
  const client = new SourceClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const league = new League();

  for (const phase of ['opening', 'interim', 'confirmed']) {
    await league.ingest(client, phase);
    console.log(`\n===== 阶段 ${phase} =====`);
    const desk = league.substitutionDesk('G1');
    if (desk.reschedule) {
      console.log('G1 改期：', desk.reschedule.from.start, '->', desk.reschedule.to.start);
    }
    for (const c of desk.candidates) {
      console.log(`候选 ${c.identity.padEnd(6)} eligible=${c.eligible}`,
        c.gates.map((g) => `${g.code}:${g.ok ? 'ok' : 'fail'}`).join(' '));
    }
    for (const item of desk.eligibilityBacklog) {
      console.log('查不到资格：', item.identity, item.reasons.join('；'));
    }
  }

  // 值班员在 confirmed 阶段依据资格+行程提出替补，并走门户。
  const sub = league.proposeSubstitution({
    dispatchRef: 'A1', substitute: 'e/O2',
    reason: 'G1 提前至 09:50，原派 n/O1 已确认行程 10:45 才到 D 镇，无法赶上报到',
  });
  await league.submitToPortal(client, 'confirmed', sub.ref, {
    key: 'league-demo-sub-g1', facts: { triggeredBy: 'reschedule-0950' },
  });
  await league.reconcilePortal(client, 'confirmed', sub.ref);

  console.log('\n===== 赛后补助档案 G1 =====');
  console.log(JSON.stringify(league.subsidyDossier('G1'), null, 2));

  console.log('\n===== 调任 MOVE8 状态 =====');
  console.log(JSON.stringify(league.delegationStatus('MOVE8'), null, 2));

  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
