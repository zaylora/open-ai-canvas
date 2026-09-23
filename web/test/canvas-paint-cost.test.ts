import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const globalStylesSource = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");
const infiniteCanvasSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/infinite-canvas.tsx"), "utf8");
const liveViewportSource = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-live-viewport.ts"), "utf8");
const leaferLayerSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-leafer-graphics-layer.tsx"), "utf8");
const renderModelSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-render-model.ts"), "utf8");
const viewportControllerSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-viewport-controller.ts"), "utf8");
const canvasNodeSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node.tsx"), "utf8");
const canvasNodeContentSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node-content.tsx"), "utf8");
const fluidOrbSource = readFileSync(resolve(import.meta.dir, "../src/components/ui/fluid-orb.tsx"), "utf8");

describe("平移期间的绘制降级", () => {
    test("世界层内部在交互期关掉 backdrop-filter、box-shadow 和过渡", () => {
        const rule = globalStylesSource.match(/\[data-canvas-viewport-interacting="true"\] \.canvas-world-layer :where\(\*\) \{[\s\S]*?\}/)?.[0] || "";
        expect(rule).toContain("backdrop-filter: none !important;");
        expect(rule).toContain("box-shadow: none !important;");
        expect(rule).toContain("transition: none !important;");
    });

    test("不引入 contain: paint —— 实测它给每个节点各建一层，反而更慢", () => {
        expect(globalStylesSource).not.toMatch(/\.canvas-node-shell[^{]*\{[^}]*contain:\s*paint/);
        expect(globalStylesSource).not.toMatch(/\.canvas-world-layer[^{]*\{[^}]*contain:\s*paint/);
    });

    test("两处常驻角标不再用 backdrop-filter（背景本就近乎不透明）", () => {
        expect(canvasNodeSource).not.toMatch(/rounded-md border px-1\.5 py-1[^"]*backdrop-blur/);
        expect(canvasNodeContentSource).not.toMatch(/ml-auto max-w-full shrink-0 truncate[^"]*backdrop-blur/);
    });
});

describe("世界层合成态", () => {
    test("倍率不变就保持合成层，只有缩放提交才降级", () => {
        expect(infiniteCanvasSource).toContain('if (committedScaleRef.current === viewport.k) container.dataset.canvasViewportComposited = "true";');
        expect(infiniteCanvasSource).toContain("else delete container.dataset.canvasViewportComposited;");
        expect(globalStylesSource).toMatch(/\[data-canvas-viewport-interacting="true"\] \.canvas-world-layer,\s*\r?\n\s*\[data-canvas-viewport-composited="true"\] \.canvas-world-layer \{/);
    });

    test("will-change 跟着合成态走而不是交互态", () => {
        expect(liveViewportSource).toContain('const composited = container.dataset.canvasViewportInteracting === "true" || container.dataset.canvasViewportComposited === "true";');
        expect(liveViewportSource).toContain('worldLayer.style.willChange = composited ? "transform" : "";');
    });
});

describe("连线层不再用布局属性跟随视口", () => {
    test("SVG 范围只由连线内容决定，与 viewport 无关", () => {
        const bounds = renderModelSource.match(/const connectionLayerBounds = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] || "";
        expect(bounds).toContain("if (displayConnections.length === 0) return CONNECTION_LAYER_EMPTY_BOUNDS;");
        expect(bounds).not.toContain("viewport.x");
        expect(bounds).not.toContain("viewport.y");
        expect(bounds).not.toContain("viewport.k");
        expect(bounds).not.toContain("viewportSize");
        // dragPreview 是下一条用例那个“冻结布局盒子”的依赖，不是视口量，留在这里不违反本用例的意图。
        expect(bounds.trimEnd().endsWith("}, [displayConnections, dragPreview]);")).toBe(true);
    });

    test("节点拖拽期间冻结 SVG 布局盒子", () => {
        expect(renderModelSource).toContain("if (dragPreview) return connectionLayerBoundsRef.current;");
        expect(renderModelSource).toContain("connectionLayerBoundsRef.current = next;");
    });
});

describe("坐标转换热路径不读取布局", () => {
    test("screenToCanvas 使用缓存矩形，连线交互开始前主动刷新", () => {
        const screenToCanvas = viewportControllerSource.match(/const screenToCanvas = useCallback\([\s\S]*?\n    \}, \[viewportRef\]\);/)?.[0] || "";
        expect(screenToCanvas).toContain("const rect = canvasRectRef.current;");
        expect(screenToCanvas).not.toContain("getBoundingClientRect");
        expect(viewportControllerSource).toContain("const resizeObserver = new ResizeObserver(updateRect);");
        expect(viewportControllerSource).toContain("const refreshCanvasRect = useCallback");
    });
});

describe("视口预览避免重复样式写入", () => {
    test("缩放 CSS 变量只在数值变化时更新", () => {
        expect(liveViewportSource).toContain("if (elements.liveScale !== viewport.k)");
        expect(liveViewportSource).toContain("if (elements.liveInverseScale !== inverseScale)");
    });
});

describe("图形层不再逐帧强制同步布局", () => {
    test("视口预览回调不读 getBoundingClientRect", () => {
        const subscribe = leaferLayerSource.match(/subscribeCanvasGraphicsViewportPreview\(container, \(next\) => \{[\s\S]*?\n {8}\}\);/)?.[0] || "";
        expect(subscribe).not.toBe("");
        expect(subscribe).not.toContain("getBoundingClientRect");
        expect(subscribe).toContain("containerSize.width");
    });

    test("容器尺寸取整，避免亚像素抖动重建 canvas backing store", () => {
        expect(leaferLayerSource).toContain("containerSize.width = Math.max(1, Math.round(rect.width));");
        expect(leaferLayerSource).toContain("containerSize.height = Math.max(1, Math.round(rect.height));");
    });

    test("撤销预览变换时不清 will-change", () => {
        const reset = leaferLayerSource.match(/function resetScenePreview[\s\S]*?\r?\n\}/)?.[0] || "";
        expect(reset).toContain('scene.host.style.transform = "";');
        expect(reset).not.toContain("willChange");
    });
});

describe("连线跟随世界层，不靠视口大小的 canvas", () => {
    const worldLayersSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-project-world-layers.tsx"), "utf8");
    const connectionsSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-connections.tsx"), "utf8");

    test("连线全程由世界层 SVG 画，不切换渲染介质", () => {
        // 曾经常态走 SVG、拖节点切 Leafer canvas。两层即便逐像素对齐，接管那一帧仍留下可见跳变，
        // 按一下节点就能看到整块画布的连线闪一次。这两个开关是那套切换的残留，不能回来。
        expect(worldLayersSource).toContain("<CanvasConnectionLayer");
        expect(connectionsSource).not.toContain("visualMode");
        expect(connectionsSource).not.toContain("hideVisual");
    });

    test("拖节点时 SVG 自己逐帧改 d，命中区跟着一起动", () => {
        expect(connectionsSource).toContain("subscribeCanvasNodeDragPreview(container,");
        expect(connectionsSource).toContain('target.visual?.setAttribute("d", pathD);');
        // 命中区不跟着改，松手前指针判定会停在旧位置
        expect(connectionsSource).toContain('target.hit?.setAttribute("d", pathD);');
    });

    test("Leafer 图形层只剩浮层，不再画连线", () => {
        expect(leaferLayerSource).not.toContain("underlay");
        expect(leaferLayerSource).not.toContain("rebuildConnections");
    });
});

describe("图片不因节点重挂退回占位", () => {
    test("放行过的资源地址被记住，重挂直接给 url", () => {
        expect(canvasNodeContentSource).toContain("const ready = eager || Boolean(rememberedUrl);");
        expect(canvasNodeContentSource).toContain("rememberResourceUrl(storageKey, resolved.url, resolved.imageWidth);");
    });

    test("不再叠浏览器自己的 loading=lazy", () => {
        expect(canvasNodeContentSource).not.toContain('loading="lazy"');
        expect(canvasNodeContentSource).not.toContain('loading="eager"');
    });
});

describe("发光球不再每帧读布局", () => {
    test("尺寸由 ResizeObserver 推送，rAF 里不读 clientWidth/clientHeight", () => {
        const render = fluidOrbSource.match(/const render = \(now: number\) => \{[\s\S]*?\n {12}\};/)?.[0] || "";
        expect(render).not.toBe("");
        expect(render).not.toContain("clientWidth");
        expect(render).not.toContain("clientHeight");
        expect(fluidOrbSource).toContain("const resizeObserver = new ResizeObserver(");
    });

    test("不可见或页面切后台时停掉 rAF", () => {
        expect(fluidOrbSource).toContain("const visibilityObserver = new IntersectionObserver(");
        expect(fluidOrbSource).toContain("if (!onScreen || document.hidden) return;");
        expect(fluidOrbSource).toContain('document.addEventListener("visibilitychange", updateMotion);');
        expect(fluidOrbSource).toContain("visibilityObserver.disconnect();");
    });
});
