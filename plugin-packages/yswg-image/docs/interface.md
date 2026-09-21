# YSWG Image 接口说明

## 1. 协议身份

| 项目 | 值 |
| --- | --- |
| 插件 ID | `yswg-image` |
| Provider ID | `yswg-image` |
| 能力 | `image` |
| Base URL | `https://www.yswg.love` |
| 认证 | `Authorization: Bearer <YSWG Token>` |
| App ID | `2066371323654864898`，固定为 `npm`，不接受覆盖 |
| 创建 | `POST /prod-api/invocation/public/newapi/ai/invoke/tasks` |
| 查询 | `POST /prod-api/invocation/public/newapi/ai-gen-tasks/search` |
| 生命周期 | 异步图片任务 |

## 2. 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | `secret` | 是 | YSWG Token；对应 CLI 的 `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`YSWG_TOKEN` 或配置文件 token。 |

## 3. Provider 统一字段

| 字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `params.model` | 图片模型名称。默认 `gemini-3.1-flash-image-preview`。 |
| `prompt` | string | 是 | `params.prompt` | 提示词；使用模板时仍建议提供可读的展示提示词。 |
| `images` | media[] | 否 | `params.image` | 参考图。声明式 Provider 不负责把本地路径上传到 OSS；应传公开 URL 或 Data URL。 |
| `imageCount` | integer | 否 | `imageCount` | 单次 1–4 张。 |
| `aspectRatio` | string | 否 | `params.aspect_ratio` | `1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`5:4`、`4:5`、`21:9` 等。 |
| `providerOptions` | object | 否 | `providerOptions.yswg-image.*` | YSWG 专用扩展字段。 |

## 4. Provider 扩展字段

| 字段 | 类型 | CLI 对应 | 说明 |
| --- | --- | --- | --- |
| `groupId` | string | `--group-id` | 默认 `6`。 |
| `size` | string | `--size` | 直接写入 `params.size`；CLI 帮助文本列出该参数，具体取值由后端模型决定。 |
| `templateCode` | string | `--template-code` | AI 工具模板代码。 |
| `templateVars` | object | `--template-vars-json` | 模板变量 JSON 对象。 |
| `displayPrompt` | string | `--display-prompt` | 模板调用时显示给历史记录的提示词。 |
| `night` | boolean | `--night` | 写入 `isNightGenerate: true`，提交夜间错峰队列。 |

`appId` 不作为扩展字段开放，因为 CLI 明确固定使用 `npm` App。`noCompress`、`noAutoSwitch`、`timeout`、`out`、`dryRun` 和 `skipValidate` 是本机 CLI 的控制参数，不属于上游生成协议；它们不能通过声明式 Provider 的请求体直接复现。

## 5. 创建请求

### 5.1 HTTP

```text
POST /prod-api/invocation/public/newapi/ai/invoke/tasks
Content-Type: application/json
Authorization: Bearer <apiKey>
```

### 5.2 请求体

```json
{
  "appId": "2066371323654864898",
  "groupId": "6",
  "params": {
    "model": "gemini-3.1-flash-image-preview",
    "prompt": "一只可爱的白色兔子，粉色背景",
    "aspect_ratio": "1:1",
    "image": [
      "https://example.com/reference.png"
    ]
  },
  "imageCount": 1,
  "templates": [
    {
      "code": "tool_code",
      "params": {
        "color": "red"
      }
    }
  ],
  "displayPrompt": "AI 工具生成",
  "isNightGenerate": false
}
```

字段行为：

- `params.model` 来自统一 `request.model`，没有时使用 `gemini-3.1-flash-image-preview`。
- `params.prompt` 来自统一 `request.prompt`。
- `params.aspect_ratio` 默认 `1:1`。
- `params.image` 按 `images[].order` 排序，优先取 `url`、`dataUrl` 或 `value`。
- `imageCount` 默认 `1`，最大 `4`。
- 仅在有 `templateCode` 时发送 `templates`。
- 仅在有 `displayPrompt` 时发送 `displayPrompt`。
- 仅在启用 `night` 时发送 `isNightGenerate: true`。

### 5.3 CLI 原始用法

```bash
yswg-img generate --prompt "一只可爱的白色兔子，粉色背景" --json
yswg-img generate --prompt "电商产品图" --group-id 6 --model gemini-3.1-flash-image-preview --ratio 1:1 --count 4 --json
yswg-img generate --prompt "参考产品生成生活方式场景" --ref ./product.png,https://example.com/ref.jpg --out outputs --json
yswg-img generate --group-id 6 --template-code tool_code --template-vars-json "{\"color\":\"red\"}" --display-prompt "AI 工具生成" --dry-run --json
yswg-img generate --prompt "夜间批量任务" --night --json
```

CLI 会在提交前检查模型实时健康度：平均耗时超过 `90000ms` 或成功率低于 `80%` 时，默认尝试切换到健康模型。显式使用 `--no-auto-switch` 才会关闭这层逻辑；声明式 Provider 只提交清单中指定的模型，不复制本地模型缓存和自动切换流程。

## 6. 查询请求与响应映射

### 6.1 HTTP

```text
POST /prod-api/invocation/public/newapi/ai-gen-tasks/search
Content-Type: application/json
Authorization: Bearer <apiKey>
```

```json
{
  "current": 1,
  "size": 10,
  "appId": "2066371323654864898",
  "includeFailedRecords": true
}
```

声明式 Provider 每次轮询最近 10 条记录，并从返回页中暴露的首条记录路径读取状态和
`outPutFile` 图片 URL 数组，再将临时 URL 交给宿主下载和持久化。结果数组通过
`resultPaths` 直接交给宿主解析，不再使用字符串分割。由于声明式表达式不能可靠
复刻 CLI 对 `invokeTasks[].id/taskId` 的逐条本地筛选，这不是 CLI `tasks recover` 的完全等价实现。

- `data.records.0.outPutFile`
- `records.0.outPutFile`
- `data.list.0.outPutFile`
- `list.0.outPutFile`
- `outPutFile`

状态值兼容 CLI 任务状态和常见字符串：

| 上游值 | 统一状态 |
| --- | --- |
| `2`、`succeeded`、`success`、`completed`、`complete`、`done` | `succeeded` |
| `3`、`4`、`failed`、`failure`、`error` | `failed` |
| 其他或未返回 | `processing` |

> 兼容边界：声明式 Provider 每次轮询搜索最近 10 条记录，使用首条记录的兼容路径解析状态和结果；
> 它不包含 CLI 的 invoke task ID 本地筛选、WebSocket 推送竞速、CLI 本地图片下载和模型健康自动切换。若需要 CLI 的完整恢复行为，
> 仍应使用本机 `yswg-img tasks recover`。

## 7. CLI 全部命令面

### 7.1 帮助与版本

```text
yswg-img --help
yswg-img version --json
```

`version` 只读取本地 `@yswgaicx/yswg-img-cli` 的 `package.json`，不会检查 npm，也不会自动更新。

### 7.2 认证

```text
yswg-img auth status [--network] [--json]
yswg-img env [--host claude-code|codex] [--json]
```

Token 优先级：

1. `--token`
2. `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY`，顺序由宿主识别、`*_BASE_URL` 和 `--host` 决定
3. `YSWG_TOKEN`
4. `~/.yswg-img-cli/config.json` 的 `token`

`auth status` 不带 `--network` 只验证本地是否找到 Token；带 `--network` 才会调用模型权限接口验证 Token 是否能访问 `npm` App。Token 返回 401/403 时，CLI 会自动尝试其他候选 Token。

### 7.3 诊断

```text
yswg-img doctor [--network] [--json]
yswg-img doctor --explain <CODE> [--json]
```

本地诊断优先，不带 `--network` 不触发网络检查。已知诊断码：

- `NODE_VERSION_UNSUPPORTED`
- `CLI_NOT_IN_PATH`
- `TOKEN_MISSING`
- `CONFIG_INVALID`
- `BACKEND_UNREACHABLE`
- `BACKEND_UNAUTHORIZED`
- `TOKEN_SOURCE_MISMATCH`
- `INVALID_ARGUMENT`
- `SELF_UPDATE_FORBIDDEN`
- `CODEX_REVIEW_503`

### 7.4 模型与模板

```text
yswg-img models [--no-refresh] [--json]
yswg-img models refresh [--json]
yswg-img templates [--json]
```

`models` 返回 `{ models, cache }`。先看 `cache.stale`；只有 `cache.hasMetrics=true` 且 `cache.stale=false` 时，模型成功率和延迟才可用于回答。后端只返回近期有调用量的模型，列表不是完整模型目录。

模型默认值：

| 字段 | 默认值 |
| --- | --- |
| `groupId` | `6` |
| `model` | `gemini-3.1-flash-image-preview` |
| `ratio` | `1:1` |
| `count` | `1` |
| `stream.groupId` | `13` |

已知图灵模型分组映射：

| groupId | 实际模型 |
| --- | --- |
| `2046043157249933314` | `gpt-image-2` |
| `2046853405565095939` | `gpt-image-2-vip` |
| `2046853405565095940` | `gpt-image-2-vip` |

### 7.5 任务管理

```text
yswg-img tasks search [--size 10] [--keyword <text>] [--tab all|expiring1d|expiring2d|nightQueue] [--json]
yswg-img tasks get --id <record-id> [--json]
yswg-img tasks recover --task-id <invoke-task-id>[,<id>] [--out outputs] [--json]
yswg-img tasks cancel-night --id <record-id> [--json]
```

- `search` 固定只查询第一页，数量最大为 `10`。
- `tab=nightQueue` 使用状态 `3`。
- `tab=expiring1d` 查询未来 0–24 小时将过期的记录。
- `tab=expiring2d` 查询未来 24–48 小时将过期的记录。
- `get` 使用生成记录 ID。
- `recover` 使用 invoke task ID，在最近 10 条记录中寻找成功图片并下载。
- `cancel-night` 只取消夜间排队任务。
- CLI 不提供任务删除命令；删除必须在导航站页面操作。

### 7.6 Amazon ASIN

```text
yswg-img amazon asin <asin> [--max 7] [--json]
```

请求：

```text
GET /prod-api/invocation/public/newapi/amazon/asin/{asin}?max=7
```

返回 `asin`、`title`、`images`。`asin` 会被转成大写；`max` 必须是正数，默认 `7`。

### 7.7 文本/视觉 SSE

```text
yswg-img stream --prompt <text> [--group-id 13] [--conversation-id <id>] [--image-url <url,url>] [--params-json '{}'] [--template-code <code>] [--template-vars-json '{}'] [--json]
```

请求：

```text
POST /prod-api/invocation/public/newapi/ai/invoke/stream
Accept: text/event-stream
Content-Type: application/json
```

请求体结构：

```json
{
  "appId": "2066371323654864898",
  "groupId": "13",
  "conversationId": "conversation-id",
  "content": "分析这两张图片的差异",
  "imageUrls": [
    "https://example.com/a.png",
    "https://example.com/b.png"
  ],
  "params": {
    "temperature": 0.2
  },
  "templates": [
    {
      "code": "image_analyze",
      "params": {
        "tone": "short"
      }
    }
  ]
}
```

SSE 增量事件包含 `chunk`；最终汇总结果包含 `content`、`conversationId`、消息 ID 和可选 `usage`。当前影策生成 Provider 是图片能力，故不把 SSE 文本接口声明为同一个 Provider 的可执行能力；需要调用它时应直接使用 CLI。

## 8. 参考图上传与压缩

CLI `generate --ref` 对本地路径执行：

- 图片小于 `50 KB` 时原样保留；
- 最大缩放到 `1280×1280`；
- 无透明通道时转 JPEG，初始质量 `82`，最低质量 `50`，目标约 `300 KB`；
- 有透明通道时保留 PNG；
- HTTP/HTTPS URL 不上传，直接传给后端。

声明式 Provider 不执行本地文件读取和 OSS 临时 Token 上传。因此在画布或服务端调用中，参考图必须先变成资源 URL、公开 URL 或 Data URL。不要把本地路径字符串直接放入 `images`。

## 9. CLI 参数解析规则

- 有值参数必须写成 `--flag <value>` 或 `--flag=<value>`。
- 布尔开关包括 `--json`、`--network`、`--night`、`--no-refresh`、`--dry-run`、`--no-compress`、`--no-auto-switch`、`--skip-validate`。
- `--json=false` 可以关闭 JSON 输出。
- `--app-id` 和 `YSWG_APP_ID` 明确禁止使用。
- `duration`、`resolution`、视频开关属于已移除的视频参数，不应传给当前 CLI。
- 生成等待超时后不要重复提交同一提示词；优先使用 `tasks recover --task-id`。
- 输出图片只保留本地文件路径和摘要，不要把图片字节、Base64 或 `data:image/...` 粘贴到对话中。

## 10. 明确不支持的能力

- 没有 `video` 命令；视频模型会被拒绝。
- 没有 `upgrade`、`update`、`install`、`uninstall` 或自动更新能力。
- CLI 不会查询 npm 版本或下载自身。
- 不允许通过 CLI 删除生成记录。
- 本插件不把本地 OSS 上传、WebSocket 竞速、最近 10 条记录筛选和模型健康自动切换伪装成通用声明式 Provider 能力。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "yswg-image",
  "name": "YSWG Image",
  "version": "1.0.1",
  "author": "YSWG / 影策",
  "description": "通过 YSWG 天才猴子 CLI 的同一后端协议提供图片生成能力，并记录 CLI 的认证、模型、任务、ASIN 和流式接口。",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "YSWG API Token",
        "required": true,
        "description": "对应 yswg-img CLI 使用的 YSWG Token。"
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "yswg-image",
        "label": "YSWG Image",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://www.yswg.love",
        "requiresPublicMediaUrls": true,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "params.model",
            "description": "YSWG 图片模型名；默认模型为 gemini-3.1-flash-image-preview。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "params.prompt",
            "description": "图片提示词；使用模板时可由模板参数提供。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "params.image",
            "description": "参考图 URL 或 Data URL；声明式 Provider 要求输入已可被上游访问。"
          },
          {
            "name": "imageCount",
            "type": "integer",
            "required": false,
            "mapping": "imageCount",
            "description": "一次生成数量，CLI 支持 1 到 4。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "params.aspect_ratio",
            "description": "图片比例，例如 1:1、3:2、2:3、4:3、3:4、16:9、9:16、5:4、4:5、21:9。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "YSWG provider options",
            "description": "使用 providerOptions.yswg-image 传 groupId、size、模板、夜间队列等协议扩展。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$and": [
                {
                  "$gt": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.output.count"
                        },
                        {
                          "$ref": "request.imageCount"
                        },
                        1
                      ]
                    },
                    0
                  ]
                },
                {
                  "$lte": [
                    {
                      "$coalesce": [
                        {
                          "$ref": "request.output.count"
                        },
                        {
                          "$ref": "request.imageCount"
                        },
                        1
                      ]
                    },
                    4
                  ]
                }
              ]
            },
            "message": "YSWG 单次图片生成数量必须是 1 到 4。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/prod-api/invocation/public/newapi/ai/invoke/tasks",
          "originPath": true,
          "contentType": "application/json",
          "body": {
            "appId": "2066371323654864898",
            "groupId": {
              "$coalesce": [
                {
                  "$ref": "request.providerOptions.yswg-image.groupId"
                },
                "6"
              ]
            },
            "params": {
              "model": {
                "$coalesce": [
                  {
                    "$ref": "request.model"
                  },
                  "gemini-3.1-flash-image-preview"
                ]
              },
              "prompt": {
                "$omitEmpty": {
                  "$ref": "request.prompt"
                }
              },
              "aspect_ratio": {
                "$coalesce": [
                  {
                    "$ref": "request.aspectRatio"
                  },
                  "1:1"
                ]
              },
              "image": {
                "$omitEmpty": {
                  "$map": {
                    "from": {
                      "$sortByOrder": {
                        "$ref": "request.images"
                      }
                    },
                    "as": "media",
                    "in": {
                      "$coalesce": [
                        {
                          "$ref": "media.url"
                        },
                        {
                          "$ref": "media.dataUrl"
                        },
                        {
                          "$ref": "media.value"
                        }
                      ]
                    }
                  }
                }
              },
              "size": {
                "$omitEmpty": {
                  "$ref": "request.providerOptions.yswg-image.size"
                }
              }
            },
            "imageCount": {
              "$coalesce": [
                {
                  "$ref": "request.output.count"
                },
                {
                  "$ref": "request.imageCount"
                },
                1
              ]
            },
            "templates": {
              "$omitEmpty": {
                "$if": {
                  "condition": {
                    "$ref": "request.providerOptions.yswg-image.templateCode"
                  },
                  "then": [
                    {
                      "code": {
                        "$ref": "request.providerOptions.yswg-image.templateCode"
                      },
                      "params": {
                        "$coalesce": [
                          {
                            "$ref": "request.providerOptions.yswg-image.templateVars"
                          },
                          {}
                        ]
                      }
                    }
                  ],
                  "else": null
                }
              }
            },
            "displayPrompt": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.yswg-image.displayPrompt"
              }
            },
            "isNightGenerate": {
              "$ref": "request.providerOptions.yswg-image.night"
            }
          }
        },
        "poll": {
          "method": "POST",
          "path": "/prod-api/invocation/public/newapi/ai-gen-tasks/search",
          "originPath": true,
          "contentType": "application/json",
          "body": {
            "current": 1,
            "size": 10,
            "appId": "2066371323654864898",
            "includeFailedRecords": true
          }
        },
        "response": {
          "taskIdPaths": [
            "data.0",
            "data.0.id",
            "data.0.taskId",
            "data.0.task_id",
            "data.taskId",
            "data.task_id",
            "data.id",
            "taskId",
            "task_id",
            "id"
          ],
          "messagePaths": [
            "data.records.0.invokeTasks.0.failReason",
            "data.list.0.invokeTasks.0.failReason",
            "records.0.invokeTasks.0.failReason",
            "list.0.invokeTasks.0.failReason",
            "data.failReason",
            "failReason",
            "message",
            "error.message"
          ],
          "resultKind": "image",
          "resultEphemeral": true,
          "errorPaths": [
            "error.code",
            "data.records.0.invokeTasks.0.failReason",
            "data.list.0.invokeTasks.0.failReason",
            "records.0.invokeTasks.0.failReason",
            "list.0.invokeTasks.0.failReason"
          ],
          "statusPaths": [
            "data.records.0.invokeTasks.0.status",
            "data.list.0.invokeTasks.0.status",
            "records.0.invokeTasks.0.status",
            "list.0.invokeTasks.0.status",
            "status"
          ],
          "resultPaths": [
            "data.records.0.outPutFile",
            "data.list.0.outPutFile",
            "records.0.outPutFile",
            "list.0.outPutFile",
            "outPutFile"
          ]
        }
      }
    ],
    "workflows": [
      {
        "id": "yswg-image-generate",
        "label": "YSWG 图片生成",
        "providerId": "yswg-image",
        "capability": "image",
        "parameters": [
          {
            "name": "groupId",
            "type": "string",
            "required": false,
            "description": "模型分组 ID；默认 6。"
          },
          {
            "name": "model",
            "type": "string",
            "required": true,
            "description": "模型名；默认 gemini-3.1-flash-image-preview。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "description": "图片提示词。"
          },
          {
            "name": "ratio",
            "type": "string",
            "required": false,
            "values": [
              "1:1",
              "3:2",
              "2:3",
              "4:3",
              "3:4",
              "16:9",
              "9:16",
              "5:4",
              "4:5",
              "21:9"
            ],
            "description": "输出宽高比。"
          },
          {
            "name": "count",
            "type": "integer",
            "required": false,
            "description": "一次生成 1 到 4 张。"
          },
          {
            "name": "referenceImages",
            "type": "media[]",
            "required": false,
            "description": "参考图片。"
          },
          {
            "name": "templateCode",
            "type": "string",
            "required": false,
            "description": "AI 工具模板代码。"
          },
          {
            "name": "templateVars",
            "type": "object",
            "required": false,
            "description": "模板变量对象。"
          },
          {
            "name": "night",
            "type": "boolean",
            "required": false,
            "description": "是否提交到夜间错峰队列。"
          }
        ],
        "defaults": {
          "groupId": "6",
          "model": "gemini-3.1-flash-image-preview",
          "ratio": "1:1",
          "count": 1
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
