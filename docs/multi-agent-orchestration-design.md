# 多智能体协作开发管道 · 开发文档

> 目标：Claude 作为「架构师/编排者」分析需求并拆解任务，开一个独立窗口交给「开发模型」执行，开发模型完成后自动回调通知 Claude（"大哥我做完了"），Claude 继续验收 / 迭代。

---

## 1. 背景与目标

### 1.1 场景
- **Claude（Orchestrator）**：负责需求分析、任务拆解、编写规格（spec）、验收结果。
- **Developer Model（Worker）**：在独立上下文/进程中执行编码任务。
- **回调机制**：Worker 完成后自动把结果交回 Orchestrator，无需人工搬运。

### 1.2 目标
1. 需求 → 自动拆解 → 自动派发 → 自动开发 → 自动回收结果。
2. 支持「换模型」：开发者可用与 Claude 不同的模型。
3. 每个任务有独立"窗口"（独立上下文），互不污染。
4. 全流程可追踪、可重试、可验收。

---

## 2. 总体架构

```
                ┌──────────────────────────────┐
   需求文本 ──▶ │  Orchestrator (Claude)        │
                │  1. 需求分析                   │
                │  2. 任务拆解 → spec[]          │
                └──────────────┬───────────────┘
                               │ dispatch(spec)
                               ▼
                ┌──────────────────────────────┐
                │  Task Queue / Router          │
                └──────────────┬───────────────┘
                               │ pull
                               ▼
                ┌──────────────────────────────┐
                │  Worker Window (Dev Model)     │
                │  3. 独立上下文中编码            │
                │  4. 产出 diff / 文件            │
                └──────────────┬───────────────┘
                               │ callback: "done + result"
                               ▼
                ┌──────────────────────────────┐
                │  Orchestrator (Claude)         │
                │  5. 验收 / 合并 / 迭代          │
                └──────────────────────────────┘
```

---

## 3. 两种实现路线

### 路线 A：进程内 Subagent（推荐，快速落地）

利用现成的 `subagent` / `subagent_batch` 能力。**"另一个窗口"= 独立子代理上下文；"做完了回调"= 子代理 return 时控制流自动回到父代理。**

| 需求点 | 对应机制 |
|--------|----------|
| 开发窗口 | `subagent(profile="coder")` 独立上下文 |
| 换模型 | `model` 参数指定不同模型 |
| 传递需求 | `sharedContext` / `task` |
| 自动回调 | 子代理 `return` 结果 → 父代理接续 |
| 并行开发 | `subagent_batch` 多任务并发 |

**优点**：零搭建、天然回调、共享工作区文件。
**局限**：都在同一运行时内，无法真正跨机器/跨终端窗口。

### 路线 B：外部消息管道（跨进程 / 跨机器 / 真实独立终端）

自建队列 + Worker 常驻进程 + 回调通道。适合需要「真的开另一个终端窗口 / 独立服务」的场景。

---

## 4. 路线 A 详细设计

### 4.1 Orchestrator 伪代码

```python
# Claude 侧编排逻辑（伪代码）
def orchestrate(requirement: str):
    # 1. 需求分析 + 拆解
    specs = analyze_and_split(requirement)  # -> [TaskSpec, ...]

    results = []
    for spec in specs:
        # 2. 开独立窗口给开发模型
        result = subagent(
            profile="coder",
            model="<dev-model-id>",          # 换成另一个模型
            sharedContext=spec.context,       # 需求背景
            task=spec.instruction,            # 具体开发指令
            maxTurns=12,
        )
        # 3. 子代理 return 即为"大哥我做完了"
        results.append(result)

    # 4. 验收
    return review_and_merge(results)
```

### 4.2 并行开发（多个独立任务）

```python
subagent_batch(
    tasks=[
        {"label": "api",      "profile": "coder", "task": spec_api},
        {"label": "frontend", "profile": "coder", "task": spec_fe},
        {"label": "tests",    "profile": "coder", "task": spec_test},
    ],
    maxConcurrency=3,
)
# 全部完成后统一返回，Orchestrator 逐一验收
# 注意：同批任务必须互无 depends_on 依赖，且 files_hint 无重叠（见 4.5 / 4.7）
```

### 4.3 TaskSpec 结构

