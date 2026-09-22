import React, { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

import { subscribeCanvasNodeDragPreview, type CanvasNodeDragPreview } from "@/lib/canvas/canvas-live-viewport";

import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT, storyboardTableHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { batchReferenceHandleY } from "@/lib/canvas/canvas-batch-table";
import type { CanvasConnection, CanvasDisplayConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

type ConnectionPathElements = { visual: SVGPathElement | null; hit: SVGPathElement | null };

/**
 * 连线层：常态和拖节点都由这一层 SVG 负责。
 *
 * 这里刻意不做渲染介质切换。之前常态走 SVG、拖节点切到 Leafer canvas，两层即便逐像素对齐，
 * 接管的那一帧仍会留下可见跳变——按一下节点就能看到整块画布的连线闪一次。
 * 现在改成拖拽时直接改受影响连线的 `d`：被拖节点连着的线通常只有个位数，
 * 逐帧改这几条比整层 canvas 重绘更省，也没有切换可言。
 */
export function CanvasConnectionLayer({
    containerRef,
    bounds,
    displayConnections,
    scriptScrollTopById,
    selectedConnectionId,
    onSelect,
    onContextMenu,
}: {
    containerRef: RefObject<HTMLDivElement | null>;
    bounds: { left: number; top: number; width: number; height: number };
    displayConnections: CanvasDisplayConnection[];
    scriptScrollTopById: Record<string, number>;
    selectedConnectionId: string | null;
    onSelect: (connectionId: string) => void;
    onContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
}) {
    const svgRef = useRef<SVGSVGElement>(null);
    const connectionsRef = useRef(displayConnections);
    connectionsRef.current = displayConnections;
    const scrollTopRef = useRef(scriptScrollTopById);
    scrollTopRef.current = scriptScrollTopById;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        // 一次拖拽只扫一遍 DOM：逐帧按 id 查询的成本会随画布连线总数线性上升。
        let elements: Map<string, ConnectionPathElements> | null = null;
        const touched = new Set<string>();

        return subscribeCanvasNodeDragPreview(container, (preview) => {
            if (!preview) {
                // 位移不到拖拽阈值时不会提交新坐标，React 也就不会重渲染，
                // 手动写进去的 d 必须自己还原，否则连线会停在偏移后的位置。
                if (elements) writeDraggedConnectionPaths(elements, touched, connectionsRef.current, scrollTopRef.current, null);
                elements = null;
                touched.clear();
                return;
            }
            if (!elements) elements = collectConnectionPathElements(svgRef.current);
            writeDraggedConnectionPaths(elements, touched, connectionsRef.current, scrollTopRef.current, preview);
        });
    }, [containerRef]);

    return (
        <svg
            ref={svgRef}
            className="absolute overflow-visible"
            viewBox={`${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`}
            style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, pointerEvents: "none", zIndex: 0 }}
        >
            {displayConnections.map(({ connection, from, to }) => (
                <ConnectionPath
                    key={connection.id}
                    connection={connection}
                    from={from}
                    to={to}
                    fromScrollTop={scriptScrollTopById[from.id] || 0}
                    toScrollTop={scriptScrollTopById[to.id] || 0}
                    active={selectedConnectionId === connection.id}
                    onSelect={() => onSelect(connection.id)}
                    onContextMenu={(event) => onContextMenu(event, connection.id)}
                />
            ))}
        </svg>
    );
}

function collectConnectionPathElements(svg: SVGSVGElement | null) {
    const elements = new Map<string, ConnectionPathElements>();
    if (!svg) return elements;
    const entryOf = (id: string) => {
        const existing = elements.get(id);
        if (existing) return existing;
        const created: ConnectionPathElements = { visual: null, hit: null };
        elements.set(id, created);
        return created;
    };
    svg.querySelectorAll<SVGPathElement>("[data-connection-visual]").forEach((element) => {
        const id = element.dataset.connectionVisual;
        if (id) entryOf(id).visual = element;
    });
    svg.querySelectorAll<SVGPathElement>("[data-connection-id]").forEach((element) => {
        const id = element.dataset.connectionId;
        if (id) entryOf(id).hit = element;
    });
    return elements;
}

/**
 * 把拖拽偏移写进受影响连线的两条路径。命中区要跟着一起改，
 * 否则松手前指针判定还停在旧位置。`preview` 为空表示收尾，按提交坐标写回。
 */
