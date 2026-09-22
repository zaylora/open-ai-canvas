import { useLayoutEffect, useRef, type RefObject } from "react";
import { Group, Leafer, Path, Rect } from "leafer-ui";

import { activeConnectionPath, canvasConnectionPath } from "@/components/canvas/canvas-connections";
import type { CanvasBatchConnectionPreview } from "@/lib/canvas/canvas-batch-connection";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasNodeDragPreview, subscribeCanvasSelectionPreview, type CanvasNodeDragPreview } from "@/lib/canvas/canvas-live-viewport";
import { calculateCanvasPreviewTransform, sameCanvasViewport, shouldRebaseCanvasRaster } from "@/lib/canvas/canvas-leafer-viewport";
import { offsetSelectedNodeBounds } from "@/lib/canvas/canvas-selection";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasDisplayConnection, CanvasNodeData, ConnectionHandle, Position, SelectionBox, ViewportTransform } from "@/types/canvas";

type NodeBounds = { left: number; top: number; width: number; height: number; count: number } | null;

type CanvasLeaferGraphicsLayerProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    theme: CanvasTheme;
    displayConnections: CanvasDisplayConnection[];
    selectedConnectionId: string | null;
    scriptScrollTopById: Record<string, number>;
    connectingParams: ConnectionHandle | null;
    batchConnectionPreview: CanvasBatchConnectionPreview | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    connectionTargetAnchorRatio?: number;
    nodeById: Map<string, CanvasNodeData>;
    selectionBox: SelectionBox | null;
    selectedNodeBounds: NodeBounds;
    alignmentGuides: { vertical?: number; horizontal?: number };
};

type LeaferScene = {
    leafer: Leafer;
    world: Group;
    host: HTMLDivElement;
};

type UnderlayScene = LeaferScene & {
    connections: Group;
    connectionEntries: Map<string, ConnectionSceneEntry>;
    connectionIdsByNodeId: Map<string, Set<string>>;
    dragPreview: CanvasNodeDragPreview | null;
    dragPreviewConnectionIds: Set<string>;
};

type ConnectionSceneEntry = {
    path: Path;
    arrow: Path;
    connection: CanvasDisplayConnection["connection"];
    from: CanvasNodeData;
    to: CanvasNodeData;
    signature: string;
};

type OverlayScene = LeaferScene & {
    selection: Rect;
    selectionBounds: Rect;
    guides: Path;
    draft: Path;
    draftArrow: Path;
    batchDrafts: Group;
    dragPreview: CanvasNodeDragPreview | null;
};

