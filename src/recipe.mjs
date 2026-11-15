import { createHash } from 'node:crypto';

// 分析器版本：检查规则发生变化时递增，旧结论随之失效。
export const ANALYZER_VERSION = 'preflight-1';

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const asArray = value => (value == null ? [] : Array.isArray(value) ? value : [value]);

// 分支臂允许写单个步骤对象、步骤数组或空对象 {}（表示该臂没有步骤）。
const armSteps = raw => asArray(raw).filter(step => step && typeof step === 'object' && Object.keys(step).length > 0);

export function normalizeCondition(raw, where) {
  if (typeof raw === 'string' && raw) return { op: 'truthy', name: raw };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.has === 'string' && raw.has) return { op: 'has', name: raw.has };
    if (raw.not !== undefined) return { op: 'not', of: normalizeCondition(raw.not, where) };
    if (Array.isArray(raw.eq) && raw.eq.length === 2 && typeof raw.eq[0] === 'string') {
      return { op: 'eq', name: raw.eq[0], value: raw.eq[1] };
    }
    if (Array.isArray(raw.all)) return { op: 'all', items: raw.all.map(item => normalizeCondition(item, where)) };
    if (Array.isArray(raw.any)) return { op: 'any', items: raw.any.map(item => normalizeCondition(item, where)) };
  }
  throw new Error(`${where} 的条件写法无法识别`);
}

// 条件中必须“确定有值”的名字；has(x) 是守卫写法，不要求 x 已有值。
export function conditionReads(condition) {
  switch (condition.op) {
    case 'has': return [];
    case 'truthy':
    case 'eq': return [condition.name];
    case 'not': return conditionReads(condition.of);
    case 'all':
    case 'any': return condition.items.flatMap(conditionReads);
    default: return [];
  }
}

export function evalCondition(condition, get) {
  switch (condition.op) {
    case 'has': {
      const found = get(condition.name);
      return found.present && found.value != null;
    }
    case 'truthy': {
      const found = get(condition.name);
      if (!found.present) throw new Error(`条件读取的值 ${condition.name} 不存在（预检结论可能已过期）`);
      return Boolean(found.value);
    }
    case 'eq': {
      const found = get(condition.name);
      if (!found.present) throw new Error(`条件读取的值 ${condition.name} 不存在（预检结论可能已过期）`);
      return found.value === condition.value;
    }
    case 'not': return !evalCondition(condition.of, get);
    case 'all': return condition.items.every(item => evalCondition(item, get));
    case 'any': return condition.items.some(item => evalCondition(item, get));
    default: throw new Error('未知条件形态');
  }
}

// produces 支持三种写法：
//   "token"                       单个名字，类型取适配器输出
//   ["a", "b"]                    多个名字
//   {"token": "page-token", "warning?": "text"}   显式类型；名字带 ? 表示可选产出
function normalizeProduces(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') return [{ name: raw, type: null, optional: false }];
  if (Array.isArray(raw)) return raw.map(name => ({ name: String(name), type: null, optional: false }));
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([key, type]) => {
      const optional = key.endsWith('?');
      return { name: optional ? key.slice(0, -1) : key, type: typeof type === 'string' ? type : null, optional };
    });
  }
  return [];
}

function normalizeStep(raw, fallbackId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${fallbackId} 不是步骤对象`);
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
  if (raw.parallel !== undefined) {
    const forks = (Array.isArray(raw.parallel) ? raw.parallel : [raw.parallel]).map(armSteps);
    if (!forks.length || forks.some(fork => !fork.length)) throw new Error(`步骤 ${id} 的 parallel 需要至少一条非空分支`);
    return { kind: 'parallel', id, forks: forks.map((fork, i) => fork.map((step, j) => normalizeStep(step, `${id}#${i + 1}.${j + 1}`))) };
  }
  if (raw.repeat !== undefined) {
    const repeat = raw.repeat ?? {};
    const body = armSteps(repeat.body ?? raw.body).map((step, j) => normalizeStep(step, `${id}体${j + 1}`));
    if (!body.length) throw new Error(`步骤 ${id} 的循环体为空`);
    const hasTimes = Number.isInteger(repeat.times);
    const hasMax = Number.isInteger(repeat.max);
    return {
      kind: 'loop',
      id,
      max: hasTimes ? repeat.times : hasMax ? repeat.max : null,
      exact: hasTimes || (!repeat.while && hasMax),
      condition: repeat.while ? normalizeCondition(repeat.while, `步骤 ${id}`) : null,
      body
    };
  }
  if (raw.condition !== undefined || raw.then !== undefined || raw.otherwise !== undefined || raw.else !== undefined) {
    if (raw.condition === undefined) throw new Error(`步骤 ${id} 缺少 condition`);
    return {
      kind: 'branch',
      id,
      condition: normalizeCondition(raw.condition, `步骤 ${id}`),
      then: armSteps(raw.then).map((step, j) => normalizeStep(step, `${id}.then.${j + 1}`)),
      else: armSteps(raw.otherwise ?? raw.else).map((step, j) => normalizeStep(step, `${id}.otherwise.${j + 1}`))
    };
  }
  if (raw.adapter !== undefined || raw.produces !== undefined || raw.requires !== undefined || raw.input !== undefined) {
    return {
      kind: 'action',
      id,
      adapter: typeof raw.adapter === 'string' ? raw.adapter : null,
      input: typeof raw.input === 'string' ? raw.input : null,
      requires: asArray(raw.requires).filter(name => typeof name === 'string'),
      produces: normalizeProduces(raw.produces),
      pauseAfter: raw.pauseAfter === true
    };
  }
  throw new Error(`步骤 ${id} 无法识别（需要 adapter、condition、parallel 或 repeat 之一）`);
}

export function normalizeRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error('配方不是对象');
  if (typeof recipe.id !== 'string' || !recipe.id) throw new Error('配方缺少 id');
  if (!Array.isArray(recipe.steps) || !recipe.steps.length) throw new Error(`配方 ${recipe.id} 缺少 steps`);
  const inputs = {};
  for (const [name, spec] of Object.entries(recipe.inputs ?? {})) {
    inputs[name] = {
      source: spec?.source ?? 'human',
      optional: spec?.optional === true,
      description: spec?.description ?? ''
    };
  }
  return { id: recipe.id, inputs, steps: recipe.steps.map((step, i) => normalizeStep(step, `步骤${i + 1}`)) };
}

export function usedAdapters(norm) {
  const names = new Set();
  const visit = steps => {
    for (const step of steps) {
      if (step.kind === 'action' && step.adapter) names.add(step.adapter);
      else if (step.kind === 'branch') { visit(step.then); visit(step.else); }
      else if (step.kind === 'loop') visit(step.body);
      else if (step.kind === 'parallel') step.forks.forEach(visit);
    }
  };
  visit(norm.steps);
  return [...names].sort();
}

// 结论指纹：配方内容、实际用到的适配器能力、分析器版本三部分共同决定。
// 任何一部分变化，旧的预检/试运行结论都不得继续使用；都没变则结论仍然有效。
export function fingerprint(recipe, adapters) {
  const norm = normalizeRecipe(recipe);
  const used = usedAdapters(norm);
  const capabilities = {};
  for (const name of used) capabilities[name] = adapters?.[name] ?? null;
  const recipeHash = sha256(canonical(recipe));
  const adapterHash = sha256(canonical(capabilities));
  return {
    fingerprint: sha256(`${ANALYZER_VERSION}:${recipeHash}:${adapterHash}`),
    parts: { analyzer: ANALYZER_VERSION, recipeHash, adapterHash },
    used
  };
}