function writeDraggedConnectionPaths(
    elements: Map<string, ConnectionPathElements>,
    touched: Set<string>,
    connections: CanvasDisplayConnection[],
    scriptScrollTopById: Record<string, number>,
    preview: CanvasNodeDragPreview | null,
) {
    for (const { connection, from, to } of connections) {
        const fromMoved = Boolean(preview?.nodeIds.has(from.id));
        const toMoved = Boolean(preview?.nodeIds.has(to.id));
        if (preview ? !fromMoved && !toMoved : !touched.has(connection.id)) continue;
        const target = elements.get(connection.id);
        if (!target) continue;
        const { pathD } = canvasConnectionPath(
            connection,
            preview && fromMoved ? offsetConnectionNode(from, preview) : from,
            preview && toMoved ? offsetConnectionNode(to, preview) : to,
            scriptScrollTopById[from.id] || 0,
            scriptScrollTopById[to.id] || 0,
        );
        target.visual?.setAttribute("d", pathD);
        target.hit?.setAttribute("d", pathD);
        if (preview) touched.add(connection.id);
    }
}

function offsetConnectionNode(node: CanvasNodeData, preview: CanvasNodeDragPreview) {
    if (preview.x === 0 && preview.y === 0) return node;
    return { ...node, position: { x: node.position.x + preview.x, y: node.position.y + preview.y } };
}

export const ConnectionPath = React.memo(function ConnectionPath({
    connection,
    from,
    to,
    fromScrollTop = 0,
    toScrollTop = 0,
    active,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    fromScrollTop?: number;
    toScrollTop?: number;
    active: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const [hovered, setHovered] = useState(false);
    const { pathD } = canvasConnectionPath(connection, from, to, fromScrollTop, toScrollTop);
    const emphasized = active || hovered;
    const markerId = `canvas-connection-arrow-${connection.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    return (
        <g>
            <defs>
                <marker id={markerId} markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 10 4 L 0 8 Z" fill={theme.node.muted} />
                </marker>
            </defs>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                vectorEffect="non-scaling-stroke"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            <path
                data-connection-visual={connection.id}
                d={pathD}
                stroke={theme.node.muted}
                strokeWidth={emphasized ? 2.8 : 2}
                vectorEffect="non-scaling-stroke"
                strokeOpacity={0.9}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd={`url(#${markerId})`}
                style={{ pointerEvents: "none" }}
            />
        </g>
    );
}, (previous, next) => previous.connection === next.connection && previous.from === next.from && previous.to === next.to && previous.active === next.active && previous.fromScrollTop === next.fromScrollTop && previous.toScrollTop === next.toScrollTop);

export function canvasConnectionPath(connection: CanvasConnection, from: CanvasNodeData, to: CanvasNodeData, fromScrollTop = 0, toScrollTop = 0) {
    const startX = from.position.x + from.width;
    const startY = connectionHandleY(from, connection.fromHandleId, fromScrollTop);
    const endX = to.position.x;
    const endY = connectionHandleY(to, connection.toHandleId, toScrollTop);
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    return { pathD: `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`, startX, startY, endX, endY };
}

export function activeConnectionPath(node: CanvasNodeData | undefined, handle: ConnectionHandle, mouseWorld: Position, target?: CanvasNodeData, nodeScrollTop = 0) {
    if (!node) return "";
    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? connectionHandleY(node, handle.handleId, nodeScrollTop) : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : connectionHandleY(node, handle.handleId, nodeScrollTop);
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? connectionHandleY(target) : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? connectionHandleY(target) : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    return `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;
}

/**
 * 连线在节点上的接入 Y。
 *
 * 单端口的一侧（左右各一个出入口，除分镜脚本外都是）**永远取边的正中**：
 * 之前按鼠标落点比例取 Y，多条线接同一个端口就会沿着边散开，视觉上像节点有很多端口。
 * 真正的多端口只存在于分镜脚本的 `row:` 句柄；普通节点始终连接到边缘
 * 垂直中心，避免同一个节点因鼠标落点产生漂移的“伪端口”。
 */
export function connectionHandleY(node: CanvasNodeData, handleId?: string, scrollTop = 0) {
    const batchY = batchReferenceHandleY(node, handleId);
    if (batchY !== undefined) return batchY;
    if (handleId === "storyboard:context") return node.position.y + node.height - (node.metadata?.storyboardComposerHeight || 104) / 2;
    if (!handleId?.startsWith("row:")) return node.position.y + node.height / 2;
    const rowId = handleId.slice(4);
    const index = (node.metadata?.storyboard?.rows || []).findIndex((row) => row.id === rowId);
    if (index < 0) return node.position.y + node.height / 2;
    const tableHeight = storyboardTableHeight(node.height, node.metadata?.storyboardComposerHeight);
    const localY = Math.min(Math.max(index * STORYBOARD_ROW_HEIGHT + STORYBOARD_ROW_HEIGHT / 2 - scrollTop, 4), tableHeight - 4);
    return node.position.y + STORYBOARD_HEADER_HEIGHT + localY;
}