export function CanvasLeaferGraphicsLayer(props: CanvasLeaferGraphicsLayerProps) {
    const underlayHostRef = useRef<HTMLDivElement>(null);
    const overlayHostRef = useRef<HTMLDivElement>(null);
    const underlayRef = useRef<UnderlayScene | null>(null);
    const overlayRef = useRef<OverlayScene | null>(null);
    const viewportRef = useRef(props.viewport);
    const rasterViewportRef = useRef(props.viewport);
    const propsRef = useRef(props);
    propsRef.current = props;

    useLayoutEffect(() => {
        const underlayHost = underlayHostRef.current;
        const overlayHost = overlayHostRef.current;
        // 子组件 layout effect 可能早于父层 ref 对外可见，host 的直接父元素才是此刻最可靠的画布容器。
        const container = (props.containerRef.current || underlayHost?.parentElement) as HTMLDivElement | null;
        if (!underlayHost || !overlayHost || !container) return;

        const underlay = createUnderlayScene(underlayHost);
        const overlay = createOverlayScene(overlayHost);
        underlayRef.current = underlay;
        overlayRef.current = overlay;

        // 容器尺寸由 ResizeObserver 维护。视口预览回调原先每次都 getBoundingClientRect，
        // 而它跑在 rAF 里、样式又是脏的，等于一次平移里十几次强制同步布局；而且预览分支
        // 根本用不到这个尺寸。
        const containerSize = { width: 1, height: 1 };
        const resize = () => {
            const rect = container.getBoundingClientRect();
            // 取整：rect 的亚像素抖动会让 leafer 认定尺寸变化并重建 backing store，
            // canvas 内容随之清空，平移中就会看到连线闪一下。
            containerSize.width = Math.max(1, Math.round(rect.width));
            containerSize.height = Math.max(1, Math.round(rect.height));
            const size = { width: containerSize.width, height: containerSize.height, pixelRatio: canvasPixelRatio() };
            underlay.leafer.resize(size);
            overlay.leafer.resize(size);
            syncViewport(rasterViewportRef.current, size.width, size.height, underlay, overlay, propsRef.current);
            if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
                applyScenePreview(viewportRef.current, rasterViewportRef.current, underlay, overlay);
            }
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        window.addEventListener("resize", resize);
        const unsubscribe = subscribeCanvasGraphicsViewportPreview(container, (next) => {
            viewportRef.current = next;
            if (isViewportPreview(container, next, rasterViewportRef.current)) {
                if (shouldRebaseCanvasRaster(next, rasterViewportRef.current)) {
                    syncViewport(next, containerSize.width, containerSize.height, underlay, overlay, propsRef.current);
                    rasterViewportRef.current = next;
                    forceSceneRender(underlay, overlay);
                    resetScenePreview(underlay, overlay);
                    return;
                }
                applyScenePreview(next, rasterViewportRef.current, underlay, overlay);
                return;
            }
            resetScenePreview(underlay, overlay);
            if (sameCanvasViewport(next, rasterViewportRef.current)) return;
            syncViewport(next, containerSize.width, containerSize.height, underlay, overlay, propsRef.current);
            rasterViewportRef.current = next;
            // host 的合成变换刚被清掉，场景必须当场画完，否则会露出一帧旧栅格。
            forceSceneRender(underlay, overlay);
        });
        const unsubscribeSelection = subscribeCanvasSelectionPreview(container, (selection) => {
            syncSelection(overlay.selection, selection, propsRef.current.theme);
        });
        const unsubscribeNodeDrag = subscribeCanvasNodeDragPreview(container, (preview) => {
            // 连线常态由世界层里的 SVG 画，这层只在拖节点时接手逐帧同步。用 visibility 而不是
            // display 切换，保住合成层，拖拽起手那一帧就有内容。
            underlay.host.style.visibility = preview ? "visible" : "hidden";
            applyConnectionDragPreview(underlay, propsRef.current, preview);
            overlay.dragPreview = preview;
            syncLiveSelectionBounds(overlay, propsRef.current, viewportRef.current.k);
        });
        resize();

        return () => {
            unsubscribe();
            unsubscribeSelection();
            unsubscribeNodeDrag();
            resizeObserver.disconnect();
            window.removeEventListener("resize", resize);
            underlay.leafer.destroy(true);
            overlay.leafer.destroy(true);
            underlayRef.current = null;
            overlayRef.current = null;
        };
    }, [props.containerRef]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        if (!underlay) return;
        rebuildConnections(underlay, props);
    }, [props.displayConnections, props.scriptScrollTopById, props.selectedConnectionId, props.theme]);

    useLayoutEffect(() => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        syncOverlayContent(overlay, props, viewportRef.current.k);
    }, [props.batchConnectionPreview, props.connectingParams, props.connectionTargetAnchorRatio, props.connectionTargetNodeId, props.mouseWorld, props.nodeById, props.scriptScrollTopById, props.selectedNodeBounds, props.selectionBox, props.theme]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!underlay || !overlay || !container) return;
        viewportRef.current = props.viewport;
        const rect = container.getBoundingClientRect();
        const hadPreview = hasScenePreview(underlay, overlay);
        if (hadPreview || !sameCanvasViewport(props.viewport, rasterViewportRef.current)) {
            syncViewport(props.viewport, rect.width, rect.height, underlay, overlay, props);
        }
        rasterViewportRef.current = props.viewport;
        // 新视口先同步到真实 DPR backing store，再撤销交互期的合成变换，避免出现跳帧。
        if (hadPreview) forceSceneRender(underlay, overlay);
        resetScenePreview(underlay, overlay);
    }, [props.containerRef, props.viewport]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!underlay || !overlay || !container) return;
        const rect = container.getBoundingClientRect();
        syncViewport(rasterViewportRef.current, rect.width, rect.height, underlay, overlay, props);
        if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
            applyScenePreview(viewportRef.current, rasterViewportRef.current, underlay, overlay);
        }
    }, [props.alignmentGuides, props.containerRef, props.theme]);

    return (
        <>
            <div ref={underlayHostRef} data-canvas-leafer-underlay className="pointer-events-none absolute inset-0 z-0 overflow-hidden" style={{ visibility: "hidden" }} aria-hidden />
            <div ref={overlayHostRef} data-canvas-leafer-overlay className="pointer-events-none absolute inset-0 z-[var(--z-canvas-overlay)] overflow-hidden" aria-hidden />
        </>
    );
}

