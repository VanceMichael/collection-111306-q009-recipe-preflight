# 采集配方的分支能力校验与安全试运行

各工厂现在自己写采集配方，中央调度只知道节点名字，常常跑到最后才发现某个分支没有产生后面需要的分页令牌。这里保存现有资料预览工具和本地供方模拟服务，便于离线开发和复查领取行为。

## 当前能力

`npm run demo` 从本地资料源读取配方与适配器能力，逐条配方做预检（每条可达路径的输入来源与能力核对，附改法），对通过预检的 `paged-collect` 依次做试运行和正式领取，并演示两条边界：试运行令牌不得带进正式执行、配方变更后旧结论失效。结果写入 `var/captures.json`。

预检、试运行、正式领取是执行器之前的独立环节，见 `docs/preflight.md`。`src/domain.mjs` 保留已有领域预览函数；`src/store.mjs` 提供带完整性校验的单进程顺序接收文件，不是跨进程事务数据库。

## 运行

固定 Node.js 22.22.1，不依赖外部服务。所有 HTTP 资料源由进程在回环随机端口启动并关闭。

```sh
npm ci
npm run build
npm test
npm run demo
```

推荐使用固定镜像构建，首次构建会安装锁文件中的依赖；运行时不需联网。

```sh
docker build -t plant-recipe-preflight .
docker run --rm --network none --ipc=host plant-recipe-preflight npm test
docker run --rm --network none --ipc=host plant-recipe-preflight npm run demo
```

开发时 `npm start` 打印本地源地址；设置 `PORT` 可指定监听端口，未设置时自动分配回环端口。浏览器页面或 HTTP 接口可直接查看。`CAPTURE_PATH` 可改变接收文件路径。重复运行预览追加记录；删除 `var` 可从空接收状态开始。

## 模块

- `src/source.mjs`：该业务的本地资料源与演示控制，独立于待扩展的接收行为。
- `src/domain.mjs`：现有原始资料预览和领域数据结构。
- `src/recipe.mjs`：配方规范化（分支/并行/有界重复/可选值/人工输入）与结论指纹。
- `src/preflight.mjs`：预检——逐可达路径核对输入来源与适配器能力，结论带步骤位置与改法。
- `src/runtime.mjs`：试运行与正式领取共用的步骤解释器，运行时强制重复上界。
- `src/localdata.mjs`：本地资料源实现；试运行令牌带 dry 标记，正式模式拒收。
- `src/dryrun.mjs`：试运行——只读本地资料源，写能力步骤一律跳过。
- `src/execute.mjs`：正式领取——核对结论新鲜度、拒绝试运行令牌、留痕到接收文件。
- `src/preview.mjs`：演示入口，串联预检、试运行、正式领取与失效核对。
- `fixtures/source.json` 与 `fixtures/controls.json`：本地供方资料（含实例配方）及可切换情形。
- `fixtures/pages.json`：本地翻页资料，试运行与正式领取共用的本地资料源。
- `docs/source.md`：接口和来源约定；`docs/preflight.md`：配方格式、检查码与改法、失效依据。
- `test`：预览、源端边界、接收文件完整性、预检、试运行、正式领取测试。

## 业务核对

以下情况均可独立观察，由对应测试与演示入口验证：

- 只有一条分支产生必需值：`missing-branch` 预检报 `maybe-value`，缺失路径标 ✗（`test/preflight.test.mjs`）。
- 并行结果类型不兼容：`parallel-mismatch` 预检报 `parallel-type-mismatch`（同上）。
- 重复步骤有明确上界：`unbounded-repeat` 预检报 `unbounded-repeat`；运行时达到上界条件仍成立会中止（`test/preflight.test.mjs`、`test/dryrun.test.mjs`）。
- 试运行拒绝外部写入能力：写能力步骤一律跳过且适配器不被调用，产物为 `withheld:` 占位（`test/dryrun.test.mjs`）。
- 配置改变后旧结论失效：指纹由配方内容、适配器能力、分析器版本三部分决定，任一部分变化即拒绝并说明是哪部分（`test/execute.test.mjs`，演示入口现场展示）。

新增行为在独立模块扩展，保留原有预览调用；源端模拟器只制造情形，不替接收器完成核对。

## 短时操作演示

从空 `var` 运行 `npm run demo`，依次展示：逐条配方预检（含分支遗漏、并行汇合、有界重复三个实例的检查解释）、`paged-collect` 的试运行与正式领取、试运行令牌被正式执行拒绝、配方变更后旧结论失效与重新预检。再运行 `npm test` 查看各环节边界。固定环境中的这两步应在 90 秒内完成。
