import { useEffect, useMemo, useRef } from "react";

import { buildNodeGenerationInputs, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { sameNodeSemanticData } from "@/lib/canvas/canvas-project-domain";
import { canvasNodeRenderBudget, canvasNodeRenderPadding, CANVAS_MAX_RENDERED_CONNECTIONS, shouldReduceCanvasMediaEffects, shouldVirtualizeCanvasNodes } from "@/lib/canvas/canvas-performance-mode";
import { buildCanvasNodeMentionReferenceMap, buildCanvasResourceReferences, buildToolMentionReference, parseToolMentionTokens } from "@/lib/canvas/canvas-resource-references";
import { buildSkillMentionReferences } from "@/lib/canvas/canvas-skill-mentions";
import { buildCanvasSpatialIndex, canvasNodeBounds, type CanvasSpatialIndex, type CanvasSpatialIndexEntry } from "@/lib/canvas/canvas-spatial-index";
import type { Skill } from "@/services/api/skills";
import type { Asset, ImageAsset } from "@/stores/use-asset-store";
import type { DirectorScene } from "@/types/director";
import { CanvasNodeType, type CanvasConnection, type CanvasDisplayConnection, type CanvasMediaPerformanceMode, type CanvasNodeData, type ContextMenuState, type ViewportTransform } from "@/types/canvas";

type DragPreview = { x: number; y: number; nodeIds: Set<string> } | null;

type UseCanvasRenderModelOptions = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    assets: Asset[];
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    mediaPerformanceMode: CanvasMediaPerformanceMode;
    selectedNodeIds: Set<string>;
    hoveredNodeId: string | null;
    dragPreview: DragPreview;
    collapsingBatchIds: Set<string>;
    addedSkills: Skill[];
    directorScenes?: DirectorScene[];
    infoNodeId: string | null;
    cropNodeId: string | null;
    maskEditNodeId: string | null;
    imageEditNodeId: string | null;
    annotationNodeId: string | null;
    splitNodeId: string | null;
    upscaleNodeId: string | null;
    superResolveNodeId: string | null;
    angleNodeId: string | null;
    lightingNodeId: string | null;
    emotionNodeId: string | null;
    previewNodeId: string | null;
    contextMenu: ContextMenuState | null;
    versionCompareRootId: string | null;
    directorNodeId: string | null;
    scriptEditorNodeId: string | null;
    dialogNodeId: string | null;
};

/** 没有连线时的占位范围，常量引用避免每次重算都换掉 SVG 的布局属性。 */
const CONNECTION_LAYER_EMPTY_BOUNDS = { left: 0, top: 0, width: 2, height: 2 } as const;

/** 关闭视口裁剪时使用的恒定边界，引用稳定以免触发下游 useMemo 重算。 */
const INFINITE_RENDER_BOUNDS = {
    enter: { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity },
    retain: { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity },
} as const;

