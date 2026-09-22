# 无限画布性能问题修复记录

**日期：** 2026-09-22  
**问题：** 节点连线闪烁、画布移动卡顿

## 一、问题原因

1. 连线 SVG 的 `left/top/width/height/viewBox` 随视口变化，平移过程中反复触发布局。
2. 画布拖拽热路径中的 `screenToCanvas()` 反复调用 `getBoundingClientRect()`，可能造成强制同步布局。
3. 节点拖拽预览会改变连线包围盒，导致连线 SVG 布局尺寸变化。
4. 世界层平移时重复写入相同的缩放 CSS 变量。
5. 世界层和节点包含 `backdrop-filter`、`box-shadow`、动画等高成本绘制效果。
6. Leafer 图形层尺寸更新存在亚像素变化和重复布局读取风险。
7. FluidOrb 动画曾在每帧读取 `clientWidth/clientHeight`。

## 二、已完成修改

### 1. 世界层合成优化

- 平移时使用 `translate3d()`。
- 纯平移期间保持世界层合成状态。
- 只有缩放提交后才重新按最终倍率排版。
- 平移期间关闭部分高成本绘制：
  - `backdrop-filter`
  - `box-shadow`
  - `transition`
  - 连线流光动画

涉及文件：

- `web/src/components/canvas/infinite-canvas.tsx`
- `web/src/lib/canvas/canvas-live-viewport.ts`
- `web/src/styles/globals.css`

### 2. 连线 SVG 布局稳定

- 连线层边界不再根据 viewport 计算。
- 改为根据当前连线内容包围盒计算。
- 节点拖拽期间冻结 `connectionLayerBounds`。
- 拖拽时只更新连线路径，不改变 SVG 布局盒子。

涉及文件：

- `web/src/pages/canvas/use-canvas-render-model.ts`
- `web/src/pages/canvas/canvas-project-world-layers.tsx`
- `web/src/components/canvas/canvas-leafer-graphics-layer.tsx`

### 3. 坐标转换热路径优化

- 使用 `ResizeObserver` 缓存画布容器矩形。
- `screenToCanvas()` 和 `getCanvasCenter()` 使用缓存数据。
- 拖拽、框选、连线预览过程中不再重复调用 `getBoundingClientRect()`。

涉及文件：

- `web/src/pages/canvas/use-canvas-viewport-controller.ts`

### 4. 减少无效样式写入

- `--canvas-live-scale` 仅在缩放值变化时更新。
- `--canvas-live-inverse-scale` 仅在逆缩放值变化时更新。
- 平移时主要更新世界层 `transform`。

涉及文件：

- `web/src/lib/canvas/canvas-live-viewport.ts`

### 5. 媒体和动画绘制优化

- 图片资源被视口放行后记忆资源地址，避免节点重挂时退回占位图。
- 移除部分节点标签上的 `backdrop-filter`。
- FluidOrb 使用 `ResizeObserver` 获取尺寸。
- FluidOrb 在不可见或页面切后台时暂停动画帧。
- Leafer 容器尺寸取整，减少 backing store 重建。

涉及文件：

- `web/src/components/canvas/canvas-node-content.tsx`
- `web/src/components/canvas/canvas-node.tsx`
- `web/src/components/ui/fluid-orb.tsx`
- `web/src/components/canvas/canvas-leafer-graphics-layer.tsx`
- `web/src/lib/canvas/canvas-performance-mode.ts`

## 三、测试与验证

已完成：

- `git diff --check` 通过。
- 新增 `web/test/canvas-paint-cost.test.ts`，覆盖：
  - 世界层合成状态
  - 连线 SVG 边界稳定
  - Leafer 布局读取
  - FluidOrb 尺寸缓存
  - 图片资源放行记忆
  - 画布矩形缓存
  - CSS 变量重复写入保护

当前限制：

- 项目 `pretest` 会递归触发 Bun 测试，在当前 Windows 环境出现 `AssignProcessToJobObject` 错误。
- 当前工作区没有可用的本地 `tsc` 二进制，未完成 TypeScript 类型检查。
- 未启动开发服务，未完成真实浏览器 Performance 录制。

## 四、待浏览器验收

- [ ] 拖动单节点时不再出现明显卡顿。
- [ ] 拖动多选节点时连线与节点保持同步。
- [ ] 平移画布时连线不闪烁、不消失、不跳位。
- [ ] 节点滑入视口时不出现空白或灰色占位闪烁。
- [ ] 图片节点重挂后不退回占位图。
- [ ] 拖拽期间 Performance 面板不再出现连续强制布局。
- [ ] 触控板平移、鼠标平移和缩放后拖拽均正常。
- [ ] 缩放结束后文字和图片保持清晰。

## 五、相关文档

- `docs/content/docs/progress/pending-test.mdx`
- `影策画布性能问题分析.md`