```jsonc
{
  "id": "T-001",
  "title": "实现登录接口",
  "context": "项目使用 FastAPI + SQLAlchemy，认证走 JWT……",
  "instruction": "在 app/auth.py 新增 POST /login，校验邮箱密码，返回 JWT",
  "acceptance": [
    "POST /login 返回 200 + token",
    "密码错误返回 401",
    "含单元测试"
  ],
  "files_hint": ["app/auth.py", "tests/test_auth.py"],
  "depends_on": [],              // 依赖的任务 id（见 4.5）
  "model_hint": "light"          // light | standard | flagship（见 4.6）
}
```

说明：`depends_on` / `model_hint` 由 Orchestrator 消费，用于拓扑派发与模型选择，Worker 不感知。

### 4.4 回调协议（Worker 返回格式）

Worker 完成时必须返回结构化结果，便于 Orchestrator 验收：

```jsonc
{
  "status": "done",              // done | blocked | failed
  "message": "大哥我做完了",
  "changed_files": ["app/auth.py", "tests/test_auth.py"],
  "summary": "新增登录接口与测试，全部通过",
  "test_result": "5 passed",
  "notes": "需要在 .env 补充 JWT_SECRET"
}
```

### 4.5 任务依赖图（DAG）与拓扑派发

4.1 的简单串行/并行派发隐含了「spec 互相独立」假设，但真实项目存在强依赖（DB schema → 模型层 → 控制器；API spec → 前端实现）。设计：

- `TaskSpec` 增加 `depends_on` 字段（见 4.3）
- 拓扑排序成派发批次：**同批内任务互不依赖，可 `subagent_batch` 并行；批次间必须串行**
- 失败传播：某任务失败时，依赖它的下游任务标记 `blocked` 并升级人工，避免级联浪费 token

```python
def topological_batches(specs):
    """按拓扑序把 specs 分成可派发批次；检测到环则抛错。"""
    done, remaining, batches = set(), list(specs), []
    while remaining:
        ready = [s for s in remaining
                 if all(d in done for d in s.get("depends_on", []))]
        if not ready:
            raise ValueError("任务依赖存在环，无法派发")
        batches.append(ready)
        for s in ready:
            done.add(s["id"]); remaining.remove(s)
    return batches

def dispatch_all(specs):
    results = []
    for batch in topological_batches(specs):
        if len(batch) == 1:
            results.append(run_worker(batch[0]))
        else:
            results += subagent_batch(
                tasks=[spec_to_task(s) for s in batch],
                maxConcurrency=len(batch),
            )
        # 整批验收（见第 6 节）通过后再进入下一批
    return results
```

### 4.6 Worker 模型选择

`TaskSpec` 的 `model_hint` 由 Orchestrator 按下表映射到具体模型 id：

| 任务复杂度 | 判断依据 | model_hint | 理由 |
|---|---|---|---|
| 简单 CRUD、补测试、格式修复 | ≤3 文件、验收标准明确、无架构影响 | `light`（轻量/便宜模型） | 够用即省成本 |
| 复杂业务逻辑、新模块、重构 | 跨层、多文件、需要理解技术栈 | `flagship`（旗舰模型） | 需要深度推理 |
| 代码审查 / 验收 | 不写代码 | reviewer profile + `standard` | 读得快、省输出 token |

项目级映射放 `.agent/model-mapping.json`，按部署环境调整：

```jsonc
{
  "light": "openai/gpt-4o-mini",
  "standard": "openai/gpt-4o",
  "flagship": "anthropic/claude-sonnet-latest"
}
```

### 4.7 文件冲突检测与串行化

并行 Worker 写同一文件是最大冲突源，不能靠运气，两层处理：

**派发层（Orchestrator 预检）**：拆解后对 `files_hint` 做重叠检测，重叠任务强制同批内串行：

```python
def enforce_file_ownership(batches, specs):
    """两个任务 files_hint 重叠时，强制挪到同一串行位置。"""
    owner = {}   # file -> 该文件的归属任务
    for batch in batches:
        for spec in batch:
            for f in spec.get("files_hint", []):
                if f in owner and owner[f] is not spec:
                    move_to_serial(spec, owner[f])   # 与归属任务排成前后脚
                owner.setdefault(f, spec)
```

