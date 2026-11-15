# 本地资料源约定

fixtures/source.json 定义配方及适配器能力。基础 singleStep 仅支持单步预览；预检、试运行与正式领取由 `src/preflight.mjs`、`src/dryrun.mjs`、`src/execute.mjs` 在接收侧独立完成，不由本地源替代。/api/action edit 改变配方配置版本（revision 2 中 paged-collect 的翻页上界变为 9），用于演示结论失效。正式领取与试运行不共享 seed/token 状态：试运行令牌带 dry 标记，正式执行拒收。

## 通用控制

`GET /api/snapshot` 查看当前原始源状态；`POST /api/action` 接收 JSON 对象 `{"action":"动作名"}`。可用动作：reset、edit。控制只改变模拟源，不代表接收器已经处理了变化。

所有资料均由本项目构造，包含的机构、设备、会话和文件仅供本地使用，不访问真实账号。浏览器操作应通过正常可见界面；测试用源控制接口不是业务采集捷径。

## 来源证据

源端请求记录只用于核查服务行为，接收器自身的审计、状态和输出需由扩展功能负责。源端重启会恢复默认资料，但本地接收文件不会自动清空。
