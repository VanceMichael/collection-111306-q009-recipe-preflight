import { normalizeRecipe, fingerprint, conditionReads } from './recipe.mjs';

// 值的状态：certain 表示这条路径上一定有来源；missingIn 记录它在哪些分支臂上没有来源。
const cloneValues = values => new Map([...values].map(([name, v]) => [name, { ...v, missingIn: [...v.missingIn] }]));

const isArmSegment = segment => /\.(then|otherwise)$/.test(segment);
const isContainerSegment = segment => segment.includes('(重复') || segment.includes('(并行');

// 静态产物索引：值名 -> 产生位置列表，用于解释“它到底在哪里产生”。
function buildProducers(norm) {
  const map = new Map();
  const visit = (steps, where, loopId) => {
    for (const step of steps) {
      if (step.kind === 'action') {
        for (const produced of step.produces) {
          if (!map.has(produced.name)) map.set(produced.name, []);
          map.get(produced.name).push({ step: step.id, where: `${where}步骤 ${step.id}`, loop: loopId });
        }
      } else if (step.kind === 'branch') {
        visit(step.then, `${where}分支 ${step.id} 的 then 内`, loopId);
        visit(step.else, `${where}分支 ${step.id} 的 otherwise 内`, loopId);
      } else if (step.kind === 'loop') {
        visit(step.body, `${where}循环 ${step.id} 内`, step.id);
      } else if (step.kind === 'parallel') {
        step.forks.forEach((fork, i) => visit(fork, `${where}并行 ${step.id} 第${i + 1}支`, loopId));
      }
    }
  };
  visit(norm.steps, '', null);
  return map;
}

