import { CanvasNodeType, type CanvasMediaPerformanceMode, type CanvasNodeData } from "@/types/canvas";

const STORAGE_KEY = "canvas-media-performance-mode";

// The DOM budget is deliberately below the connection budget. Image-heavy
// canvases pay a texture/compositing cost per mounted card, even when the
// cards themselves are already virtualized spatially.
export const CANVAS_MAX_RENDERED_NODES = 720;
export const CANVAS_MAX_RENDERED_CONNECTIONS = 5000;

export function readCanvasMediaPerformanceMode(): CanvasMediaPerformanceMode {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === "quality" || stored === "performance" ? stored : "auto";
    } catch {
        return "auto";
    }
}

export function persistCanvasMediaPerformanceMode(mode: CanvasMediaPerformanceMode) {
    try {
        window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // 浏览器禁用本地存储时保留当前会话内的选择。
    }
}

export function shouldReduceCanvasMediaEffects(mode: CanvasMediaPerformanceMode, nodes: CanvasNodeData[]) {
    if (mode === "performance") return true;
    if (mode === "quality") return false;
    const mediaCount = nodes.filter((node) => node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio).length;
    return nodes.length >= 80 || mediaCount >= 32;
}

/**
 * 超过这个节点数才按视口裁剪 DOM。
 * 裁剪范围跟着 viewport 变化，平移和缩放时节点会不断进出渲染集合，React 因此反复
 * 卸载重挂节点与连线——图片要重新解码，动画和播放状态也会被打断。节点不多时这点
 * DOM 成本远低于重建成本，所以小画布直接全量渲染。
 * 阈值刻意远低于 CANVAS_MAX_RENDERED_NODES：预算是渲染上限，这里是「值得裁剪」的下限。
 */
const CANVAS_VIRTUALIZE_NODE_THRESHOLD = 240;

/**
 * 是否按视口裁剪节点和连线。
 * quality 模式完全关闭裁剪（用户明确选择画面稳定优先），performance 模式始终裁剪，
 * auto 只在节点数超过阈值时裁剪。
 */
export function shouldVirtualizeCanvasNodes(mode: CanvasMediaPerformanceMode, nodes: CanvasNodeData[]) {
    if (mode === "quality") return false;
    if (mode === "performance") return true;
    return nodes.length > CANVAS_VIRTUALIZE_NODE_THRESHOLD;
}

export function canvasNodeRenderPadding(reduceMediaEffects: boolean, previouslyRendered: boolean) {
    if (previouslyRendered) return reduceMediaEffects ? 640 : 384;
    return reduceMediaEffects ? 128 : 192;
}

export function canvasNodeRenderBudget(scale: number) {
    if (scale < 0.14) return 280;
    if (scale < 0.28) return 420;
    return CANVAS_MAX_RENDERED_NODES;
}

export function resolveActiveCanvasMediaNodeId(selectedNodeIds: ReadonlySet<string>, nodeById: ReadonlyMap<string, CanvasNodeData>) {
    if (selectedNodeIds.size !== 1) return null;
    const nodeId = selectedNodeIds.values().next().value;
    if (!nodeId) return null;
    const type = nodeById.get(nodeId)?.type;
    return type === CanvasNodeType.Video || type === CanvasNodeType.Audio ? nodeId : null;
}