**执行层（Worker 纪律）**：任务指令中显式声明「只允许修改 `files_hint` 内文件」；确需改动额外文件，写入回调 `notes` 说明，由 Orchestrator 验收时仲裁（见 6.1 第 2 步）。路线 B 下用 git 分支隔离 + Orchestrator 合并兜底（见 5.7）。

### 4.8 任务拆解 Prompt 设计（对应 M2）

`analyze_and_split` 用结构化 prompt 实现，参考模板：

```
你是需求分析与任务拆解模块。根据需求与项目背景，拆解为可独立交付的开发任务。

## 输入
- 需求文本: {requirement}
- 项目背景: {project_context}
- 相关文件清单/摘要: {files_context}

## 拆解规则
1. 粒度：单个任务由一个 worker 在 1 个编码会话内可完成、可验证（约 ≤3 个文件）
2. 独立性：尽量拆成互不依赖的任务；有依赖时必须声明 depends_on
3. 可验证：acceptance 必须可逐条检查（测试用例 / HTTP 响应 / 命令输出），不接受"完成了"
4. files_hint 尽量具体；model_hint 按 4.6 矩阵选择
5. 只输出 JSON 数组，不要输出其他内容

## 输出
[ {TaskSpec}, ... ]   （字段结构见 4.3）
```

拆解结果须通过 Orchestrator 自检后再派发（任一不满足则重新拆解，最多 2 轮）：

- [ ] 每个 spec 的 acceptance 至少含一条可执行验证
- [ ] `depends_on` 无环
- [ ] `files_hint` 重叠已按 4.7 处理
- [ ] 任务总数 ≤ 8；超过则拆成多轮或再拆细

---

## 5. 路线 B 详细设计（外部管道）

### 5.1 组件

| 组件 | 作用 | 选型建议 |
|------|------|----------|
| Task Queue | 存放待开发任务 | Redis List / SQLite / 文件目录 |
| Dispatcher | Claude 投递任务 | 写入队列 |
| Worker | 常驻进程，拉任务调开发模型 | Python 脚本 |
| Callback Bus | "做完了"通知 | Webhook / Redis Pub-Sub / 文件监听 |
| State Store | 任务状态机 | SQLite: pending→running→done/failed |

### 5.2 任务状态机

```
pending → running → done
                 └→ failed → (retry) → pending
                 └→ blocked → (人工介入)
```

### 5.3 目录结构（文件队列最简实现）

```
pipeline/
├── inbox/        # Claude 投递的任务 json
├── running/      # Worker 正在处理
├── done/         # 完成结果 json（含回调消息）
├── failed/       # 失败任务
└── worker.py     # 常驻 Worker
```

### 5.4 Worker 主循环伪代码

```python
import json, time, pathlib, shutil

INBOX = pathlib.Path("pipeline/inbox")
RUNNING = pathlib.Path("pipeline/running")
DONE = pathlib.Path("pipeline/done")

def call_dev_model(spec: dict) -> dict:
    # 调用开发模型 API，返回代码/diff
    ...

def notify_orchestrator(result: dict):
    # 回调：Webhook POST 或写入 done/ 目录
    (DONE / f"{result['id']}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2)
    )

def main():
    while True:
        for task_file in sorted(INBOX.glob("*.json")):
            spec = json.loads(task_file.read_text())
            running_path = RUNNING / task_file.name
            shutil.move(task_file, running_path)      # 认领任务
            try:
                out = call_dev_model(spec)
                result = {
                    "id": spec["id"],
                    "status": "done",
                    "message": "大哥我做完了",
                    **out,
                }
            except Exception as e:
                result = {"id": spec["id"], "status": "failed", "error": str(e)}
            notify_orchestrator(result)               # 自动回调
            running_path.unlink(missing_ok=True)
        time.sleep(2)

if __name__ == "__main__":
    main()
```

### 5.5 回调（Webhook 版）

```python
import requests

def notify_orchestrator(result: dict):
    requests.post(
        "http://localhost:8080/callback",   # Orchestrator 监听端点
        json=result,
        timeout=10,
    )
```

Orchestrator 侧监听：

