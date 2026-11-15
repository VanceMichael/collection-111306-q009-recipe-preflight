import { randomUUID } from 'node:crypto';
import { fingerprint } from './recipe.mjs';
import { runRecipe } from './runtime.mjs';
import { makeLocalImpls } from './localdata.mjs';

// 试运行：只用本地资料源，写能力步骤一律跳过（withheld），
// 产出的令牌带 dry 标记，仅供本次试运行使用。
export async function dryRun(recipe, adapters, preflightResult, inputs = {}) {
  const fp = fingerprint(recipe, adapters);
  if (!preflightResult || preflightResult.fingerprint !== fp.fingerprint) {
    throw new Error('预检结论与当前配方或适配器能力不一致，请先重新预检再试运行');
  }
  if (preflightResult.verdict !== 'pass') {
    const codes = preflightResult.findings.filter(f => f.severity === 'error').map(f => f.code);
    throw new Error(`预检未通过（${codes.join('、')}），不能试运行`);
  }
  const runId = `dry-${randomUUID().slice(0, 8)}`;
  const impls = makeLocalImpls({ mode: 'dry', runId });
  const run = await runRecipe(recipe, impls, adapters, { mode: 'dry', runId, inputs });
  return {
    id: runId,
    ok: true,
    mode: 'dry',
    fingerprint: fp.fingerprint,
    steps: run.trace,
    withheld: run.withheld,
    scope: run.scope,
    note: '本次试运行只读本地资料源；带 dry 标记的令牌不得带入正式执行'
  };
}
