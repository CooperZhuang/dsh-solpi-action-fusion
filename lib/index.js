/**
 * dsh-solpi-action-fusion
 *
 * SoL-Pi 的 Action Fusion 机制在 DSH 上的落地：**一次工具调用里完成「编辑 + 校验命令」**，
 * 省掉模型"先编辑、看到结果、再单独跑命令"的那一次往返。
 *
 * 为什么值得做（真实语料实测，60 个会话 / 3,023 次模型请求）：
 *   - 980 次编辑调用中，604 次（61.6%）的下一次工具调用是命令；
 *   - 其中 **591 次（97.8%）是跨 step 的**——即真能省一次模型往返；
 *   - 占全部 step 的 **19.6%**，是四个机制里最大的单项机会；
 *   - 而 `run_code`(PTC) 只出现 140 次，实践上并没有覆盖这个模式。
 *
 * 实现选择：**注册一个独立工具，而不是 shadow 内建 `edit`**。理由：
 *   若 shadow `edit`，那么从工具内部用 `tools.execute({name:'edit'})` 派发时会解析到
 *   自己（无限递归）；把 `agent` 置空来绕过，又会跳过 agent scope 的权限 guard 与
 *   spill 归属。独立工具没有这些问题：派发 `edit` 时 agent scope 完好，所有 pre-execute
 *   guard、post-execute 策略照常生效。
 *
 * 代价：模型必须主动选择这个工具（SoL-Pi 是给原工具加可选参数，触发方式不同）。
 * 这一点由 A/B 实测的采用率来回答。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名。 */
export const name = 'solpi-action-fusion'

/** 配置命名空间 = profile 条目 id；平台自动生成的配置表单按它定位本条目。 */
export const SETTINGS_NS = 'solpi-action-fusion'

const DEFAULTS = Object.freeze({
  enabled: true,
  toolName: 'edit_and_run',
  editTool: 'edit',
  commandTool: 'pwsh',
  requireSuccessBeforeRun: true,
  promptNudge: true,
})

/**
 * 把字段标成 volatile：既会以**活引用**交给 `apply`（写盘后原地更新引用并补发
 * `loader/volatile-update`，不用重启也不重挂），也是配置表单里唯一可写的一类字段。
 *
 * 宿主读的就是 `schema.meta.volatile`（cordis-plugin-loader 里的
 * `schema?.meta?.volatile`，dsh-settings 的 volatileForm / isVolatilePath 同理），
 * 所以两种写法在**标记**这件事上等价。但**返回值必须用**：
 * schemastery ≥3.18.3 的 `.volatile()` 是 copy-on-write（内部走 `extra()`），
 * 它返回的是**副本**，原 schema 不会被改动——就地调用再丢掉返回值，标记会整个
 * 丢失（字段退化成普通字段：表单不再是可写热改项，宿主也不再发活引用）。
 * 3.18.2 没有 `.volatile()`，只能就地打标记，它返回的就是同一个对象。
 *
 * @param {any} schema 字段 schema（schemastery 的 Schema 实例；这里故意用 `any`，
 *   因为要按能力探测 `.volatile()`，不同 schemastery 版本的类型面并不一致）。
 * @returns {any} 打好 volatile 标记的字段 schema（≥3.18.3 时是副本）。
 */
function volatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  schema.meta.volatile = true
  return schema
}

/** 是否是 Loader 交给 `apply` 的 volatile 活引用。 */
function isVolatileRef(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.get === 'function'
  )
}

/**
 * 解包 entry 配置里的 volatile 引用。
 *
 * 引用里的值只在 Loader 写盘后原地更新，所以每次都要重新 `get()`；而且必须在
 * 校验**之前**解包——下面那些严格类型检查看到的必须是普通的布尔/字符串。
 * 普通配置对象（未走 Loader 的挂载、仓库脚本里的调用）原样通过。
 *
 * @param {object} config entry 配置或普通配置对象。
 * @returns {object} 值已解包的浅拷贝。
 */
