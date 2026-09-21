# Xinhankr Wan Video

这是 Xinhankr（可美视频 AI）万相视频接口的影策系统内置协议插件。

## 能力

- 文生视频
- 图生视频：单图首帧、双图首尾帧
- 多图参考生视频
- 图片、视频、音频多模态参考
- 文件和网页链接参考

## 配置

只需要配置 `apiKey`，填写 Xinhankr 控制台生成的 API Token。

插件使用固定官方 Base URL：

```text
https://token.xinhankr.com
```

这是系统内置协议，不需要上传插件包。修改插件包后，重启后端或重新构建镜像才会刷新官方插件注册表。

完整字段和请求响应映射见 [docs/interface.md](docs/interface.md)。
