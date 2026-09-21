# Xinhankr Wan Video 接口说明

## 1. 协议身份

| 项目 | 值 |
| --- | --- |
| 插件 ID | `xinhankr-wan-video` |
| Provider ID | `xinhankr-wan-video` |
| 能力 | `video` |
| Base URL | `https://token.xinhankr.com` |
| 鉴权 | `Authorization: Bearer <apiKey>` |
| 创建 | `POST /v1/video/generations` |
| 查询 | `GET /v1/video/generations/{{taskId}}` |
| 示例模型 | `wan3.0-video` |

## 2. 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | `secret` | 是 | Xinhankr API Token |

## 3. 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 模型 ID，文档示例为 `wan3.0-video`。 |
| `prompt` | string | 是 | 视频文本提示词。 |
| `images` | media[] | 否 | 图片输入。 |
| `videos` | media[] | 否 | 参考视频。 |
| `audios` | media[] | 否 | 参考音频，不能作为唯一参考素材。 |
| `duration` | integer | 否 | 时长秒数，默认 `5`。 |
| `aspectRatio` | string | 否 | 画幅比例，映射为 `ratio`。 |
| `resolution` | string | 否 | `720P`、`1080P` 等，映射为 `resolution`。 |
| `providerOptions` | object | 否 | Xinhankr 扩展字段命名空间。 |

`providerOptions.xinhankr-wan-video` 支持：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `files` | array | 参考文件 URL，映射到顶层 `files`。 |
| `links` | array | 参考网页 URL，映射到顶层 `links`。 |
| `size` | string | 分辨率别名，优先于统一字段 `resolution`。 |
| `ratio` | string | 画幅比例别名，优先于统一字段 `aspectRatio`。 |

## 4. 图片角色规则

图片可以是 URL 字符串，也可以是带 `url` 和 `role` 的对象。影策统一请求会转换为：

```json
{
  "url": "https://example.com/frame.png",
  "role": "first_frame"
}
```

显式角色：

- `first_frame`：首帧
- `last_frame`：尾帧
- `reference_image`：普通参考图

没有显式角色时，插件按照文档规则补充：

- 1 张图：`first_frame`
- 2 张图：按顺序为 `first_frame`、`last_frame`
- 3 张及以上：全部为 `reference_image`

首尾帧不能与 `reference_image`、`file`、`link` 等参考类素材混用。声明式插件会保留角色；具体业务限制由上游返回错误。

## 5. 创建请求

```http
POST https://token.xinhankr.com/v1/video/generations
Authorization: Bearer <apiKey>
Content-Type: application/json
```

文生视频示例：

```json
{
  "model": "wan3.0-video",
  "prompt": "一只金毛寻回犬在金色秋叶中奔跑，电影感慢镜头，阳光穿透树林",
  "resolution": "1080P",
  "ratio": "16:9",
  "duration": 5
}
```

首尾帧示例：

```json
{
  "model": "wan3.0-video",
  "prompt": "镜头缓慢推进，人物自然转身，光影连贯",
  "images": [
    {
      "url": "https://example.com/first.png",
      "role": "first_frame"
    },
    {
      "url": "https://example.com/last.png",
      "role": "last_frame"
    }
  ],
  "resolution": "720P",
  "duration": 5
}
```

多模态参考示例：

```json
{
  "model": "wan3.0-video",
  "prompt": "角色动作跟随参考视频，口型与参考音频一致",
  "images": [
    {
      "url": "https://example.com/character.png",
      "role": "reference_image"
    }
  ],
  "videos": [
    "https://example.com/motion_ref.mp4"
  ],
  "audios": [
    "https://example.com/voice_ref.mp3"
  ],
  "resolution": "1080P",
  "duration": 5
}
```

文件和网页链接通过插件扩展字段传递，最终映射为：

```json
{
  "files": [
    "https://example.com/brief.pdf"
  ],
  "links": [
    "https://example.com/product-page"
  ]
}
```

## 6. 轮询请求和响应

```http
GET https://token.xinhankr.com/v1/video/generations/video_task_001
Authorization: Bearer <apiKey>
```

提交响应示例：

```json
{
  "id": "video_task_001",
  "task_id": "video_task_001",
  "status": "pending"
}
```

完成响应示例：

```json
{
  "id": "video_task_001",
  "status": "completed",
  "data": [
    {
      "url": "https://example.com/output/wan_video.mp4"
    }
  ]
}
```

响应映射：

| 统一结果 | 上游路径 |
| --- | --- |
| 任务 ID | `data.task_id`、`data.taskId`、`task_id`、`taskId`、`data.id`、`id` |
| 状态 | `status`、`state`、`data.status` |
| 错误消息 | `error.message`、`message`、`fail_reason`、`data.message` |
| 视频结果 | `data[].url` 及兼容的视频 URL 字段 |
| 错误码 | `error.code`、`code` |

返回的视频 URL 标记为临时媒体，宿主会负责下载并持久化。

## 7. 官方文档中的其他协议说明

快速开始文档还说明了以下兼容鉴权方式：

- `Authorization: Bearer <Token>`：推荐方式，也是本插件使用的方式。
- `X-Goog-Api-Key: <Token>`：Google 原生协议兼容方式，本视频插件不使用。
- URL `?key=<Token>`：受限环境透传方式，本插件不使用，以避免把密钥写入 URL。

