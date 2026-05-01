# Runtime Smoke Tasks

v0.1.0 adds an RC smoke scenario for scheduled web summaries. It keeps the scripted provider deterministic while documenting the expected `schedule -> web_search -> web_fetch -> inbox/origin delivery` flow.

本阶段固定了一组真实任务样例，用于验证 runtime 在真实任务下是否成立，而不是只验证 provider 能否被调用。

任务样例定义文件：

- `fixtures/runtime-smoke-tasks.json`

覆盖范围：

- A. 单步生产力任务：4 个
- B. 多轮执行任务：4 个
- C. 长任务 / 长上下文任务：2 个

每个任务样例都包含：

- 明确输入
- 预期行为描述
- 可接受结果范围
- trace 可解释性预期

执行入口：

- CLI: `talon smoke run`
- 测试入口：`test/runtime-smoke.test.ts`

批量执行报告至少输出：

- 总任务数 / 成功数 / 失败数
- 平均轮数 / 平均耗时
- 失败原因分类
- 审批触发次数
- tool call 成功率

trace 校验覆盖：

- 任务目标是否可见
- 工具调用原因是否可见
- 工具结果摘要是否可见
- 为什么继续 / 停止是否可见
- 是否触发 memory recall
- 是否触发 policy / approval