function createUnderlayScene(host: HTMLDivElement): UnderlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const connections = new Group({ hittable: false });
    world.add(connections);
    leafer.add(world);
    return { leafer, world, host, connections, connectionEntries: new Map(), connectionIdsByNodeId: new Map(), dragPreview: null, dragPreviewConnectionIds: new Set() };
}

function createOverlayScene(host: HTMLDivElement): OverlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const selection = new Rect({ visible: false, hittable: false });
    const selectionBounds = new Rect({ visible: false, hittable: false, fill: "transparent" });
    const guides = new Path({ visible: false, hittable: false });
    const draft = new Path({ visible: false, hittable: false });
    const draftArrow = new Path({ visible: false, hittable: false });
    const batchDrafts = new Group({ visible: false, hittable: false });
    world.add(selection);
    world.add(selectionBounds);
    world.add(guides);
    world.add(draft);
    world.add(draftArrow);
    world.add(batchDrafts);
    leafer.add(world);
    return { leafer, world, host, selection, selectionBounds, guides, draft, draftArrow, batchDrafts, dragPreview: null };
}

function rebuildConnections(scene: UnderlayScene, props: CanvasLeaferGraphicsLayerProps) {
    const nextIds = new Set(props.displayConnections.map(({ connection }) => connection.id));
    for (const [connectionId, entry] of scene.connectionEntries) {
        if (nextIds.has(connectionId)) continue;
        entry.path.remove();
        entry.arrow.remove();
        scene.connectionEntries.delete(connectionId);
    }

    scene.connectionIdsByNodeId.clear();
    const previewIds = scene.dragPreview ? scene.dragPreview.nodeIds : null;
    for (const { connection, from, to } of props.displayConnections) {
        const emphasized = props.selectedConnectionId === connection.id;
        const signature = connectionSceneSignature(connection, from, to, props, emphasized);
        let entry = scene.connectionEntries.get(connection.id);
        if (!entry) {
            const path = new Path({ hittable: false });
            const arrow = new Path({ hittable: false });
            scene.connections.add(path);
            scene.connections.add(arrow);
            entry = { path, arrow, connection, from, to, signature: "" };
            scene.connectionEntries.set(connection.id, entry);
        }
        entry.connection = connection;
        entry.from = from;
        entry.to = to;
        if (entry.signature !== signature || scene.dragPreview) {
            syncConnectionPath(entry, props, scene.dragPreview, previewIds);
            entry.signature = signature;
        }
        for (const nodeId of [from.id, to.id]) {
            const connectionIds = scene.connectionIdsByNodeId.get(nodeId) || new Set<string>();
            connectionIds.add(connection.id);
            scene.connectionIdsByNodeId.set(nodeId, connectionIds);
        }
    }

    scene.dragPreviewConnectionIds = collectPreviewConnectionIds(scene, scene.dragPreview);
}