function plainConfig(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const plain = {}
  for (const [key, value] of Object.entries(source)) {
    plain[key] = isVolatileRef(value) ? value.get() : value
  }
  return plain
}

/**
 * 六个旋钮的字段 schema（**未**标 volatile）。
 *
 * 单独抽出来是因为 volatile 标记必须作用在**真正进入 object 字典的那份** schema 上
 * （见 `volatile()` 的说明：≥3.18.3 的 `.volatile()` 返回副本）。
 */
const CONFIG_FIELDS = {
  enabled: z.boolean().default(DEFAULTS.enabled)
    .description('总开关。关闭后不再注册融合工具。'),
  toolName: z.string().default(DEFAULTS.toolName)
    .description('融合工具的模型可见名称。'),
  editTool: z.string().default(DEFAULTS.editTool)
    .description('真正执行修改的内建工具名。默认 edit。'),
  commandTool: z.string().default(DEFAULTS.commandTool)
    .description('执行校验命令的内建工具名。Windows 下通常是 pwsh，其它平台通常是 bash。'),
  requireSuccessBeforeRun: z.boolean().default(DEFAULTS.requireSuccessBeforeRun)
    .description('要求文件修改成功后才执行命令。开启时若修改失败会跳过命令并明确说明。'),
  promptNudge: z.boolean().default(DEFAULTS.promptNudge)
    .description('在系统提示里加一段引导，要求"改完就验证"时优先用融合工具。实测：没有这段引导时，模型对新增工具的采用率是 0。'),
}

/**
 * 插件配置 schema。
 *
 * 必须是**导出的 `Config`**：0.1.7 起设置域按 profile 条目的 Config 投影出表单，
 * 而「条目 schema」就是从这个导出取的（名字是约定）。本插件没有浏览器半边，所以
 * **不**调用 `settings.configure({ auto: false })`——平台按这份 schema 自动生成的
 * 那张表单就是它唯一的界面。
 *
 * 六个旋钮都可热改、都可写：逐字段打 volatile 标记，且**用返回值**替换字典里的
 * 那份 schema。
 */
export const Config = z.object(
  Object.fromEntries(
    Object.entries(CONFIG_FIELDS).map(([key, field]) => [key, volatile(field)]),
  ),
)

function resolveConfig(config = {}) {
  const resolved = { ...DEFAULTS, ...plainConfig(config) }
  for (const key of ['enabled', 'requireSuccessBeforeRun', 'promptNudge']) {
    if (typeof resolved[key] !== 'boolean') throw new Error(`solpi-action-fusion: ${key} must be a boolean`)
  }
  for (const key of ['toolName', 'editTool', 'commandTool']) {
    if (typeof resolved[key] !== 'string' || resolved[key].trim().length === 0) {
      throw new Error(`solpi-action-fusion: ${key} must be a non-empty string`)
    }
  }
  return Object.freeze(resolved)
}

/** 尽力而为的日志，沿用本仓库其它插件的约定。 */
function makeLogger(ctx) {
  let path
  try {
    const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs')
    mkdirSync(dir, { recursive: true })
    path = join(dir, 'dsh-solpi-action-fusion.log')
  } catch {
    path = undefined
  }
  return (level, message) => {
    ctx?.logger?.[level]?.(message)
    if (path === undefined) return
    try {
      appendFileSync(path, `[${new Date().toISOString()}] ${level} ${message}\n`, 'utf8')
    } catch {
      /* 日志失败不影响机制 */
    }
  }
}

/**
 * 派发内建工具时的调用 id：沿用外层 callId 并加后缀。
 *
 * 内核的 `ToolCallId` 是带 brand 的 string 类型，运行时并不校验 brand，所以这里
 * 只做类型层面的标注（类型来源见 `@deepseek-ai/dsh-llm/brand`）。
 *
 * @param {string} callId 外层那次工具调用的 id。
 * @param {string} suffix 后缀（edit / run）。
 * @returns {import('@deepseek-ai/dsh-llm/brand').ToolCallId} 内层派发用的调用 id。
 */