```python
from fastapi import FastAPI, Request
app = FastAPI()

@app.post("/callback")
async def on_done(req: Request):
    result = await req.json()
    print(f"[回调] {result['id']}: {result['message']}")
    # 触发 Claude 验收逻辑
    review(result)
    return {"ok": True}
```

### 5.6 幂等与回调去重

网络抖动导致重复投递回调时会重复合并，协议需加两个字段：

```jsonc
{
  "id": "T-001",
  "attempt": 2,        // 该任务第几次执行（每次重试 +1）
  "nonce": "7f3a-..."  // 随机值，同一次 attempt 内去重
}
```

Orchestrator 侧幂等规则：

```python
def on_callback(result):
    existing = load_done(result["id"])
    if existing and (
        existing["nonce"] == result["nonce"]      # 重复投递
        or existing["attempt"] > result["attempt"] # 过期回调
    ):
        return  # 丢弃
    save_done(result)
    review_and_merge(result, ...)
```

### 5.7 Git 分支隔离（路线 B）

Worker 不直接改主干，用独立分支隔离，回滚零成本：

1. Worker 认领任务 → `git_branch_isolate(label=f"{task_id}-a{attempt}")`
2. 变更全部 commit 到分支，回调结果中携带 `branch` 字段
3. Orchestrator 验收（第 6 节）通过 → merge；不通过 → **直接丢弃分支**，主干不受污染
4. 路线 A 同理受益：合并前 `git_checkpoint(label=f"pre-{task_id}")`，回滚即 `git_undo(checkpointId)`（见 7.1）

### 5.8 可观测性日志设计

每个任务写 `pipeline/logs/{task_id}.jsonl`，一行一个事件：

```jsonc
{"ts": "2025-01-01T10:00:00Z", "task_id": "T-001", "attempt": 1, "event": "dispatch", "model": "gpt-4o"}
{"ts": "...", "task_id": "T-001", "event": "tool_call", "tool": "edit", "path": "app/auth.py"}
{"ts": "...", "task_id": "T-001", "event": "done", "duration_ms": 45000, "tokens_out": 12300}
```

- 事件枚举：`dispatch / start / tool_call / result / done / fail / retry / callback / review_pass / review_fail / merge / rollback`
- 汇总查询：成功率、平均耗时、迭代次数分布、各模型 token 成本 —— `jq` 或 SQLite 聚合即可
- 排障：`fail / blocked` 时保留最近 N 条事件用于归因

---

## 6. 验收（Orchestrator 侧）

### 6.1 验收管道（具体实现）

收到回调后执行五道门禁，全部自动化，不靠人工搬运：

```python
def review_and_merge(result, spec, iter=1, max_iter=3):
    # 1. 状态检查
    if result["status"] != "done":
        return retry_or_escalate(spec, result, iter, max_iter)

    # 2. 文件核对：changed_files 全部存在，且落在 files_hint ∪ notes 声明范围内
    if not files_within_scope(result, spec):
        return reject_and_iterate(spec, result, "变更文件超出声明范围", iter, max_iter)

    # 3. 验证门禁：测试 / 类型检查 / 构建
    ok, report = validate_workspace(steps=["test", "typecheck", "build"])

    # 3.5 导入安全（可选硬门禁，importSafety / importSafetyProbe 启用）
    #     changed_files 中每个可导入模块须存活于裸动态导入
    #     （捕获非防御式 main-entry 守卫在 import 时崩溃的缺陷类）

    # 4. 语义验收：独立 reviewer 子代理读 diff，对照 acceptance 逐条核对
    verdict = subagent(
        profile="reviewer",
        task=(f"任务 spec: {json.dumps(spec)}\n"
              f"Worker 结果: {json.dumps(result)}\n"
              f"验证报告: {report}\n"
              "请逐条验证 acceptance 并返回 JSON verdict"),
    )
    # verdict: {"passed": bool, "failed_items": ["..."], "suggestions": "..."}

    # 5. 决策
    if ok and verdict["passed"]:
        git_checkpoint(label=f"pre-{spec['id']}")   # 合并前留回滚点（路线 A）
        merge(result, spec)                          # 路线 B：合并独立分支
        return "merged"
    if iter < max_iter:
        revised = generate_revision_spec(spec, verdict["failed_items"],
                                         verdict["suggestions"])
        return dispatch_all([revised])               # 闭环迭代
    return escalate_to_human(spec, result)           # 超限转人工
```