export function preflight(recipe, adapters) {
  let norm;
  try {
    norm = normalizeRecipe(recipe);
  } catch (error) {
    return {
      recipe: recipe?.id ?? '?',
      verdict: 'fail',
      findings: [{
        code: 'recipe-invalid', severity: 'error', step: null, segments: [], path: '',
        message: `配方结构无法识别：${error.message}`,
        fix: '对照 docs/preflight.md 的配方格式修正步骤写法'
      }],
      paths: [], fingerprint: null, parts: null, adaptersUsed: []
    };
  }
  const fp = fingerprint(recipe, adapters);
  const findings = [];
  const producers = buildProducers(norm);
  const add = finding => findings.push({ severity: 'error', ...finding });

  const need = (state, step, segments, name, ctx) => {
    const value = state.values.get(name);
    if (value && value.certain) return;
    if (value && value.type === '冲突') return; // 汇合冲突已单独报告，不再级联
    const path = segments.join(' → ');
    const produced = producers.get(name) ?? [];
    if (!value) {
      const inLoop = produced.some(entry => entry.loop && entry.loop === ctx.loopId);
      add({
        code: 'missing-source', step: step.id, segments, path,
        message: `步骤 ${step.id} 需要值 ${name}，但走到这里时它没有任何来源` +
          (produced.length ? `；它在 ${produced.map(entry => entry.where).join('、')} 产生，当前路径不经过这些位置` : '；配方中没有任何步骤或人工输入提供它') +
          (inLoop ? `；注意 ${name} 由同一循环内的后续步骤产生，首次迭代时还不存在` : ''),
        fix: produced.length
          ? `让 ${name} 在到达 ${step.id} 的每条路径上都有来源：在其它分支补齐产生步骤，或把 ${step.id} 移到已有来源的路径内`
          : `补充一个产生 ${name} 的步骤，或在配方 inputs 中声明由人工提供`,
        producers: produced.map(entry => entry.where)
      });
      return;
    }
    const arms = value.missingIn.filter(isArmSegment);
    add({
      code: 'maybe-value', step: step.id, segments, path, affectedArms: arms.length ? arms : null,
      message: `步骤 ${step.id} 需要值 ${name}，但它只是可能可用（${value.missingIn.join('；') || '来源不确定'}），不能默认它已有值` +
        (produced.length ? `；它只在 ${produced.map(entry => entry.where).join('、')} 产生` : ''),
      fix: `在 ${name} 没有来源的分支补齐产生步骤，或把 ${step.id} 放进 "condition": {"has": "${name}"} 守卫的分支里，或把对应人工输入改为必选`,
      producers: produced.map(entry => entry.where)
    });
  };

  const checkCondition = (condition, state, step, segments) => {
    for (const name of conditionReads(condition)) {
      const value = state.values.get(name);
      const path = segments.join(' → ');
      if (!value) {
        add({
          code: 'condition-unknown', step: step.id, segments, path,
          message: `步骤 ${step.id} 的条件读不到 ${name}：它没有任何来源`,
          fix: `先让上游步骤产生 ${name}，或在 inputs 中声明由人工提供；如果只是想判断它是否存在，改用 {"has": "${name}"}`
        });
      } else if (!value.certain) {
        add({
          code: 'condition-maybe', step: step.id, segments, path,
          message: `步骤 ${step.id} 的条件依赖可能不存在的 ${name}（${value.missingIn.join('；')}），不能默认它已有值`,
          fix: `把条件改成 {"has": "${name}"} 明确判断存在性，或让上游在所有路径都产生 ${name}`
        });
      }
    }
  };

  const walkAction = (step, state, segments, ctx) => {
    const at = [...segments, step.id];
    const capability = step.adapter ? adapters?.[step.adapter] : null;
    if (step.adapter && !capability) {
      add({
        code: 'adapter-unknown', step: step.id, segments: at, path: at.join(' → '),
        message: `步骤 ${step.id} 引用了未登记的适配器 ${step.adapter}`,
        fix: `在适配器清单中登记 ${step.adapter} 的能力（output/replayable/pausable/effect），或改用已登记的适配器`
      });
    }
    if (capability && ctx.loopId && capability.replayable !== true) {
      add({
        code: 'capability-replayable', step: step.id, segments: at, path: at.join(' → '),
        message: `步骤 ${step.id} 在重复步骤 ${ctx.loopId} 内会被多次执行，但适配器 ${step.adapter} 声明为不可重放`,
        fix: `改用可重放的适配器，或把 ${step.id} 移出循环 ${ctx.loopId}`
      });
    }
    if (capability && step.pauseAfter && capability.pausable !== true) {
      add({
        code: 'capability-pausable', step: step.id, segments: at, path: at.join(' → '),
        message: `步骤 ${step.id} 要求执行后暂停（pauseAfter），但适配器 ${step.adapter} 不支持暂停`,
        fix: `去掉 ${step.id} 的 pauseAfter，或改用声明 pausable 的适配器`
      });
    }
    if (capability && capability.effect === 'write') {
      findings.push({
        code: 'external-action', severity: 'info', step: step.id, segments: at, path: at.join(' → '),
        message: `步骤 ${step.id} 使用写能力适配器 ${step.adapter}：试运行会跳过它，正式领取时才真正触发对外动作`,
        fix: null
      });
    }
    for (const name of [step.input, ...step.requires].filter(Boolean)) need(state, step, at, name, ctx);
    for (const produced of step.produces) {
      state.values.set(produced.name, {
        type: produced.type ?? capability?.output ?? 'unknown',
        certain: !produced.optional,
        origin: step.id,
        missingIn: produced.optional ? [`步骤 ${step.id} 可能不产生它`] : []
      });
    }
  };

  const walkBranch = (step, state, segments, ctx) => {
    const at = [...segments, step.id];
    checkCondition(step.condition, state, step, at);
    const thenSeg = `${step.id}.then`;
    const elseSeg = `${step.id}.otherwise`;
    const thenState = { values: cloneValues(state.values) };
    // has(x) 守卫：then 臂内 x 视为确定存在——这是“补充条件”的正式写法。
    if (step.condition.op === 'has') {
      const guarded = thenState.values.get(step.condition.name);
      if (guarded) thenState.values.set(step.condition.name, { ...guarded, certain: true, missingIn: [] });
    }
    walkSteps(step.then, thenState, [...segments, thenSeg], ctx);
    const elseState = { values: cloneValues(state.values) };
    walkSteps(step.else, elseState, [...segments, elseSeg], ctx);
    // 汇合：两臂都确定才有确定值；只在一臂出现的值降级为“可能可用”并记录缺失臂。
    const merged = new Map();
    for (const name of new Set([...thenState.values.keys(), ...elseState.values.keys()])) {
      const a = thenState.values.get(name);
      const b = elseState.values.get(name);
      if (a && b) {
        if (a.certain && b.certain) {
          if (a.type !== b.type) {
            add({
              code: 'branch-type-mismatch', step: step.id, segments: at, path: at.join(' → '),
              message: `分支 ${step.id} 汇合后 ${name} 的类型不一致（then 臂 ${a.type}，otherwise 臂 ${b.type}）`,
              fix: `统一两个分支的产物类型，或给不同产物起不同的名字`
            });
          }
          merged.set(name, { ...a, missingIn: a.missingIn.filter(item => b.missingIn.includes(item)) });
        } else {
          merged.set(name, { ...a, certain: false, missingIn: [...new Set([...a.missingIn, ...b.missingIn])] });
        }
      } else if (a) {
        merged.set(name, { ...a, certain: false, missingIn: [...a.missingIn, elseSeg] });
      } else {
        merged.set(name, { ...b, certain: false, missingIn: [...b.missingIn, thenSeg] });
      }
    }
    state.values = merged;
  };

  const walkLoop = (step, state, segments, ctx) => {
    const seg = step.exact ? `${step.id}(重复${step.max}次)` : `${step.id}(重复0..${step.max ?? '?'}次)`;
    const at = [...segments, seg];
    if (!Number.isInteger(step.max) || step.max < 1) {
      add({
        code: 'unbounded-repeat', step: step.id, segments: at, path: at.join(' → '),
        message: `重复步骤 ${step.id} 没有明确上界，翻页可能无限进行`,
        fix: `为 ${step.id} 的 repeat 增加 "max": 最大次数（固定次数用 "times": 次数）`
      });
    }
    if (step.condition) checkCondition(step.condition, state, step, at);
    const bodyState = { values: cloneValues(state.values) };
    walkSteps(step.body, bodyState, at, { ...ctx, loopId: step.id });
    for (const [name, value] of bodyState.values) {
      const before = state.values.get(name);
      if (step.exact) {
        state.values.set(name, value);
      } else if (before && before.certain) {
        // 循环执行 0 次时原值仍在，确定值保持确定。
      } else if (!before || before.origin !== value.origin || before.type !== value.type) {
        state.values.set(name, { ...value, certain: false, missingIn: [...value.missingIn, `循环 ${step.id} 可能执行 0 次`] });
      }
    }
  };

  const walkParallel = (step, state, segments, ctx) => {
    const seg = `${step.id}(并行${step.forks.length}支)`;
    const at = [...segments, seg];
    const forkStates = step.forks.map((fork, i) => {
      const forkState = { values: cloneValues(state.values) };
      walkSteps(fork, forkState, [...at, `第${i + 1}支`], ctx);
      return forkState;
    });
    // 汇合：每支从同一状态出发（支与支之间不能互相领取），产物按名字合并。
    const producedBy = new Map();
    forkStates.forEach((forkState, i) => {
      for (const [name, value] of forkState.values) {
        const before = state.values.get(name);
        if (!before || before.origin !== value.origin) {
          if (!producedBy.has(name)) producedBy.set(name, []);
          producedBy.get(name).push({ value, fork: i + 1 });
        }
      }
    });
    for (const [name, list] of producedBy) {
      if (list.length > 1) {
        const types = [...new Set(list.map(entry => entry.value.type))];
        const conflict = types.length > 1;
        add({
          code: conflict ? 'parallel-type-mismatch' : 'parallel-duplicate',
          step: step.id, segments: at, path: at.join(' → '),
          message: conflict
            ? `并行步骤 ${step.id} 的多支都产生 ${name}，但类型不一致（${types.join(' 与 ')}），汇合时无法确定取哪一个`
            : `并行步骤 ${step.id} 的第 ${list.map(entry => entry.fork).join('、')} 支都产生同名值 ${name}，汇合结果不确定`,
          fix: `给各分支的产物起不同的名字，或统一各适配器的输出类型`
        });
        state.values.set(name, { type: '冲突', certain: false, origin: step.id, missingIn: ['并行产物冲突'] });
      } else {
        state.values.set(name, list[0].value);
      }
    }
  };

  function walkSteps(steps, state, segments, ctx) {
    for (const step of steps) {
      if (step.kind === 'action') walkAction(step, state, segments, ctx);
      else if (step.kind === 'branch') walkBranch(step, state, segments, ctx);
      else if (step.kind === 'loop') walkLoop(step, state, segments, ctx);
      else if (step.kind === 'parallel') walkParallel(step, state, segments, ctx);
    }
  }

  const initial = new Map();
  for (const [name, spec] of Object.entries(norm.inputs)) {
    initial.set(name, {
      type: 'input', certain: !spec.optional, origin: '人工输入',
      missingIn: spec.optional ? [`人工输入 ${name} 可选，可能未提供`] : []
    });
  }
  walkSteps(norm.steps, { values: initial }, [], { loopId: null });

  // 可达路径清单（按分支臂展开；循环与并行各算一段），并标注每条路径的结论。
  const paths = enumeratePaths(norm).map(segments => {
    const problems = findings.filter(finding => finding.severity === 'error' && attached(finding, segments));
    return {
      segments,
      label: segments.join(' → '),
      ok: problems.length === 0,
      problems: problems.map(finding => finding.code)
    };
  });
  return {
    recipe: norm.id,
    verdict: findings.some(finding => finding.severity === 'error') ? 'fail' : 'pass',
    findings,
    paths,
    fingerprint: fp.fingerprint,
    parts: fp.parts,
    adaptersUsed: fp.used
  };
}