function subCallId(callId, suffix) {
  return /** @type {import('@deepseek-ai/dsh-llm/brand').ToolCallId} */ (`${callId}:${suffix}`)
}

/**
 * 构造融合工具定义。
 *
 * 类型注释指向内核包（`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`），只是
 * **类型层面**的引用，不产生运行时依赖：这样 `tsc --checkJs` 能直接对着 0.2.1-rc.2
 * 的 `ToolDefinition` / `ToolRuntime` 契约校验这份定义（换内核版本时第一道警报）。
 *
 * @param {import('@deepseek-ai/dsh-tools').ToolRuntime} ctx 工具注册表（派发内建工具用）。
 * @param read - 读取当前生效配置。
 * @param log - 日志函数。
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition} 可直接交给 `ctx.tools.register` 的工具定义。
 */
export function createFusedTool(ctx, read, log) {
  return {
    name: read().toolName,
    description: [
      '编辑文件并**在同一个工具调用里**立即运行一条校验命令。',
      '当你打算"改完某个文件就马上验证"时用它，可以省掉一次单独的往返。',
      '先用 read 读文件；old_string 必须逐字匹配。',
      '若文件修改失败，命令不会执行，并会明确标注 [then_run:skipped]。',
    ].join('\n'),
    // parameters 是【原始 JSON Schema】——ToolDefinition 的契约就是原始 schema，
    // 不需要（也不应该）用 defineTool 的作者形态。写成作者形态会让适配层收到
    // 一个没有 type 的 schema，报 "schema must be of type object, got type: null"。
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要修改的文件路径。' },
        old_string: { type: 'string', description: '要被替换的原文，必须逐字匹配。' },
        new_string: { type: 'string', description: '替换后的文本，必须与 old_string 不同。' },
        replace_all: { type: 'boolean', description: '替换所有匹配。默认 false；为 false 时 old_string 必须只出现一次。' },
        command: { type: 'string', description: '文件修改成功后要运行的校验命令，例如 npm test 或 node build.mjs。' },
      },
      required: ['file_path', 'old_string', 'new_string', 'command'],
      additionalProperties: false,
    },
    output: {
      // 注意：这里必须是【原始 JSON Schema】节点，不是 schemastery 的作者形态。
      // 写成 { type: 'json' } 会被注册表拒绝：
      //   unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null
      schema: {
        type: 'object',
        properties: {
          blocks: { type: 'array' },
          commandFailed: { type: 'boolean' },
          skipped: { type: 'boolean' },
        },
        required: ['blocks', 'commandFailed', 'skipped'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const blocks = /** @type {any} */ (value)?.blocks
        return Array.isArray(blocks) ? blocks : []
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const config = read()
      const { command, ...editArgs } = /** @type {any} */ (args)
      const blocks = []

      // 内建工具的派发按 0.2.1-rc.2 的**嵌套派发**约定来写：
      //   - `rootCallId` 传外层那次模型请求的根调用 id（嵌套派发要沿用外层值，
      //     缺省会把自己当成一次根调用）；
      //   - `parent` 传外层执行登记的 token，它同时是"这是个子派发、不是模型直呼"
      //     的标记。少了它，在 `mode: 'ptc'` 的部署里这次派发会被当成模型直呼，
      //     按 UNKNOWN_TOOL 拒掉（`collapses()`：`!nested && mode === 'ptc'`），
      //     融合工具的"先改文件"就会永远失败。
      //   - `agent` 继续带上：agent scope 的权限 guard 与 spill 归属都靠它。
      const nested = {
        rootCallId: exec.rootCallId,
        parent: exec.token,
        agent: exec.agent,
        signal: exec.signal,
      }

      const editResult = await ctx.execute({
        callId: subCallId(exec.callId, 'edit'),
        name: config.editTool,
        arguments: editArgs,
        ...nested,
      })
      blocks.push(...(editResult.content ?? []))

      if (editResult.isError === true) {
        if (config.requireSuccessBeforeRun) {
          blocks.push({
            type: 'text',
            text: '[then_run:skipped] 文件修改未成功，命令没有执行。修复上面的错误后重试。',
          })
          log('info', `skipped: ${editArgs.file_path} 修改失败`)
          return { blocks, skipped: true, commandFailed: false }
        }
      }

      const commandResult = await ctx.execute({
        callId: subCallId(exec.callId, 'run'),
        name: config.commandTool,
        arguments: { command, description: 'then_run 融合命令' },
        ...nested,
      })

      blocks.push({
        type: 'text',
        text: commandResult.isError === true ? '[then_run:failed] 命令返回失败。' : '[then_run:succeeded]',
      })
      blocks.push(...(commandResult.content ?? []))

      log(
        'info',
        `fused ${editArgs.file_path} + \`${command.slice(0, 60)}\` -> ${commandResult.isError === true ? 'failed' : 'succeeded'}`,
      )

      return {
        blocks,
        skipped: false,
        commandFailed: commandResult.isError === true,
      }
    },
  }
}