function connectionSceneSignature(connection: CanvasDisplayConnection["connection"], from: CanvasNodeData, to: CanvasNodeData, props: CanvasLeaferGraphicsLayerProps, emphasized: boolean) {
    return [
        connection.id,
        connection.fromNodeId,
        connection.toNodeId,
        connection.fromHandleId || "",
        connection.toHandleId || "",
        from.id,
        from.position.x,
        from.position.y,
        from.width,
        from.height,
        to.id,
        to.position.x,
        to.position.y,
        to.width,
        to.height,
        props.scriptScrollTopById[from.id] || 0,
        props.scriptScrollTopById[to.id] || 0,
        emphasized ? "active" : "idle",
        props.theme.accent.primary,
        props.theme.node.muted,
    ].join("|");
}

function syncConnectionPath(entry: ConnectionSceneEntry, props: CanvasLeaferGraphicsLayerProps, preview: CanvasNodeDragPreview | null, previewIds: ReadonlySet<string> | null = preview?.nodeIds || null) {
    const from = translatePreviewNode(entry.from, previewIds, preview);
    const to = translatePreviewNode(entry.to, previewIds, preview);
    const emphasized = props.selectedConnectionId === entry.connection.id;
    const connectionPath = canvasConnectionPath(entry.connection, from, to, props.scriptScrollTopById[entry.from.id] || 0, props.scriptScrollTopById[entry.to.id] || 0);
    entry.path.set({
        path: connectionPath.pathD,
        stroke: emphasized ? props.theme.accent.primary : props.theme.node.muted,
        strokeWidth: emphasized ? 2.8 : 2,
        strokeScaleFixed: true,
        strokeCap: "round",
        opacity: emphasized ? 0.95 : 0.8,
        hittable: false,
    });
    entry.arrow.set({
        path: connectionArrowPath({ x: connectionPath.endX, y: connectionPath.endY }),
        fill: props.theme.node.muted,
        stroke: props.theme.node.muted,
        strokeWidth: 0,
        opacity: emphasized ? 0.95 : 0.9,
        hittable: false,
    });
}

function translatePreviewNode(node: CanvasNodeData, previewIds: ReadonlySet<string> | null, preview: CanvasNodeDragPreview | null) {
    if (!preview || !previewIds?.has(node.id) || (preview.x === 0 && preview.y === 0)) return node;
    return { ...node, position: { x: node.position.x + preview.x, y: node.position.y + preview.y } };
}

function collectPreviewConnectionIds(scene: UnderlayScene, preview: CanvasNodeDragPreview | null) {
    const connectionIds = new Set<string>();
    if (!preview) return connectionIds;
    for (const nodeId of preview.nodeIds) {
        scene.connectionIdsByNodeId.get(nodeId)?.forEach((connectionId) => connectionIds.add(connectionId));
    }
    return connectionIds;
}

function applyConnectionDragPreview(scene: UnderlayScene, props: CanvasLeaferGraphicsLayerProps, preview: CanvasNodeDragPreview | null) {
    const affectedConnectionIds = new Set(scene.dragPreviewConnectionIds);
    const previewIds = preview?.nodeIds || null;
    collectPreviewConnectionIds(scene, preview).forEach((connectionId) => affectedConnectionIds.add(connectionId));
    scene.dragPreview = preview;
    scene.dragPreviewConnectionIds = collectPreviewConnectionIds(scene, preview);
    for (const connectionId of affectedConnectionIds) {
        const entry = scene.connectionEntries.get(connectionId);
        if (!entry) continue;
        syncConnectionPath(entry, props, preview, previewIds);
    }
}

