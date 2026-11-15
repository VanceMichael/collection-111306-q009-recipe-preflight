import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight } from '../src/preflight.mjs';
import { dryRun } from '../src/dryrun.mjs';
import { executeFormal, explainStale } from '../src/execute.mjs';
import { fingerprint } from '../src/recipe.mjs';
import { CaptureStore } from '../src/store.mjs';

const data = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url))).data;
const good = data.recipes.find(recipe => recipe.id === 'paged-collect');
const inputs = { seed: 'seed-1', label: '批次A' };

async function ready(recipe = good, adapters = data.adapters) {
  const verdict = preflight(recipe, adapters);
  assert.equal(verdict.verdict, 'pass');
  const dry = await dryRun(recipe, adapters, verdict, inputs);
  return { verdict, dry };
}

test('通过预检与试运行后正式领取走完并留痕', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execute-'));
  try {
    const store = new CaptureStore(join(root, 'captures.json'));
    const { verdict, dry } = await ready();
    const run = await executeFormal({ recipe: good, adapters: data.adapters, preflightResult: verdict, dryReport: dry, inputs, store });
    assert.equal(run.scope.page, 'page-3');
    assert.match(run.receipt, /^rcpt-/);
    assert.ok(!JSON.stringify(run.scope).includes('dry:'), '正式执行的结果里不应出现试运行标记');
    const state = await store.read();
    const record = state.records.at(-1);
    assert.equal(record.kind, 'recipe-run');
    assert.equal(record.fingerprint, verdict.fingerprint);
    assert.equal(record.receipt, run.receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('配方变更后旧结论失效，并说明是配方内容变了', async () => {
  const { verdict, dry } = await ready();
  const changed = structuredClone(good);
  changed.steps[1].repeat.max = 9;
  await assert.rejects(
    executeFormal({ recipe: changed, adapters: data.adapters, preflightResult: verdict, dryReport: dry, inputs }),
    /配方内容已变更/
  );
});

test('适配器能力变更后旧结论失效，并说明是能力变了', async () => {
  const { verdict, dry } = await ready();
  const changedAdapters = structuredClone(data.adapters);
  changedAdapters.fetch.replayable = false;
  await assert.rejects(
    executeFormal({ recipe: good, adapters: changedAdapters, preflightResult: verdict, dryReport: dry, inputs }),
    /适配器能力已变更/
  );
});

test('内容未变化时旧结论仍然可用', async () => {
  const { verdict, dry } = await ready();
  const run = await executeFormal({ recipe: structuredClone(good), adapters: structuredClone(data.adapters), preflightResult: verdict, dryReport: dry, inputs });
  assert.match(run.receipt, /^rcpt-/);
});

test('试运行令牌不得带进正式执行', async () => {
  const { verdict, dry } = await ready();
  await assert.rejects(
    executeFormal({ recipe: good, adapters: data.adapters, preflightResult: verdict, dryReport: dry, inputs: { seed: `dry:${dry.id}:tok-2` } }),
    /试运行/
  );
});

test('缺少必填人工输入时拒绝领取', async () => {
  const { verdict, dry } = await ready();
  await assert.rejects(
    executeFormal({ recipe: good, adapters: data.adapters, preflightResult: verdict, dryReport: dry, inputs: {} }),
    /缺少人工输入 seed/
  );
});

test('explainStale 逐项说明失效依据', () => {
  const current = fingerprint(good, data.adapters).parts;
  assert.deepEqual(explainStale(current, current), []);
  assert.deepEqual(explainStale(undefined, current), ['没有可对照的旧结论']);
  assert.deepEqual(explainStale({ ...current, analyzer: 'preflight-0' }, current), ['分析器版本已升级']);
});
