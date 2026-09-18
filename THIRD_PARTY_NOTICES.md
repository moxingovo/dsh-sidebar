# Third-party notices

本扩展(**dsh-webview / DSH Web Panel**)的运行时**不打包任何第三方依赖**:
扩展宿主只用 Node.js 内置模块(`http` / `child_process` / `crypto` 等),
webview 前端为自写代码,CSS 仅使用 VS Code 主题变量。因此本扩展自身不
再分发任何第三方代码。

说明与致谢:

- **DeepSeek Harness**(https://github.com/deepseek-ai/deepseek-harness)
  - 本扩展通过其公开的 HTTP/WebSocket 服务协议(基线 0.1.0-rc.5)与之交互,
    不包含、不修改、不重新分发其代码;
  - 其商标与版权归 DeepSeek 及贡献者所有;
  - 协议映射记录见 [docs/protocol.md](docs/protocol.md)。

- **DeepSeek 标志(logo)**
  - 面板与扩展图标使用 DeepSeek Harness 网页端 favicon 的路径形状;
  - 版权与商标归杭州深度求索人工智能基础技术研究有限公司所有;
  - 仅用于标识 DeepSeek Harness,不代表其对本社区扩展的任何背书。

- **jsdom**(https://github.com/jsdom/jsdom)
  - 仅作为**开发/测试期**依赖(`test/ui-smoke/`),不进入发布包;
  - License: MIT。

其余图标、文案与代码均为本仓库原创或按 MIT 许可随仓库分发。
