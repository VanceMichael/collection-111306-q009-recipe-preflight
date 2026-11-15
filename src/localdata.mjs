import { readFile } from 'node:fs/promises';

// 本地资料源：试运行与正式领取都只能从这里取数。
// 试运行模式下产出的令牌带 dry:<runId>: 前缀，正式模式拒绝接收这种令牌，
// 从机制上保证试运行的临时令牌不会被带进正式执行。
const dataset = JSON.parse(await readFile(new URL('../fixtures/pages.json', import.meta.url)));

export function makeLocalImpls({ mode, runId }) {
  const wrap = token => (token == null ? null : mode === 'dry' ? `dry:${runId}:${token}` : token);
  const unwrap = token => {
    const text = String(token);
    if (mode === 'real' && text.startsWith('dry:')) {
      throw new Error(`试运行令牌不得进入正式执行：${text}`);
    }
    const prefix = `dry:${runId}:`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  };
  return {
    fetch: async ({ input }) => {
      const key = unwrap(input);
      const page = dataset.pages[key];
      if (!page) throw new Error(`本地资料源没有与 ${key} 对应的页`);
      return { page: page.page, token: wrap(page.next) };
    },
    lookup: async ({ input, produces }) => ({
      [produces[0] ?? 'record']: `record(${String(input)})`
    }),
    submit: async ({ step, runId: id }) => ({
      receipt: `rcpt-${id}-${step}`
    })
  };
}