function enumeratePaths(norm) {
  let routes = [[]];
  const walk = steps => {
    for (const step of steps) {
      const next = [];
      for (const route of routes) {
        if (step.kind === 'branch') {
          const save = routes;
          routes = [[...route, `${step.id}.then`]];
          walk(step.then);
          const thenRoutes = routes;
          routes = [[...route, `${step.id}.otherwise`]];
          walk(step.else);
          next.push(...thenRoutes, ...routes);
          routes = save;
        } else if (step.kind === 'loop') {
          next.push([...route, step.exact ? `${step.id}(重复${step.max}次)` : `${step.id}(重复0..${step.max ?? '?'}次)`]);
        } else if (step.kind === 'parallel') {
          next.push([...route, `${step.id}(并行${step.forks.length}支)`]);
        } else {
          next.push([...route, step.id]);
        }
      }
      routes = next.slice(0, 64);
    }
  };
  walk(norm.steps);
  return routes;
}

// 判断某个检查发现是否影响某条路径。
// 发现的段序列里：循环/并行段是结构锚点，必须按顺序出现在路径中；
// 容器段之后的步骤名是容器内部细节（路径里不展开），不参与匹配；
// 分支臂段必须与路径一致，受影响臂（affectedArms）至少其一在路径中。
function attached(finding, pathSegments) {
  const firstContainer = finding.segments.findIndex(isContainerSegment);
  const before = firstContainer === -1 ? finding.segments : finding.segments.slice(0, firstContainer);
  const anchors = firstContainer === -1
    ? finding.segments
    : [...before.filter(segment => !isArmSegment(segment)), ...finding.segments.slice(firstContainer).filter(isContainerSegment)];
  let at = 0;
  for (const segment of pathSegments) {
    if (segment === anchors[at]) at += 1;
    if (at === anchors.length) break;
  }
  if (at < anchors.length) return false;
  if (!before.filter(isArmSegment).every(arm => pathSegments.includes(arm))) return false;
  if (finding.affectedArms && !finding.affectedArms.some(arm => pathSegments.includes(arm))) return false;
  return true;
}