文档还列出 DashScope 原生视频路由，但那是另一套协议，不属于本插件：

- `POST /api/v1/services/aigc/video-generation/video-synthesis`
- `GET /api/v1/tasks/{task_id}`

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "xinhankr-wan-video",
  "name": "Xinhankr Wan Video",
  "version": "1.0.0",
  "author": "Xinhankr / 影策",
  "description": "Xinhankr 可美视频 AI 的万相视频 OpenAI 兼容协议插件。",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "Xinhankr API Token",
        "required": true,
        "description": "可美视频 AI 控制台生成的 API Token。"
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "xinhankr-wan-video",
        "label": "Xinhankr Wan Video",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "https://token.xinhankr.com",
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
            "mapping": "model",
            "description": "视频模型 ID；文档示例使用 wan3.0-video。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt",
            "description": "视频文本提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "images",
            "description": "图片输入；支持首帧、尾帧和参考图角色。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "mapping": "videos",
            "description": "参考视频；默认角色为 reference_video。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "mapping": "audios",
            "description": "参考音频；默认角色为 reference_audio，不能作为唯一参考素材。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration",
            "description": "视频时长，单位为秒，默认 5。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "ratio",
            "description": "画幅比例，例如 16:9、9:16、1:1。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "resolution/size",
            "description": "分辨率档位，例如 720P、1080P。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "files/links/size/ratio",
            "description": "Xinhankr 专用扩展；支持 files、links、size、ratio。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/video/generations",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "images": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "url": {
                      "$ref": "media.value"
                    },
                    "role": {
                      "$coalesce": [
                        {
                          "$ref": "media.role"
                        },
                        {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$len": {
                                        "$ref": "request.images"
                                      }
                                    },
                                    1
                                  ]
                                },
                                "then": "first_frame"
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$len": {
                                        "$ref": "request.images"
                                      }
                                    },
                                    2
                                  ]
                                },
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$eq": [
                                        {
                                          "$ref": "mediaIndex"
                                        },
                                        0
                                      ]
                                    },
                                    "then": "first_frame",
                                    "else": "last_frame"
                                  }
                                }
                              }
                            ],
                            "default": "reference_image"
                          }
                        }
                      ]
                    }
                  }
                }
              }
            },
            "videos": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.videos"
                    }
                  },
                  "as": "media",
                  "in": {
                    "url": {
                      "$ref": "media.value"
                    },
                    "role": {
                      "$coalesce": [
                        {
                          "$ref": "media.role"
                        },
                        "reference_video"
                      ]
                    }
                  }
                }
              }
            },
            "audios": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.audios"
                    }
                  },
                  "as": "media",
                  "in": {
                    "url": {
                      "$ref": "media.value"
                    },
                    "role": {
                      "$coalesce": [
                        {
                          "$ref": "media.role"
                        },
                        "reference_audio"
                      ]
                    }
                  }
                }
              }
            },
            "files": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.xinhankr-wan-video.files"
              }
            },
            "links": {
              "$omitEmpty": {
                "$ref": "request.providerOptions.xinhankr-wan-video.links"
              }
            },
            "resolution": {
              "$omitEmpty": {
                "$upper": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.xinhankr-wan-video.size"
                    },
                    {
                      "$ref": "request.resolution"
                    }
                  ]
                }
              }
            },
            "ratio": {
              "$omitEmpty": {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.xinhankr-wan-video.ratio"
                  },
                  {
                    "$ref": "request.aspectRatio"
                  }
                ]
              }
            },
            "duration": {
              "$coalesce": [
                {
                  "$ref": "request.duration"
                },
                5
              ]
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/video/generations/{{taskId}}",
          "contentType": "application/json"
        },
        "response": {
          "taskIdPaths": [
            "data.task_id",
            "data.taskId",
            "task_id",
            "taskId",
            "data.id",
            "id"
          ],
          "statusPaths": [
            "status",
            "state",
            "data.status"
          ],
          "messagePaths": [
            "error.message",
            "message",
            "fail_reason",
            "data.message"
          ],
          "errorPaths": [
            "error.code",
            "code"
          ],
          "resultPaths": [
            "data"
          ],
          "resultKind": "video",
          "resultEphemeral": true
        }
      }
    ],
    "workflows": [
      {
        "id": "xinhankr-wan-video-generate",
        "label": "Xinhankr 万相视频生成",
        "providerId": "xinhankr-wan-video",
        "capability": "video",
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "description": "模型 ID，默认示例为 wan3.0-video。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "description": "首帧、首尾帧或多图参考。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "required": false,
            "description": "参考视频。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "required": false,
            "description": "参考音频。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "description": "时长秒数。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "values": [
              "720P",
              "1080P"
            ],
            "description": "分辨率。"
          },
          {
            "name": "ratio",
            "type": "string",
            "required": false,
            "values": [
              "16:9",
              "9:16",
              "1:1"
            ],
            "description": "画幅比例。"
          },
          {
            "name": "files",
            "type": "array",
            "required": false,
            "description": "参考文件 URL；通过 providerOptions.xinhankr-wan-video.files 传递。"
          },
          {
            "name": "links",
            "type": "array",
            "required": false,
            "description": "参考网页 URL；通过 providerOptions.xinhankr-wan-video.links 传递。"
          }
        ],
        "defaults": {
          "model": "wan3.0-video",
          "duration": 5,
          "resolution": "1080P",
          "ratio": "16:9"
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