function syncOverlayContent(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const selection = props.selectionBox;
    scene.selection.visible = Boolean(selection);
    if (selection) {
        syncSelection(scene.selection, selection, props.theme);
    }

    const bounds = props.selectedNodeBounds;
    scene.selectionBounds.visible = Boolean(bounds && !selection);
    if (bounds && !selection) {
        syncSelectionBounds(scene.selectionBounds, liveSelectedNodeBounds(bounds, scene.dragPreview), viewportScale);
        scene.selectionBounds.stroke = props.theme.node.label;
    }

    const connecting = props.connectingParams;
    scene.draft.visible = Boolean(connecting);
    scene.draftArrow.visible = Boolean(connecting);
    if (connecting) {
        const source = props.nodeById.get(connecting.nodeId);
        const target = props.connectionTargetNodeId ? props.nodeById.get(props.connectionTargetNodeId) : undefined;
        scene.draft.set({
            path: activeConnectionPath(
                source,
                connecting,
                props.mouseWorld,
                target,
                props.scriptScrollTopById[connecting.nodeId] || 0,
            ),
            stroke: props.theme.node.muted,
            strokeCap: "round",
            strokeWidth: 2,
            strokeScaleFixed: true,
            opacity: 0.9,
        });
        scene.draftArrow.set({
            path: connectionArrowPath(activeConnectionEndpoint(connecting, props.mouseWorld, target)),
            fill: props.theme.node.muted,
            stroke: props.theme.node.muted,
            strokeWidth: 0,
            opacity: 0.9,
        });
    }

    scene.batchDrafts.removeAll(true);
    const batch = props.batchConnectionPreview;
    scene.batchDrafts.visible = Boolean(batch);
    if (!batch) return;
    const target = batch.targetNodeId ? props.nodeById.get(batch.targetNodeId) : undefined;
    const stroke = batch.status === "invalid" ? props.theme.accent.danger : batch.status === "partial" ? props.theme.node.activeStroke : props.theme.accent.primary;
    batch.sourceNodeIds.forEach((sourceNodeId) => {
        const source = props.nodeById.get(sourceNodeId);
        if (!source) return;
        const handle: ConnectionHandle = { nodeId: source.id, handleType: "source" };
        scene.batchDrafts.add(new Path({
            path: activeConnectionPath(source, handle, batch.mouseWorld, target, props.scriptScrollTopById[source.id] || 0),
            stroke,
            strokeWidth: 1.4,
            strokeScaleFixed: true,
            strokeCap: "round",
            dashPattern: [8, 8],
            opacity: 0.72,
            hittable: false,
        }));
    });
}

function syncSelection(rect: Rect, selection: SelectionBox, theme: CanvasTheme) {
    rect.set({
        x: Math.min(selection.startWorldX, selection.currentWorldX),
        y: Math.min(selection.startWorldY, selection.currentWorldY),
        width: Math.abs(selection.currentWorldX - selection.startWorldX),
        height: Math.abs(selection.currentWorldY - selection.startWorldY),
        fill: "transparent",
        stroke: theme.node.label,
        opacity: selection.hitMode === "intersect" ? 0.82 : 0.68,
    });
}

function syncViewport(viewport: ViewportTransform, width: number, height: number, underlay: UnderlayScene, overlay: OverlayScene, props: CanvasLeaferGraphicsLayerProps) {
    const scale = Math.max(viewport.k, 0.05);
    for (const scene of [underlay, overlay]) scene.world.set({ x: viewport.x, y: viewport.y, scaleX: scale, scaleY: scale });

    overlay.selection.set({
        strokeWidth: 1 / scale,
        cornerRadius: 2 / scale,
        dashPattern: [4 / scale, 4 / scale],
    });
    if (props.selectedNodeBounds) syncSelectionBounds(overlay.selectionBounds, liveSelectedNodeBounds(props.selectedNodeBounds, overlay.dragPreview), scale);
    overlay.selectionBounds.set({
        strokeWidth: 1 / scale,
        cornerRadius: 2 / scale,
        dashPattern: [4 / scale, 4 / scale],
        opacity: 0.68,
    });
    // 线宽由 syncOverlayContent 以 strokeScaleFixed 固定成屏幕像素，这里只折算虚线节距；
    // 再写一次 strokeWidth 会和那一侧互相覆盖，草稿线粗细就会随缩放跳变。
    overlay.draft.set({ dashPattern: [8 / scale, 8 / scale] });
    overlay.guides.set({
        visible: typeof props.alignmentGuides.vertical === "number" || typeof props.alignmentGuides.horizontal === "number",
        path: guidePath(viewport, width, height, props.alignmentGuides),
        stroke: props.theme.accent.primary,
        strokeWidth: 1 / scale,
        dashPattern: [5 / scale, 5 / scale],
        opacity: 0.72,
    });
}

