#!/usr/bin/env node
/**
 * dsh-solpi-action-fusion 冒烟脚本。
 *
 * 不依赖 DSH 宿主：用最小的 cordis 假件（服务注册、effect、事件）把插件跑一遍，
 * 检查四件事——
 *   1. 模块能加载，导出形状正确（name / SETTINGS_NS / Config / apply）；
 *   2. 六个旋钮都带 volatile 标记（宿主读的就是 `schema.meta.volatile`），
 *      并且在支持活引用的 schemastery（≥3.18.3）上，校验结果确实是活引用；
 *   3. `apply()` 之后融合工具与系统提示引导都注册成功，工具定义符合契约
 *      （原始 JSON Schema 的 parameters / output、可选的 isConcurrencySafe）；
 *   4. 工具执行时按「先 edit 后命令」派发内建工具，并带上嵌套派发约定的
 *      `rootCallId` / `parent`；编辑失败且要求先成功时，命令不执行。
 *
 * 另外验证热改路径：模拟 Loader 的 `loader/volatile-update`，配置值变化后
 * 系统提示引导立刻反映新值（不用重启、不用重挂）。
 *
 * 用法：`npm run smoke`（或 `node scripts/smoke.mjs`）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 日志落盘到临时目录，不碰 ~/.dsh。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-solpi-action-fusion-smoke-'))

const plugin = await import('../lib/index.js')

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

/** 假的 cordis 宿主：够插件用，不多不少。 */
function createHost(options = {}) {
  const state = { tools: [], sections: [], listeners: new Map(), effects: [], dispatched: [] }

  const toolsService = {
    register(definition) {
      state.tools.push(definition)
      return () => { state.tools = state.tools.filter((tool) => tool !== definition) }
    },
    async execute(input) {
      state.dispatched.push(input)
      if (options.onExecute) return await options.onExecute(input)
      return { isError: false, content: [{ type: 'text', text: `ran ${input.name}` }] }
    },
  }

  const systemPromptService = {
    section(section) {
      state.sections.push(section)
      return () => { state.sections = state.sections.filter((entry) => entry !== section) }
    },
  }

  const services = { tools: toolsService, systemPrompt: systemPromptService }

  const makeContext = () => ({
    get: (name) => services[name],
    effect: (fn, label) => {
      const dispose = fn()
      state.effects.push({ label, dispose })
      return dispose
    },
    on: (event, handler) => {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    },
  })

  const ctx = makeContext()
  ctx.inject = (deps, callback) => {
    callback(makeContext())
    return { dispose() {} }
  }
  return { ctx, state }
}

check('模块导出形状正确', () => {
  assert.equal(plugin.name, 'solpi-action-fusion')
  assert.equal(plugin.SETTINGS_NS, 'solpi-action-fusion')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.default.name, 'solpi-action-fusion')
})

check('六个旋钮都带 volatile 标记', () => {
  const fields = plugin.Config.dict
  assert.deepEqual(
    Object.keys(fields).sort(),
    ['commandTool', 'editTool', 'enabled', 'promptNudge', 'requireSuccessBeforeRun', 'toolName'],
  )
  for (const [key, field] of Object.entries(fields)) {
    assert.equal(field.meta.volatile, true, `${key} 缺少 meta.volatile 标记`)
  }
})

check('校验结果在支持活引用的 schemastery 上是活引用', () => {
  const supportsVolatile = typeof plugin.Config.dict.toolName.volatile === 'function'
  const validated = plugin.Config({ toolName: 'edit_and_run' })
  for (const [key, value] of Object.entries(validated)) {
    if (supportsVolatile) {
      assert.equal(typeof value.get, 'function', `${key} 应为活引用（带 get()）`)
      continue
    }
    // schemastery 3.18.2 还没有 volatile 支持：值是普通值，标记只落在 meta 上
    // （表单仍把它当可写热改项，但运行时拿不到活引用）。
    assert.ok(['string', 'boolean'].includes(typeof value), `${key} 应为普通值`)
  }
  assert.equal(validated.toolName.get?.() ?? validated.toolName, 'edit_and_run')
})

