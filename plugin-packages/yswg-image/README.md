# YSWG Image

这是一个 `yingce.plugin/v2` 图片协议插件，依据本机 `yswg-img` CLI 的源码和帮助文本整理。

## 能力边界

- Provider：`yswg-image`，提供 YSWG 图片生成任务提交与结果查询。
- Workflow：`yswg-image-generate`，声明模型、提示词、比例、数量、参考图和模板参数。
- 文档覆盖 CLI 的认证、诊断、模型、模板、ASIN、任务管理和文本/视觉流式接口。
- `yswg-img` 当前不提供视频生成；本插件不会声明视频能力。

完整接口见 [docs/interface.md](docs/interface.md)。