function connectionArrowPath(point: Position) {
    const size = 9;
    const half = 5;
    return `M ${point.x} ${point.y} L ${point.x - size} ${point.y - half} L ${point.x - size} ${point.y + half} Z`;
}

function activeConnectionEndpoint(handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData) {
    if (handle.handleType === "source" && target) {
        return { x: target.position.x, y: target.position.y + target.height / 2 };
    }
    return mouseWorld;
}

function isViewportPreview(container: HTMLDivElement, viewport: ViewportTransform, rasterViewport: ViewportTransform) {
    return container.dataset.canvasViewportInteracting === "true" && !sameCanvasViewport(viewport, rasterViewport);
}

function applyScenePreview(viewport: ViewportTransform, rasterViewport: ViewportTransform, ...scenes: LeaferScene[]) {
    // 将已栅格画面的屏幕坐标映射到实时视口，缩放手势期间不触碰 Leafer 场景树。
    const { ratio, x, y } = calculateCanvasPreviewTransform(viewport, rasterViewport);
    for (const scene of scenes) {
        scene.host.style.transformOrigin = "0 0";
        scene.host.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
        scene.host.style.willChange = "transform";
        scene.host.dataset.canvasLeaferPreview = "true";
    }
}

function hasScenePreview(...scenes: LeaferScene[]) {
    return scenes.some((scene) => scene.host.dataset.canvasLeaferPreview === "true");
}

function resetScenePreview(...scenes: LeaferScene[]) {
    for (const scene of scenes) {
        scene.host.style.transform = "";
        scene.host.style.transformOrigin = "";
        // will-change 不清：图形层每次平移都要用它，反复设/清会让合成层来回创建销毁。
        delete scene.host.dataset.canvasLeaferPreview;
    }
}

function forceSceneRender(...scenes: LeaferScene[]) {
    for (const scene of scenes) scene.leafer.forceRender(undefined, true);
}

function liveSelectedNodeBounds(bounds: NonNullable<NodeBounds>, preview: CanvasNodeDragPreview | null) {
    return offsetSelectedNodeBounds(bounds, preview);
}

function syncLiveSelectionBounds(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const bounds = props.selectedNodeBounds;
    const selection = props.selectionBox;
    scene.selectionBounds.visible = Boolean(bounds && !selection);
    if (!bounds || selection) return;
    syncSelectionBounds(scene.selectionBounds, liveSelectedNodeBounds(bounds, scene.dragPreview), viewportScale);
    scene.selectionBounds.stroke = props.theme.node.label;
}

function syncSelectionBounds(rect: Rect, bounds: NonNullable<NodeBounds>, viewportScale: number) {
    const padding = 12 / Math.max(viewportScale, 0.05);
    rect.set({
        x: bounds.left - padding,
        y: bounds.top - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
    });
}

function guidePath(viewport: ViewportTransform, width: number, height: number, guides: { vertical?: number; horizontal?: number }) {
    const scale = Math.max(viewport.k, 0.05);
    const left = -viewport.x / scale;
    const top = -viewport.y / scale;
    const right = left + width / scale;
    const bottom = top + height / scale;
    const commands: string[] = [];
    if (typeof guides.vertical === "number") commands.push(`M ${guides.vertical} ${top} L ${guides.vertical} ${bottom}`);
    if (typeof guides.horizontal === "number") commands.push(`M ${left} ${guides.horizontal} L ${right} ${guides.horizontal}`);
    return commands.join(" ");
}

function canvasPixelRatio() {
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}
