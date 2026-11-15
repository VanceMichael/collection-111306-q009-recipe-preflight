# 配方预检、试运行与正式领取说明

本文档面向写配方和跑采集的现场人员。看懂本文档即可根据预检结论改配方，不需要读执行器源码。

## 流程总览

```
配方 + 适配器能力 ──预检──> 结论（通过/未通过 + 每条可达路径 + 改法）
                     │
                     ├─通过──> 试运行（只读本地资料源，跳过对外写入）
                     │            │
                     │            └─成功──> 正式领取（凭两份结论执行，留痕到接收文件）
                     │
                     └─未通过──> 按结论里的“改法”修配方，重新预检
```

## 配方格式

配方是一个 JSON 对象：`id`、可选的 `inputs`、必填的 `steps`。步骤有四种形态：

| 形态 | 写法 | 含义 |
| --- | --- | --- |
| 动作 | `{"id":"first","adapter":"fetch","input":"seed","requires":["token"],"produces":{"token":"page-token"}}` | 调适配器取数。`input`/`requires` 是消费的值，`produces` 是产出的值 |
| 分支 | `{"id":"b","condition":"hasMore","then":[...],"otherwise":[...]}` | 按条件走一臂 |
| 并行 | `{"id":"fork","parallel":[[...],[...]]}` | 多支同时领取，最后汇合 |
| 重复 | `{"id":"more","repeat":{"while":"token","max":4},"body":[...]}` | 有界翻页；固定次数用 `"times": 次数` |

值的来源只有三种：上游步骤 `produces`、人工输入 `inputs`、守卫分支内被确认存在的可选值。**没有来源的值不能消费，可选值不能默认已有。**

- `inputs`：`{"seed":{"source":"human","description":"起始页令牌"}}`；加 `"optional":true` 表示人工可不给。
- `produces` 对象写法里名字带 `?` 表示可选产出，例如 `{"warning?":"text"}`。
- 条件写法：`"hasMore"`（要求该值确定存在）、`{"has":"x"}`（守卫：判断 x 是否存在，then 臂内 x 视为有值）、`{"not":...}`、`{"eq":["x",值]}`、`{"all":[...]}`、`{"any":[...]}`。
- 可选值要被消费时，把消费步骤放进 `{"has":"该值"}` 的 then 臂——这就是“补充条件”。

## 适配器能力

每个适配器登记四项能力，预检和试运行据此判断兼容性：

| 能力 | 取值 | 规则 |
| --- | --- | --- |
| `output` | 类型名 | 并行/分支汇合时同名产物类型必须一致 |
| `replayable` | true/false | 重复步骤体内的适配器必须可重放 |
| `pausable` | true/false | 步骤带 `"pauseAfter":true` 时适配器必须支持暂停 |
| `effect` | read/write | write 步骤试运行一律跳过，正式领取才执行 |

## 检查码与现场改法

预检结论里每条发现都带：检查码、所在步骤、路径（如 `branch.otherwise → next`）、原因、改法。

| 检查码 | 含义 | 怎么改 |
| --- | --- | --- |
| `missing-source` | 步骤需要的值在这条路径上没有来源 | 在到达该步骤的每条路径上补齐产生步骤，或把该步骤移进已有来源的路径，或在 `inputs` 声明人工提供 |
| `maybe-value` | 需要的值只是“可能可用”（可选输入、只在一臂产生、循环可能 0 次） | 不能默认已有：在缺它的分支补齐，或把消费步骤放进 `{"has":"值名"}` 守卫的 then 臂 |
| `condition-unknown` | 条件读取的值没有任何来源 | 先让上游产生它，或改用 `{"has":"值名"}` |
| `condition-maybe` | 条件依赖可能不存在的值 | 改用 `{"has":"值名"}` 明确判断存在性 |
| `unbounded-repeat` | 重复步骤没有上界 | `repeat` 加 `"max":最大次数` 或 `"times":次数` |
| `parallel-type-mismatch` | 并行多支产生同名值但类型不同 | 各支产物改不同名字，或统一适配器输出类型 |
| `parallel-duplicate` | 并行多支产生同名值 | 各支产物改不同名字 |
| `branch-type-mismatch` | 分支两臂产生的同名值类型不同 | 统一两臂产物类型或改名 |
| `capability-replayable` | 不可重放的适配器被放进重复步骤 | 换可重放适配器，或把该步骤移出循环 |
| `capability-pausable` | 步骤要求暂停但适配器不支持 | 去掉 `pauseAfter` 或换支持暂停的适配器 |
| `adapter-unknown` | 引用了未登记的适配器 | 在适配器清单登记能力，或换已登记的 |
| `external-action`（提示） | 步骤有对外写动作 | 不用改；试运行会跳过它，正式领取才执行 |

典型例子（对应 fixtures 里的实例配方）：

- **分支遗漏**（`missing-branch`）：`token` 只在 `branch` 的 then 臂由 `make-token` 产生，`next` 在 otherwise 路径上消费它 → 报 `maybe-value`，路径 `branch.otherwise → next` 标 ✗。
- **并行汇合**（`parallel-mismatch`）：两支都产生 `result`，类型分别是 `page` 和 `record` → 报 `parallel-type-mismatch`。
- **有界重复**（`unbounded-repeat`）：`repeat` 只有 `while` 没有 `max` → 报 `unbounded-repeat`。

## 试运行边界

- 只读本地资料源（`fixtures/pages.json`），不访问外部。
- 写能力步骤一律跳过，产物用 `withheld:` 占位值代替，适配器不会被调用。
- 试运行产出的令牌带 `dry:<试运行编号>:` 前缀。正式领取会拒绝任何带该前缀的输入——临时令牌不得带进正式执行，人工输入需重新提供。

## 结论失效依据

每份预检/试运行结论都带指纹，由三部分组成：

1. **配方内容**（recipeHash）：配方 JSON 的任何改动；
2. **适配器能力**（adapterHash）：该配方实际用到的适配器能力项的任何改动；
3. **分析器版本**（analyzer）：检查规则升级。

正式领取前逐一比对：三部分都一致 → 旧结论仍然可用；任一部分不同 → 拒绝执行并说明是哪一部分变了（“配方内容已变更”/“适配器能力已变更”/“分析器版本已升级”），需重新预检和试运行。只改没被该配方用到的适配器不影响结论。

## 正式领取

`executeFormal` 依次核对：预检结论指纹新鲜且通过 → 试运行结论指纹一致且成功 → 人工输入齐全且不带试运行标记，然后才执行。执行轨迹和回执追加到接收文件（默认 `var/captures.json`），可按指纹回溯本次领取依据的是哪份结论。