/**
 * 安装 Action Fusion。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} rawConfig 插件行配置（部署层默认值）。
 */
export function apply(ctx, rawConfig = {}) {
  const log = makeLogger(ctx)
  const base = resolveConfig(rawConfig)
  let current = base
  const read = () => current

  // 配置只有一处：本插件的 entry 行。0.1.7 起没有 `settings.register`，旋钮就是
  // entry 行里标了 volatile 的字段——Loader 写盘后原地更新活引用并补发
  // `loader/volatile-update`，这里只做「重读」。
  ctx.on('loader/volatile-update', () => {
    current = resolveConfig(rawConfig)
    log('info', `settings updated: ${JSON.stringify(current)}`)
  })

  ctx.inject(['tools'], (toolsCtx) => {
    try {
      if (current.enabled !== true) {
        log('info', 'disabled by configuration')
        return
      }
      const tools = toolsCtx.get('tools')
      if (tools === undefined) {
        log('warn', 'tool registration skipped: tools service unavailable')
        return
      }
      const dispose = tools.register(createFusedTool(tools, read, log))
      toolsCtx.effect(() => dispose, 'solpi-action-fusion.tool')
      log('info', `active: registered tool "${current.toolName}" (edit=${current.editTool}, command=${current.commandTool})`)
    } catch (error) {
      log('warn', `tool registration failed: ${String(error?.message ?? error)}`)
    }
  })

  // 系统提示引导。
  //
  // 实测教训：只靠工具自身的 description，模型对新增工具的采用率是 **0**——
  // 它继续用熟悉的 `edit` + 单独跑命令。内建的 `edit` 工具本身就在系统提示里
  // 占了一段位置，所以"新增工具没人用"未必是模型不会用新工具，而是引导不对等。
  // 这里补上对等的引导，且不改动任何内建工具（不 shadow，零风险）。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      const text = (config) =>
        [
          `当你打算改完文件就立刻验证时（例如"改一处、跑一次构建/测试"），**优先用 \`${config.toolName}\` 工具**：`,
          '它在一次工具调用里先完成文件修改、再运行你给的校验命令，可以省掉一次独立的模型往返。',
          `只改文件、当下不需要验证时，仍然用 \`${config.editTool}\`。`,
          `\`${config.toolName}\` 的参数与 \`${config.editTool}\` 相同，只是多一个必填的 \`command\`。`,
        ].join('\n')
      const systemPrompt = promptCtx.get('systemPrompt')
      if (systemPrompt === undefined) {
        log('warn', 'system-prompt guidance skipped: systemPrompt service unavailable')
        return
      }
      const dispose = systemPrompt.section({
        name: 'solpi-action-fusion/guidance',
        order: 64,
        text: () => (read().promptNudge === true && read().enabled === true ? text(read()) : ''),
      })
      promptCtx.effect(() => dispose, 'solpi-action-fusion.promptSection')
      log('info', `active: system-prompt guidance registered (promptNudge=${current.promptNudge})`)
    } catch (error) {
      log('warn', `system-prompt section registration failed: ${String(error?.message ?? error)}`)
    }
  })
}

export default { name, apply }