check('apply() 注册融合工具与系统提示引导', () => {
  const { ctx, state } = createHost()
  plugin.apply(ctx, plugin.Config({}))

  assert.equal(state.tools.length, 1)
  const tool = state.tools[0]
  assert.equal(tool.name, 'edit_and_run')
  assert.ok(tool.description.length > 0)
  // parameters 必须是原始 JSON Schema（不是 schemastery 作者形态）。
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['file_path', 'old_string', 'new_string', 'command'])
  // output 必须是原始 JSON Schema 节点 + render。
  assert.equal(tool.output.schema.type, 'object')
  assert.deepEqual(tool.output.schema.required, ['blocks', 'commandFailed', 'skipped'])
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.isConcurrencySafe(), false)

  assert.equal(state.sections.length, 1)
  const section = state.sections[0]
  assert.equal(section.name, 'solpi-action-fusion/guidance')
  assert.equal(section.order, 64)
  assert.ok(section.text().includes('edit_and_run'))
  // 两个 effect 都登记了（工具、提示段），便于宿主卸载时回收。
  assert.deepEqual(state.effects.map((effect) => effect.label).sort(), [
    'solpi-action-fusion.promptSection',
    'solpi-action-fusion.tool',
  ])
})

check('执行时先派发 edit、再派发命令工具，并带嵌套派发标记', async () => {
  const { ctx, state } = createHost()
  plugin.apply(ctx, plugin.Config({}))
  const tool = state.tools[0]

  const token = { token: 'outer-token' }
  const result = await tool.execute(
    {
      file_path: '/tmp/demo.txt',
      old_string: 'a',
      new_string: 'b',
      command: 'node --check demo.js',
    },
    { callId: 'call-1', rootCallId: 'root-1', token, agent: { id: 'agent-1' }, signal: new AbortController().signal },
  )

  assert.equal(state.dispatched.length, 2)
  assert.equal(state.dispatched[0].name, 'edit')
  assert.equal(state.dispatched[1].name, 'pwsh')
  assert.equal(state.dispatched[0].callId, 'call-1:edit')
  assert.equal(state.dispatched[1].callId, 'call-1:run')
  // 嵌套派发约定：沿用外层的 rootCallId，并带上 parent token（否则 ptc 模式会被拒）。
  for (const dispatched of state.dispatched) {
    assert.equal(dispatched.rootCallId, 'root-1')
    assert.equal(dispatched.parent, token)
    assert.deepEqual(dispatched.agent, { id: 'agent-1' })
  }
  assert.equal(result.skipped, false)
  assert.equal(result.commandFailed, false)
  assert.ok(result.blocks.some((block) => block.text === '[then_run:succeeded]'))
})

check('编辑失败且要求先成功时，命令不执行', async () => {
  const { ctx, state } = createHost({
    onExecute: async (input) => (input.name === 'edit'
      ? { isError: true, content: [{ type: 'text', text: 'Error: no such file' }] }
      : { isError: false, content: [] }),
  })
  plugin.apply(ctx, plugin.Config({}))
  const tool = state.tools[0]

  const result = await tool.execute(
    { file_path: '/tmp/nope.txt', old_string: 'a', new_string: 'b', command: 'npm test' },
    { callId: 'call-2', rootCallId: 'root-2', token: {}, agent: {}, signal: new AbortController().signal },
  )

  assert.equal(state.dispatched.length, 1)
  assert.equal(state.dispatched[0].name, 'edit')
  assert.equal(result.skipped, true)
  assert.equal(result.commandFailed, false)
  assert.ok(result.blocks.some((block) => block.text?.startsWith('[then_run:skipped]')))
})

check('热改：loader/volatile-update 之后引导立刻反映新值', () => {
  const { ctx, state } = createHost()
  const ref = { value: 'edit_and_run', get() { return this.value } }
  plugin.apply(ctx, {
    enabled: true,
    toolName: ref,
    editTool: 'edit',
    commandTool: 'pwsh',
    requireSuccessBeforeRun: true,
    promptNudge: true,
  })

  assert.ok(state.sections[0].text().includes('edit_and_run'))
  ref.value = 'fused_edit'
  const handler = state.listeners.get('loader/volatile-update')
  assert.equal(typeof handler, 'function')
  handler()
  assert.ok(state.sections[0].text().includes('fused_edit'))
})

check('cordis.patch.yml 声明了宿主挂载用的插件 id', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes('id: solpi-action-fusion'))
  assert.ok(patch.includes('name: dsh-solpi-action-fusion'))
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(error)
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${checks.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\n全部 ${checks.length} 项通过`)
}
