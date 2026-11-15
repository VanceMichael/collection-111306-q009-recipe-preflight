import { resolve } from 'node:path';
import { startSource } from './source.mjs';
import { CaptureStore } from './store.mjs';
import { preview } from './domain.mjs';
import { preflight } from './preflight.mjs';
import { dryRun } from './dryrun.mjs';
import { executeFormal } from './execute.mjs';

function printPreflight(result) {
  console.log(`\n── 配方 ${result.recipe}：${result.verdict === 'pass' ? '预检通过' : '预检未通过'}（指纹 ${result.fingerprint ? result.fingerprint.slice(0, 12) + '…' : '无'}）`);
  for (const path of result.paths) {
    console.log(`  路径 ${path.ok ? '✓' : '✗'} ${path.label}${path.ok ? '' : '　问题：' + path.problems.join('、')}`);
  }
  for (const finding of result.findings) {
    console.log(`  [${finding.severity === 'error' ? '错误' : '提示'}] ${finding.code} @ ${finding.path || finding.step || '配方'}`);
    console.log(`    ${finding.message}`);
    if (finding.fix) console.log(`    改法：${finding.fix}`);
  }
}

const source = await startSource();
try {
  const snapshot = async () => (await fetch(source.url + '/api/snapshot')).json();
  const data = await snapshot();

  console.log('══ 原有适配器预览（保留调用） ══');
  console.log(JSON.stringify(preview(data)));

  console.log('\n══ 逐条配方预检：每条可达路径的输入来源与能力核对 ══');
  const verdicts = new Map();
  for (const recipe of data.recipes) {
    const result = preflight(recipe, data.adapters);
    verdicts.set(recipe.id, result);
    printPreflight(result);
  }

  const good = data.recipes.find(recipe => recipe.id === 'paged-collect');
  const inputs = { seed: 'seed-1', label: '批次A' };

  console.log('\n══ 试运行：只用本地资料源，不触发对外写入 ══');
  const dry = await dryRun(good, data.adapters, verdicts.get(good.id), inputs);
  console.log(`试运行 ${dry.id} 完成：${dry.steps.length} 个事件；跳过的对外动作：${dry.withheld.join('、') || '无'}`);
  console.log(`  翻页结果：${dry.scope.page}；回执占位：${dry.scope.receipt}`);
  console.log(`  ${dry.note}`);

  console.log('\n══ 正式领取：凭有效的预检与试运行结论执行 ══');
  const path = resolve(process.env.CAPTURE_PATH ?? 'var/captures.json');
  const store = new CaptureStore(path);
  await store.append({ kind: 'recipe-preflight', observed: preview(data), verdicts: Object.fromEntries([...verdicts].map(([id, r]) => [id, r.verdict])), at: new Date().toISOString() });
  const run = await executeFormal({ recipe: good, adapters: data.adapters, preflightResult: verdicts.get(good.id), dryReport: dry, inputs, store });
  console.log(`正式运行 ${run.runId} 完成：收到 ${run.scope.page}，回执 ${run.receipt}`);
  console.log(`  轨迹：${run.trace.map(event => event.type === 'iteration' ? `${event.step}#${event.count}` : event.type === 'pause' ? `${event.step}⏸` : event.step ?? event.type).join(' → ')}`);

  console.log('\n══ 试运行令牌不得带进正式执行 ══');
  const dryToken = `dry:${dry.id}:tok-2`;
  try {
    await executeFormal({ recipe: good, adapters: data.adapters, preflightResult: verdicts.get(good.id), dryReport: dry, inputs: { seed: dryToken } });
    console.log('意外：试运行令牌被接受了');
  } catch (error) {
    console.log(`拒绝执行：${error.message}`);
  }

  console.log('\n══ 配方变更后的旧结论核对 ══');
  await fetch(source.url + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'edit' }) });
  const changed = await snapshot();
  const changedRecipe = changed.recipes.find(recipe => recipe.id === 'paged-collect');
  try {
    await executeFormal({ recipe: changedRecipe, adapters: changed.adapters, preflightResult: verdicts.get(good.id), dryReport: dry, inputs });
    console.log('意外：旧结论仍被接受');
  } catch (error) {
    console.log(`拒绝执行：${error.message}`);
  }
  const rechecked = preflight(changedRecipe, changed.adapters);
  console.log(`重新预检：${rechecked.verdict === 'pass' ? '通过' : '未通过'}（新指纹 ${rechecked.fingerprint.slice(0, 12)}…，可重新试运行后领取）`);

  const state = await store.read();
  console.log(`\n接收文件 ${path} 已存记录 ${state.revision} 条`);
} finally {
  await source.close();
}
