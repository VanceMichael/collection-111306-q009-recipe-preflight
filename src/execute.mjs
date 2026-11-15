import { randomUUID } from 'node:crypto';
import { fingerprint } from './recipe.mjs';
import { runRecipe } from './runtime.mjs';
import { makeLocalImpls } from './localdata.mjs';

// 旧结论是否还能用的明确依据：配方内容、适配器能力、分析器版本三部分逐一比对。
export function explainStale(savedParts, currentParts) {
  if (!savedParts) return ['没有可对照的旧结论'];
  const reasons = [];
  if (savedParts.recipeHash !== currentParts.recipeHash) reasons.push('配方内容已变更');
  if (savedParts.adapterHash !== currentParts.adapterHash) reasons.push('适配器能力已变更');
  if (savedParts.analyzer !== currentParts.analyzer) reasons.push('分析器版本已升级');
  return reasons;
}

// 正式领取：要求预检与试运行结论都与当前配方、适配器能力、分析器版本一致。
export async function executeFormal({ recipe, adapters, preflightResult, dryReport, inputs = {}, store }) {
  const fp = fingerprint(recipe, adapters);
  const stale = preflightResult?.fingerprint === fp.fingerprint ? [] : explainStale(preflightResult?.parts, fp.parts);
  if (stale.length) throw new Error(`旧预检结论失效（${stale.join('；')}），需重新预检后再领取`);
  if (preflightResult.verdict !== 'pass') throw new Error('预检未通过，不能正式领取');
  if (!dryReport || dryReport.ok !== true || dryReport.fingerprint !== fp.fingerprint) {
    throw new Error('试运行结论不可用（缺失或与当前配方不一致），需重新试运行');
  }
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const impls = makeLocalImpls({ mode: 'real', runId });
  const run = await runRecipe(recipe, impls, adapters, { mode: 'real', runId, inputs });
  const receipt = run.scope.receipt ?? null;
  if (store) {
    await store.append({
      kind: 'recipe-run',
      runId,
      recipe: recipe.id,
      fingerprint: fp.fingerprint,
      steps: run.trace.length,
      receipt,
      at: new Date().toISOString()
    });
  }
  return { runId, fingerprint: fp.fingerprint, trace: run.trace, receipt, scope: run.scope };
}