### 6.2 验收门禁（硬性标准）

| 门禁 | 标准 | 不通过处理 |
|---|---|---|
| 状态 | `status == done` | 重试（attempt+1）或升级人工 |
| 文件核对 | `changed_files` 全部存在，且落在 `files_hint ∪ notes 声明` 内 | 打回迭代 |
| 导入安全（可选硬门禁） | `changed_files` 中每个可导入模块（ts/js/mjs/cjs…）存活于裸动态导入（`importSafety` 内置 `npx tsx -e` 子进程探针 / `importSafetyProbe` 自定义探针） | 打回迭代 |
| typecheck | 0 error | 打回迭代 |
| test | 全绿且覆盖新功能 | 打回迭代 |
| build | 通过 | 打回迭代 |
| 语义验收 | reviewer 逐条核对 `acceptance`，覆盖率 ≥ 80% 且无 P0 缺陷 | 生成修订 spec 重派 |

注意两点：

- 「含单元测试」这类验收项，须测试文件真实覆盖新功能且用例通过才视为满足，防止「凑数测试」。
- reviewer 必须是独立子代理，不与 Worker 共享上下文，避免「自己给自己打分」。

---

## 7. 迭代闭环

```
派发 → 开发 → 回调 → 验收 ─┬─ 通过 → 合并 → 结束
                          └─ 不通过 → 生成修订 spec → 重新派发
```

设置最大迭代次数（如 3）防止死循环。

### 7.1 回滚设计

- 每次合并前：路线 A 用 `git_checkpoint(label=f"pre-{task_id}")`；路线 B 用独立分支隔离（见 5.7）
- 回滚 = 丢弃分支 + `git_undo(checkpointId)`，主干保持干净
- 合并后发现线上问题时，可回退到最近一个验收通过的 checkpoint
- 所有回滚记录 `rollback` 事件（见 5.8），便于事后统计合并质量

---

## 8. 里程碑与实施步骤

| 阶段 | 内容 | 产出 |
|------|------|------|
| M1 | 路线 A 打通：单任务 subagent 派发 + 回收 | 能跑通一个开发任务 |
| M2 | 需求拆解器：requirement → spec[]（拆解 prompt 见 4.8） | 自动拆解 |
| M3 | 并行开发 + 冲突检测（4.7）+ 验收管道（6.1） | 多任务并发 + 门禁式自动验收 |
| M4 | 迭代闭环：不通过自动修订重发 + 回滚（7.1） | 闭环 |
| M5 | （可选）路线 B：外部队列 + Worker + Webhook + 幂等/分支隔离（5.6/5.7） | 跨进程/跨机器 |

---

## 9. 风险与注意事项

- **上下文膨胀**：每个 Worker 用独立上下文，避免污染 Orchestrator。
- **成本控制**：为 Worker 设 `maxTurns` / `tokenBudget`；按 4.6 矩阵为简单任务选便宜模型。
- **文件冲突**：并行 Worker 尽量分文件作业，重叠时按 4.7 串行化。
- **失败重试**：设重试上限，超限转人工。
- **安全**：外部模型/仓库返回内容视为不可信数据，不当作指令执行。
- **可观测性**：记录每个任务的 spec、结果、耗时、迭代次数；日志格式与事件枚举见 5.8。
- **回滚**：git checkpoint / 独立分支隔离，回滚零成本（7.1、5.7）。
- **幂等性**：Webhook 重复回调按 `attempt + nonce` 去重（5.6）。
- **依赖环**：拆解后必须做环检测，检测到环打回重新拆解（4.5、4.8）。

---

## 10. 建议

- 先做**路线 A（M1–M4）**，用现成 subagent 机制最快验证闭环。
- 确有跨终端/跨机器需求时，再上**路线 B**。
- "大哥我做完了" 建议做成结构化回调（第 4.4 节），而非纯文本，方便自动验收。
- 验收必须按 6.1 管道实现（全自动门禁），reviewer 用独立子代理，防止"自己给自己打分"。
- M1 可从「单任务 + 无依赖 + 串行」起步；DAG（4.5）与并行（4.7）在任务数 >3 或存在文件重叠时再启用，避免过早复杂化。