export function useCanvasRenderModel({
    nodes,
    connections,
    assets,
    viewport,
    viewportSize,
    mediaPerformanceMode,
    selectedNodeIds,
    hoveredNodeId,
    dragPreview,
    collapsingBatchIds,
    addedSkills,
    directorScenes,
    infoNodeId,
    cropNodeId,
    maskEditNodeId,
    imageEditNodeId,
    annotationNodeId,
    splitNodeId,
    upscaleNodeId,
    superResolveNodeId,
    angleNodeId,
    lightingNodeId,
    emotionNodeId,
    previewNodeId,
    contextMenu,
    versionCompareRootId,
    directorNodeId,
    scriptEditorNodeId,
    dialogNodeId,
}: UseCanvasRenderModelOptions) {
    const reduceMediaEffects = useMemo(() => shouldReduceCanvasMediaEffects(mediaPerformanceMode, nodes), [mediaPerformanceMode, nodes]);
    const virtualizeNodes = useMemo(() => shouldVirtualizeCanvasNodes(mediaPerformanceMode, nodes), [mediaPerformanceMode, nodes]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // These maps are consumed by both virtualization and node chrome. Building
    // them together keeps a metadata update from walking a 50k-node array six
    // separate times before React can paint the next frame.
    const nodeDerivedData = useMemo(() => {
        const collapsedBatchChildIds = new Set<string>();
        const renderHiddenNodeIds = new Set<string>();
        const frameChildrenById = new Map<string, CanvasNodeData[]>();
        const canvasImageNodes: CanvasNodeData[] = [];
        const batchRoots: CanvasNodeData[] = [];
        const batchMotionById = new Map<string, { x: number; y: number; index: number }>();
        const batchChildIndexByRootId = new Map<string, Map<string, number>>();

        for (const node of nodes) {
            const rootId = node.metadata?.batchRootId;
            const root = rootId ? nodeById.get(rootId) : undefined;
            if (root && !root.metadata?.imageBatchExpanded) {
                collapsedBatchChildIds.add(node.id);
                if (!collapsingBatchIds.has(root.id)) renderHiddenNodeIds.add(node.id);
            }

            if (rootId && collapsingBatchIds.has(rootId)) renderHiddenNodeIds.delete(node.id);
            const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
            if (parent && isFrameNode(parent)) {
                const children = frameChildrenById.get(parent.id);
                if (children) children.push(node);
                else frameChildrenById.set(parent.id, [node]);
                if (parent.metadata?.frame?.collapsed) renderHiddenNodeIds.add(node.id);
            }

            if (node.metadata?.isBatchRoot) batchRoots.push(node);
            if (node.type === CanvasNodeType.Image && node.metadata?.content && !collapsedBatchChildIds.has(node.id) && !(parent && isFrameNode(parent) && parent.metadata?.frame?.collapsed)) {
                canvasImageNodes.push(node);
            }
        }

        for (const root of batchRoots) {
            const childIndex = new Map((root.metadata?.batchChildIds || []).map((childId, index) => [childId, index]));
            batchChildIndexByRootId.set(root.id, childIndex);
        }
        for (const node of nodes) {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) continue;
            const root = nodeById.get(rootId);
            const index = batchChildIndexByRootId.get(rootId)?.get(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            batchMotionById.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        }

        const batchChildCountById = new Map<string, number>();
        for (const root of batchRoots) {
            const childIndex = batchChildIndexByRootId.get(root.id);
            const liveChildCount = [...(childIndex?.keys() || [])].filter((childId) => nodeById.get(childId)?.metadata?.batchRootId === root.id).length;
            batchChildCountById.set(root.id, liveChildCount);
        }

        return { batchChildCountById, batchMotionById, canvasImageNodes, collapsedBatchChildIds, frameChildrenById, renderHiddenNodeIds };
    }, [collapsingBatchIds, nodeById, nodes]);
    const { batchChildCountById, batchMotionById, canvasImageNodes, collapsedBatchChildIds, frameChildrenById, renderHiddenNodeIds } = nodeDerivedData;
    const connectionLayerBoundsRef = useRef<typeof CONNECTION_LAYER_EMPTY_BOUNDS | { left: number; top: number; width: number; height: number }>(CONNECTION_LAYER_EMPTY_BOUNDS);
    const renderBounds = useMemo(() => {
        // 关闭裁剪时返回与 viewport 无关的恒定边界：否则 visibleNodes 和 displayConnections
        // 仍会因为 renderBounds 每帧变化而重算，节点集合没变也要重新遍历所有连线。
        if (!virtualizeNodes) return INFINITE_RENDER_BOUNDS;
        const enterPadding = canvasNodeRenderPadding(reduceMediaEffects, false) / viewport.k;
        const retainPadding = canvasNodeRenderPadding(reduceMediaEffects, true) / viewport.k;
        const viewLeft = -viewport.x / viewport.k;
        const viewTop = -viewport.y / viewport.k;
        const viewWidth = viewportSize.width / viewport.k;
        const viewHeight = viewportSize.height / viewport.k;
        return {
            enter: { left: viewLeft - enterPadding, top: viewTop - enterPadding, right: viewLeft + viewWidth + enterPadding, bottom: viewTop + viewHeight + enterPadding },
            retain: { left: viewLeft - retainPadding, top: viewTop - retainPadding, right: viewLeft + viewWidth + retainPadding, bottom: viewTop + viewHeight + retainPadding },
        };
    }, [reduceMediaEffects, viewport.k, viewport.x, viewport.y, viewportSize.height, viewportSize.width, virtualizeNodes]);
    const nodeSpatialIndexRef = useRef<{ source: CanvasNodeData[]; index: CanvasSpatialIndex<string> } | null>(null);
    const nodeSpatialIndex = useMemo(() => {
        const previous = nodeSpatialIndexRef.current;
        const geometryUnchanged =
            previous &&
            previous.source.length === nodes.length &&
            nodes.every((node, index) => {
                const old = previous.source[index];
                return old.id === node.id && old.position.x === node.position.x && old.position.y === node.position.y && old.width === node.width && old.height === node.height;
            });
        if (geometryUnchanged) return previous.index;
        const index = buildCanvasSpatialIndex(nodes.map((node) => ({ id: node.id, bounds: canvasNodeBounds(node), value: node.id })));
        nodeSpatialIndexRef.current = { source: nodes, index };
        return index;
    }, [nodes]);
    const renderedNodeIdsRef = useRef<Set<string>>(new Set());
    const visibleNodes = useMemo(() => {
        const frames: CanvasNodeData[] = [];
        const regular: CanvasNodeData[] = [];
        // 关闭裁剪时不看 viewport，节点集合只随画布数据变化，平移缩放不再重挂组件。
        if (!virtualizeNodes) {
            nodes.forEach((node) => {
                if (renderHiddenNodeIds.has(node.id)) return;
                (isFrameNode(node) ? frames : regular).push(node);
            });
            return [...frames, ...regular];
        }
        const renderedNodeIds = renderedNodeIdsRef.current;
        const renderBudget = canvasNodeRenderBudget(viewport.k);
        const forcedNodeIds = new Set([...selectedNodeIds, ...(dragPreview?.nodeIds || [])].slice(0, renderBudget));
        const candidates = nodeSpatialIndex
            .query(renderBounds.retain, renderBudget + forcedNodeIds.size)
            .map((nodeId) => nodeById.get(nodeId))
            .filter((node): node is CanvasNodeData => Boolean(node));
        const candidateIds = new Set(candidates.map((node) => node.id));
        for (const nodeId of forcedNodeIds) {
            if (candidateIds.has(nodeId)) continue;
            const node = nodeById.get(nodeId);
            if (node) candidates.push(node);
        }
        const prioritized = candidates.filter((node) => forcedNodeIds.has(node.id));
        const remaining = candidates.filter((node) => !forcedNodeIds.has(node.id)).slice(0, Math.max(0, renderBudget - prioritized.length));
        [...prioritized, ...remaining].forEach((node) => {
            if (renderHiddenNodeIds.has(node.id)) return;
            const retained = forcedNodeIds.has(node.id) || renderedNodeIds.has(node.id);
            const insideEnterBounds = node.position.x + node.width > renderBounds.enter.left && node.position.x < renderBounds.enter.right && node.position.y + node.height > renderBounds.enter.top && node.position.y < renderBounds.enter.bottom;
            if (!retained && !insideEnterBounds) return;
            (isFrameNode(node) ? frames : regular).push(node);
        });
        return [...frames, ...regular];
    }, [dragPreview, nodeById, nodeSpatialIndex, nodes, renderBounds, renderHiddenNodeIds, selectedNodeIds, virtualizeNodes]);
    useEffect(() => {
        renderedNodeIdsRef.current = new Set(visibleNodes.map((node) => node.id));
    }, [visibleNodes]);

    const imageAssets = useMemo(() => assets.filter((asset): asset is ImageAsset => asset.kind === "image" && asset.status !== "archived"), [assets]);
    const semanticNodesRef = useRef(nodes);
    const semanticNodes = useMemo(() => {
        const previous = semanticNodesRef.current;
        const positionOnlyChange = previous.length === nodes.length && nodes.every((node, index) => sameNodeSemanticData(node, previous[index]));
        if (!positionOnlyChange) semanticNodesRef.current = nodes;
        return semanticNodesRef.current;
    }, [nodes]);
    const versionCompareNodes = useMemo(() => {
        if (!versionCompareRootId) return [];
        return nodes.filter((node) => (node.metadata?.versionOfNodeId || node.id) === versionCompareRootId).sort((a, b) => (a.metadata?.versionLabel || "").localeCompare(b.metadata?.versionLabel || ""));
    }, [nodes, versionCompareRootId]);

    const selectedNodeIdForToolbar = selectedNodeIds.size === 1 ? [...selectedNodeIds][0] : null;
    const toolbarCandidate = selectedNodeIdForToolbar ? nodeById.get(selectedNodeIdForToolbar) || null : null;
    const toolbarNode = isFrameNode(toolbarCandidate) ? null : toolbarCandidate;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const imageEditNode = imageEditNodeId ? nodeById.get(imageEditNodeId) || null : null;
    const annotationNode = annotationNodeId ? nodeById.get(annotationNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const lightingNode = lightingNodeId ? nodeById.get(lightingNodeId) || null : null;
    const emotionNode = emotionNodeId ? nodeById.get(emotionNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    // Hover only drives transient affordances (toolbar/handles). Selection is
    // the explicit focus action that raises a node and highlights its graph.
    const activeNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;

    const selectedNodeBounds = useMemo(() => {
        if (selectedNodeIds.size < 2) return null;
        const selectedNodes = [...selectedNodeIds].map((nodeId) => nodeById.get(nodeId)).filter((node): node is CanvasNodeData => Boolean(node && !renderHiddenNodeIds.has(node.id)));
        if (selectedNodes.length < 2) return null;
        const left = Math.min(...selectedNodes.map((node) => node.position.x));
        const top = Math.min(...selectedNodes.map((node) => node.position.y));
        const right = Math.max(...selectedNodes.map((node) => node.position.x + node.width));
        const bottom = Math.max(...selectedNodes.map((node) => node.position.y + node.height));
        return { left, top, width: right - left, height: bottom - top, count: selectedNodes.length };
    }, [nodeById, renderHiddenNodeIds, selectedNodeIds]);
    const selectedVideoNodes = useMemo(
        () =>
            [...selectedNodeIds]
                .map((nodeId) => nodeById.get(nodeId))
                .filter((node): node is CanvasNodeData => Boolean(node && node.type === CanvasNodeType.Video && node.metadata?.content && !renderHiddenNodeIds.has(node.id)))
                .sort((a, b) => {
                    const shotA = a.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                    const shotB = b.metadata?.shotIndex ?? Number.MAX_SAFE_INTEGER;
                    return shotA - shotB || a.position.y - b.position.y || a.position.x - b.position.x;
                }),
        [nodeById, renderHiddenNodeIds, selectedNodeIds],
    );
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        if (!activeNodeId) return { nodeIds };
        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });
        return { nodeIds };
    }, [activeNodeId, connections]);
    const connectionSpatialIndex = useMemo(() => {
        const entries: CanvasSpatialIndexEntry<CanvasDisplayConnection>[] = [];
        const connectionIdsByNodeId = new Map<string, Set<string>>();
        connections.forEach((connection) => {
            if (collapsedBatchChildIds.has(connection.fromNodeId) || collapsedBatchChildIds.has(connection.toNodeId)) return;
            const fromNode = nodeById.get(connection.fromNodeId);
            const toNode = nodeById.get(connection.toNodeId);
            if (!fromNode || !toNode) return;
            const fromParent = fromNode.parentId ? nodeById.get(fromNode.parentId) : null;
            const toParent = toNode.parentId ? nodeById.get(toNode.parentId) : null;
            const displayFrom = fromParent && isFrameNode(fromParent) && fromParent.metadata?.frame?.collapsed ? fromParent : fromNode;
            const displayTo = toParent && isFrameNode(toParent) && toParent.metadata?.frame?.collapsed ? toParent : toNode;
            if (displayFrom.id === displayTo.id) return;
            const left = Math.min(displayFrom.position.x, displayTo.position.x);
            const top = Math.min(displayFrom.position.y, displayTo.position.y);
            const right = Math.max(displayFrom.position.x + displayFrom.width, displayTo.position.x + displayTo.width);
            const bottom = Math.max(displayFrom.position.y + displayFrom.height, displayTo.position.y + displayTo.height);
            const value = { connection, from: displayFrom, to: displayTo };
            entries.push({ id: connection.id, bounds: { left, top, right, bottom }, value });
            for (const nodeId of new Set([connection.fromNodeId, connection.toNodeId, displayFrom.id, displayTo.id])) {
                const ids = connectionIdsByNodeId.get(nodeId) || new Set<string>();
                ids.add(connection.id);
                connectionIdsByNodeId.set(nodeId, ids);
            }
        });
        return { index: buildCanvasSpatialIndex(entries), connectionIdsByNodeId, entriesById: new Map(entries.map((entry) => [entry.id, entry.value])) };
    }, [collapsedBatchChildIds, connections, nodeById]);
    const displayConnections = useMemo(() => {
        const candidateById = new Map<string, CanvasDisplayConnection>();
        if (virtualizeNodes) {
            connectionSpatialIndex.index.query(renderBounds.retain, CANVAS_MAX_RENDERED_CONNECTIONS).forEach((display) => candidateById.set(display.connection.id, display));
        } else {
            connectionSpatialIndex.entriesById.forEach((display, connectionId) => candidateById.set(connectionId, display));
        }
        dragPreview?.nodeIds.forEach((nodeId) => {
            connectionSpatialIndex.connectionIdsByNodeId.get(nodeId)?.forEach((connectionId) => {
                const display = connectionSpatialIndex.entriesById.get(connectionId);
                if (display) candidateById.set(connectionId, display);
            });
        });
        return [...candidateById.values()].flatMap(({ connection, from: sourceFrom, to: sourceTo }) => {
            const from = dragPreview?.nodeIds.has(sourceFrom.id) ? { ...sourceFrom, position: { x: sourceFrom.position.x + dragPreview.x, y: sourceFrom.position.y + dragPreview.y } } : sourceFrom;
            const to = dragPreview?.nodeIds.has(sourceTo.id) ? { ...sourceTo, position: { x: sourceTo.position.x + dragPreview.x, y: sourceTo.position.y + dragPreview.y } } : sourceTo;
            const connectionLeft = Math.min(from.position.x, to.position.x);
            const connectionTop = Math.min(from.position.y, to.position.y);
            const connectionRight = Math.max(from.position.x + from.width, to.position.x + to.width);
            const connectionBottom = Math.max(from.position.y + from.height, to.position.y + to.height);
            if (virtualizeNodes && (connectionRight <= renderBounds.retain.left || connectionLeft >= renderBounds.retain.right || connectionBottom <= renderBounds.retain.top || connectionTop >= renderBounds.retain.bottom)) return [];
            return [{ connection, from, to }];
        });
    }, [connectionSpatialIndex, dragPreview, renderBounds, virtualizeNodes]);

    /**
     * 连线层 SVG 的画布范围。
     *
     * 这些值最终写成 SVG 的 left / top / width / height 和 viewBox，都是**布局属性**而不是
     * transform：跟着视口走就意味着每次提交视口都要 layout 一次，并产生一次真实布局偏移
     * （实测占整个页面 CLS 的 98.4%，是连线闪烁的主因）。改成只由连线内容决定后，平移和
     * 缩放期间这层完全不动，只有连线增删或节点移动才重算一次。
     *
     * SVG 本身是 overflow: visible，范围算小了也不会裁掉曲线，padding 只是给贝塞尔控制点留余量。
     */
    const connectionLayerBounds = useMemo(() => {
        // 节点拖拽期间只移动 path，不改变 SVG 的布局盒子。否则虚拟化进出场或
        // dragPreview 的临时坐标会让 left/top/width/height 每帧变化，造成连线闪烁。
        if (dragPreview) return connectionLayerBoundsRef.current;
        if (displayConnections.length === 0) return CONNECTION_LAYER_EMPTY_BOUNDS;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const { from, to } of displayConnections) {
            left = Math.min(left, from.position.x, to.position.x);
            top = Math.min(top, from.position.y, to.position.y);
            right = Math.max(right, from.position.x + from.width, to.position.x + to.width);
            bottom = Math.max(bottom, from.position.y + from.height, to.position.y + to.height);
        }
        const padding = 240;
        const next = {
            left: left - padding,
            top: top - padding,
            width: Math.max(2, right - left + padding * 2),
            height: Math.max(2, bottom - top + padding * 2),
        };
        connectionLayerBoundsRef.current = next;
        return next;
    }, [displayConnections, dragPreview]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        const configNodeIds = new Set<string>();
        visibleNodes.forEach((node) => {
            if (node.type === CanvasNodeType.Config) configNodeIds.add(node.id);
        });
        selectedNodeIds.forEach((nodeId) => {
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Config) configNodeIds.add(nodeId);
        });
        if (dialogNodeId && nodeById.get(dialogNodeId)?.type === CanvasNodeType.Config) configNodeIds.add(dialogNodeId);
        configNodeIds.forEach((nodeId) => map.set(nodeId, buildNodeGenerationInputs(nodeId, semanticNodes, connections)));
        return map;
    }, [connections, dialogNodeId, nodeById, selectedNodeIds, semanticNodes, visibleNodes]);
    const activeDirectorNode = useMemo(() => semanticNodes.find((node) => node.id === directorNodeId) || null, [directorNodeId, semanticNodes]);
    const activeStylePresetId = useMemo(() => semanticNodes.find((node) => node.metadata?.workflowKind === "styleboard")?.metadata?.stylePresetId, [semanticNodes]);
    const activeScriptNode = useMemo(() => semanticNodes.find((node) => node.id === scriptEditorNodeId && node.type === CanvasNodeType.Script) || null, [scriptEditorNodeId, semanticNodes]);
    const activeDirectorScene = useMemo(() => directorScenes?.find((scene) => scene.id === activeDirectorNode?.metadata?.directorSceneId) || null, [activeDirectorNode?.metadata?.directorSceneId, directorScenes]);
    const resourceReferenceTargetNodes = useMemo(() => {
        const targetNodes = [...visibleNodes];
        const activeId = dialogNodeId || activeNodeId;
        if (activeId) {
            const activeNode = nodeById.get(activeId);
            if (activeNode) targetNodes.push(activeNode);
        }
        return targetNodes;
    }, [activeNodeId, dialogNodeId, nodeById, visibleNodes]);
    const canvasResourceReferences = useMemo(
        () => buildCanvasResourceReferences(semanticNodes, connections, dialogNodeId || activeNodeId, resourceReferenceTargetNodes),
        [activeNodeId, connections, dialogNodeId, resourceReferenceTargetNodes, semanticNodes],
    );
    const resourceReferenceByNodeId = useMemo(() => new Map(canvasResourceReferences.map((reference) => [reference.nodeId, reference])), [canvasResourceReferences]);
    const skillMentionReferences = useMemo(() => buildSkillMentionReferences(addedSkills), [addedSkills]);
    const toolMentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildToolMentionReference>[]>();
        for (const node of semanticNodes) {
            const text = node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
            const tokens = parseToolMentionTokens(text);
            if (!tokens.length) continue;
            const seen = new Set<number>();
            const refs: ReturnType<typeof buildToolMentionReference>[] = [];
            for (const { type, toolId, label, icon } of tokens) {
                if (seen.has(toolId)) continue;
                seen.add(toolId);
                refs.push(buildToolMentionReference(toolId, label, type, icon));
            }
            if (refs.length) map.set(node.id, refs);
        }
        return map;
    }, [semanticNodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = buildCanvasNodeMentionReferenceMap(semanticNodes, connections, visibleNodes);
        if (!skillMentionReferences.length && toolMentionReferencesByNodeId.size === 0) return map;
        map.forEach((references, nodeId) => {
            const extras = [...skillMentionReferences, ...(toolMentionReferencesByNodeId.get(nodeId) ?? [])];
            if (extras.length) map.set(nodeId, [...references, ...extras]);
        });
        return map;
    }, [connections, semanticNodes, skillMentionReferences, toolMentionReferencesByNodeId, visibleNodes]);

    return {
        activeDirectorNode,
        activeDirectorScene,
        activeNodeId,
        activeScriptNode,
        activeStylePresetId,
        angleNode,
        lightingNode,
        emotionNode,
        annotationNode,
        batchChildCountById,
        batchMotionById,
        canvasImageNodes,
        configInputsById,
        connectionLayerBounds,
        contextMenuNode,
        cropNode,
        displayConnections,
        frameChildrenById,
        imageAssets,
        infoNode,
        maskEditNode,
        imageEditNode,
        mentionReferencesByNodeId,
        nodeById,
        previewNode,
        reduceMediaEffects,
        relatedHighlight,
        resourceReferenceByNodeId,
        selectedNodeBounds,
        selectedVideoNodes,
        semanticNodes,
        skillMentionReferences,
        splitNode,
        superResolveNode,
        toolbarNode,
        upscaleNode,
        versionCompareNodes,
        visibleNodes,
    };
}
