import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preflight } from '../src/preflight.mjs';
import { fingerprint } from '../src/recipe.mjs';

const data = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url))).data;
const byId = id => data.recipes.find(recipe => recipe.id === id);

test('分支遗漏：只有一条分支产生必需值时指出缺失路径与改法', () => {
  const result = preflight(byId('missing-branch'), data.adapters);
  assert.equal(result.verdict, 'fail');
  const finding = result.findings.find(item => item.code === 'maybe-value');
  assert.ok(finding, '应指出 token 只是可能可用');
  assert.match(finding.message, /token/);
  assert.match(finding.message, /branch\.otherwise/);
  assert.match(finding.message, /make-token/);
  assert.match(finding.fix, /otherwise|has/);
  const bad = result.paths.find(path => !path.ok);
  assert.ok(bad.label.includes('branch.otherwise'));
  const good = result.paths.find(path => path.ok);
  assert.ok(good.label.includes('branch.then'));
});

test('并行汇合：两支产物类型不兼容被拒绝', () => {
  const result = preflight(byId('parallel-mismatch'), data.adapters);
  assert.equal(result.verdict, 'fail');
  const finding = result.findings.find(item => item.code === 'parallel-type-mismatch');
  assert.ok(finding, '应指出并行产物类型冲突');
  assert.match(finding.message, /result/);
  assert.match(finding.message, /page/);
  assert.match(finding.message, /record/);
});

test('有界重复：缺少上界的翻页被拒绝并给出补法', () => {
  const result = preflight(byId('unbounded-repeat'), data.adapters);
  assert.equal(result.verdict, 'fail');
  const finding = result.findings.find(item => item.code === 'unbounded-repeat');
  assert.ok(finding, '应指出重复步骤没有上界');
  assert.match(finding.fix, /max/);
});

test('完整配方通过预检，写能力步骤标注为提示', () => {
  const result = preflight(byId('paged-collect'), data.adapters);
  assert.equal(result.verdict, 'pass', JSON.stringify(result.findings, null, 2));
  assert.ok(result.findings.some(item => item.code === 'external-action' && item.severity === 'info'));
  assert.ok(result.paths.length >= 2, '分支两臂都应列为可达路径');
  assert.ok(result.paths.every(path => path.ok));
});

test('可选人工值不能默认已有，补充 has 守卫后通过', () => {
  const recipe = {
    id: 'opt',
    inputs: { note: { source: 'human', optional: true } },
    steps: [{ id: 'use', adapter: 'fetch', input: 'note', produces: { out: 'page' } }]
  };
  const unguarded = preflight(recipe, data.adapters);
  assert.equal(unguarded.verdict, 'fail');
  assert.equal(unguarded.findings[0].code, 'maybe-value');
  const guarded = {
    ...recipe,
    steps: [{
      id: 'gate',
      condition: { has: 'note' },
      then: [{ id: 'use', adapter: 'fetch', input: 'note', produces: { out: 'page' } }],
      otherwise: []
    }]
  };
  assert.equal(preflight(guarded, data.adapters).verdict, 'pass');
});

test('循环内后续步骤产生的值不能供首次迭代使用', () => {
  const recipe = {
    id: 'carry',
    steps: [{
      id: 'loop',
      repeat: { while: 'token', max: 3 },
      body: [{ id: 'next', adapter: 'fetch', input: 'token', produces: { token: 'page-token' } }]
    }]
  };
  const result = preflight(recipe, data.adapters);
  assert.equal(result.verdict, 'fail');
  const codes = result.findings.map(item => item.code);
  assert.ok(codes.includes('condition-unknown'), '循环条件读的 token 没有来源');
  const missing = result.findings.find(item => item.code === 'missing-source');
  assert.ok(missing, '循环体首次迭代的 token 没有来源');
  assert.match(missing.message, /首次迭代/);
});

test('不可重放的适配器不能出现在重复步骤内', () => {
  const recipe = {
    id: 'noreplay',
    inputs: { seed: { source: 'human' } },
    steps: [{
      id: 'loop',
      repeat: { times: 2 },
      body: [{ id: 'once', adapter: 'lookup', input: 'seed', produces: { r: 'record' } }]
    }]
  };
  const result = preflight(recipe, data.adapters);
  assert.ok(result.findings.some(item => item.code === 'capability-replayable'));
});

test('暂停点要求适配器支持暂停', () => {
  const recipe = {
    id: 'pause',
    inputs: { seed: { source: 'human' } },
    steps: [{ id: 'w', adapter: 'submit', input: 'seed', pauseAfter: true, produces: { rc: 'receipt' } }]
  };
  const result = preflight(recipe, data.adapters);
  assert.ok(result.findings.some(item => item.code === 'capability-pausable'));
});

test('条件不能读取没有来源的值', () => {
  const recipe = { id: 'cond', steps: [{ id: 'b', condition: 'ghost', then: [], otherwise: [] }] };
  const result = preflight(recipe, data.adapters);
  assert.ok(result.findings.some(item => item.code === 'condition-unknown'));
});

test('并行分支之间不能互相领取产物', () => {
  const recipe = {
    id: 'cross',
    inputs: { seed: { source: 'human' } },
    steps: [{
      id: 'fork',
      parallel: [
        [{ id: 'a', adapter: 'fetch', input: 'seed', produces: { av: 'page' } }],
        [{ id: 'b', adapter: 'fetch', input: 'av', produces: { bv: 'page' } }]
      ]
    }]
  };
  const result = preflight(recipe, data.adapters);
  assert.ok(result.findings.some(item => item.code === 'missing-source' && item.step === 'b'));
});

test('结论指纹：内容不变则结论可用，配方或适配器变化则失效', () => {
  const first = fingerprint(byId('paged-collect'), data.adapters);
  const again = fingerprint(byId('paged-collect'), data.adapters);
  assert.equal(first.fingerprint, again.fingerprint);
  const changedRecipe = structuredClone(byId('paged-collect'));
  changedRecipe.steps[1].repeat.max = 9;
  assert.notEqual(fingerprint(changedRecipe, data.adapters).parts.recipeHash, first.parts.recipeHash);
  const changedAdapters = structuredClone(data.adapters);
  changedAdapters.fetch.replayable = false;
  assert.notEqual(fingerprint(byId('paged-collect'), changedAdapters).parts.adapterHash, first.parts.adapterHash);
});
