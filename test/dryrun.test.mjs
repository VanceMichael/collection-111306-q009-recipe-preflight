import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preflight } from '../src/preflight.mjs';
import { dryRun } from '../src/dryrun.mjs';

const data = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url))).data;
const byId = id => data.recipes.find(recipe => recipe.id === id);
const good = byId('paged-collect');

test('试运行只用本地资料源完成翻页，写能力步骤被跳过', async () => {
  const verdict = preflight(good, data.adapters);
  const dry = await dryRun(good, data.adapters, verdict, { seed: 'seed-1', label: '批次A' });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.withheld, ['ship'], '写能力步骤应被跳过而不是执行');
  assert.equal(dry.scope.page, 'page-3');
  assert.match(String(dry.scope.receipt), /^withheld:/, '回执只能是占位值，说明 submit 适配器从未被调用');
  const iterations = dry.steps.filter(event => event.type === 'iteration');
  assert.ok(iterations.length > 0 && iterations.every(event => event.count <= event.max), '每次重复都在上界内');
});

test('预检未通过的配方不能试运行', async () => {
  const bad = byId('missing-branch');
  const verdict = preflight(bad, data.adapters);
  assert.equal(verdict.verdict, 'fail');
  await assert.rejects(dryRun(bad, data.adapters, verdict, { hasMore: true }), /预检未通过/);
});

test('配方变更后旧预检结论不能用于试运行', async () => {
  const verdict = preflight(good, data.adapters);
  const changed = structuredClone(good);
  changed.steps[1].repeat.max = 9;
  await assert.rejects(dryRun(changed, data.adapters, verdict, { seed: 'seed-1' }), /不一致/);
});

test('试运行在运行时同样强制重复上界', async () => {
  const tight = structuredClone(good);
  tight.steps[1].repeat.max = 1;
  const verdict = preflight(tight, data.adapters);
  assert.equal(verdict.verdict, 'pass');
  await assert.rejects(dryRun(tight, data.adapters, verdict, { seed: 'seed-1' }), /上界/);
});
