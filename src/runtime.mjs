import { normalizeRecipe, evalCondition } from './recipe.mjs';

// 共享解释器：试运行与正式领取走同一份步骤语义，区别只在模式与适配器实现。
// mode 'dry'：写能力步骤一律跳过（withheld），产物带 dry 来源标记。
// mode 'real'：要求输入干净（不带试运行令牌），写能力步骤真正执行。
export async function runRecipe(recipe, impls, adapters, opts) {
  const { mode, runId, inputs = {}, confirmPause } = opts;
  const norm = normalizeRecipe(recipe);
  const trace = [];
  const withheld = [];
  const scope = new Map();
  for (const [name, spec] of Object.entries(norm.inputs)) {
    const provided = inputs[name];
    if (provided === undefined || provided === null) {
      if (!spec.optional) throw new Error(`缺少人工输入 ${name}${spec.description ? `（${spec.description}）` : ''}，正式领取前必须由人工提供`);
      continue;
    }
    if (mode === 'real' && typeof provided === 'string' && provided.startsWith('dry:')) {
      throw new Error(`人工输入 ${name} 的值 ${provided} 带有试运行标记：试运行拿到的临时令牌不得带进正式执行，请重新采集`);
    }
    scope.set(name, { value: provided, origin: { kind: 'human', run: runId } });
  }
  const ctx = { impls, adapters, mode, runId, trace, withheld, scope, confirmPause };
  await execSteps(norm.steps, ctx);
  return {
    ok: true,
    runId,
    mode,
    trace,
    withheld,
    scope: Object.fromEntries([...scope].map(([name, entry]) => [name, entry.value]))
  };
}

async function execSteps(steps, ctx) {
  for (const step of steps) {
    if (step.kind === 'action') {
      await execAction(step, ctx);
    } else if (step.kind === 'branch') {
      const taken = evalCondition(step.condition, name => {
        const entry = ctx.scope.get(name);
        return { present: Boolean(entry), value: entry?.value };
      });
      ctx.trace.push({ type: 'branch', step: step.id, taken: taken ? 'then' : 'otherwise' });
      await execSteps(taken ? step.then : step.else, ctx);
    } else if (step.kind === 'loop') {
      if (!Number.isInteger(step.max) || step.max < 1) throw new Error(`重复步骤 ${step.id} 没有有效上界，拒绝执行（预检结论可能已过期）`);
      let count = 0;
      while (count < step.max) {
        if (step.condition) {
          const go = evalCondition(step.condition, name => {
            const entry = ctx.scope.get(name);
            return { present: Boolean(entry), value: entry?.value };
          });
          if (!go) break;
        }
        count += 1;
        ctx.trace.push({ type: 'iteration', step: step.id, count, max: step.max });
        await execSteps(step.body, ctx);
      }
      if (step.condition && count === step.max) {
        const still = evalCondition(step.condition, name => {
          const entry = ctx.scope.get(name);
          return { present: Boolean(entry), value: entry?.value };
        });
        if (still) throw new Error(`重复步骤 ${step.id} 达到上界 ${step.max} 次后条件仍成立，已中止；请检查上界或翻页来源`);
      }
    } else if (step.kind === 'parallel') {
      // 各支从同一状态副本出发并发执行，汇合时按名字合并产物。
      const results = await Promise.all(step.forks.map(async fork => {
        const subCtx = { ...ctx, scope: new Map(ctx.scope) };
        await execSteps(fork, subCtx);
        return subCtx.scope;
      }));
      for (const sub of results) {
        for (const [name, entry] of sub) {
          const current = ctx.scope.get(name);
          if (current && current.origin !== entry.origin && JSON.stringify(current.value) !== JSON.stringify(entry.value)) {
            throw new Error(`并行步骤汇合时 ${name} 出现冲突产物（预检结论可能已过期）`);
          }
          ctx.scope.set(name, entry);
        }
      }
      ctx.trace.push({ type: 'join', step: step.id });
    }
  }
}

async function execAction(step, ctx) {
  const capability = step.adapter ? ctx.adapters?.[step.adapter] : null;
  if (step.adapter && !capability) throw new Error(`步骤 ${step.id} 的适配器 ${step.adapter} 未登记`);
  if (step.adapter && !ctx.impls[step.adapter]) throw new Error(`步骤 ${step.id} 的适配器 ${step.adapter} 没有本地实现`);
  for (const name of [step.input, ...step.requires].filter(Boolean)) {
    if (!ctx.scope.has(name)) throw new Error(`步骤 ${step.id} 需要 ${name}，但当前没有值（预检结论可能已过期）`);
  }
  if (capability?.effect === 'write' && ctx.mode === 'dry') {
    ctx.withheld.push(step.id);
    ctx.trace.push({ type: 'withheld', step: step.id, adapter: step.adapter, reason: '试运行不触发对外写入' });
    for (const produced of step.produces) {
      ctx.scope.set(produced.name, { value: `withheld:${ctx.runId}:${step.id}:${produced.name}`, origin: { kind: 'withheld', run: ctx.runId, step: step.id } });
    }
    return;
  }
  const args = {
    step: step.id,
    mode: ctx.mode,
    runId: ctx.runId,
    input: step.input ? ctx.scope.get(step.input)?.value : undefined,
    values: Object.fromEntries(step.requires.map(name => [name, ctx.scope.get(name)?.value])),
    produces: step.produces.map(produced => produced.name)
  };
  const output = step.adapter ? await ctx.impls[step.adapter](args) : {};
  for (const produced of step.produces) {
    let value = output ? output[produced.name] : undefined;
    if (value === undefined) value = `${ctx.runId}:${step.id}:${produced.name}`;
    ctx.scope.set(produced.name, { value, origin: { kind: ctx.mode === 'dry' ? 'dry' : 'real', run: ctx.runId, step: step.id } });
  }
  ctx.trace.push({ type: 'step', step: step.id, adapter: step.adapter, produced: step.produces.map(produced => produced.name) });
  if (step.pauseAfter) {
    ctx.trace.push({ type: 'pause', step: step.id });
    if (ctx.confirmPause && !(await ctx.confirmPause(step.id))) throw new Error(`步骤 ${step.id} 之后的人工暂停未确认，已中止`);
  }
}
