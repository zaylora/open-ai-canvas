import { describe, expect, test } from "bun:test";

import { CANVAS_MINIMAP_VARIANT_WIDTH, CANVAS_NODE_VARIANT_WIDTH, IMAGE_VARIANT_WIDTHS, imagePreviewUrl } from "../src/lib/canvas/image-variant";

describe("imagePreviewUrl", () => {
    test("给后端资源地址追加变体参数并保持相对形式", () => {
        expect(imagePreviewUrl("/api/resources/abc/file?direct=1", 640)).toBe("/api/resources/abc/file?direct=1&variant=preview&w=640");
    });

    test("绝对形式的资源地址保持绝对", () => {
        expect(imagePreviewUrl("https://canvas.example.com/api/resources/abc/file", 320)).toBe("https://canvas.example.com/api/resources/abc/file?variant=preview&w=320");
    });

    test("宽度向上取整到档位，避免同一张图产生大量计费转换", () => {
        expect(imagePreviewUrl("/api/resources/abc/file", 300)).toContain("w=320");
        expect(imagePreviewUrl("/api/resources/abc/file", 321)).toContain("w=640");
        expect(imagePreviewUrl("/api/resources/abc/file", 960)).toContain("w=960");
    });

    test("超过最大档位时直接用原图", () => {
        expect(imagePreviewUrl("/api/resources/abc/file", IMAGE_VARIANT_WIDTHS[IMAGE_VARIANT_WIDTHS.length - 1] + 1)).toBe("/api/resources/abc/file");
    });

    test("缩略导航复用节点档位，两者命中同一个变体地址", () => {
        expect(CANVAS_MINIMAP_VARIANT_WIDTH).toBe(CANVAS_NODE_VARIANT_WIDTH);
        expect(imagePreviewUrl("/api/resources/abc/file", CANVAS_MINIMAP_VARIANT_WIDTH)).toBe(imagePreviewUrl("/api/resources/abc/file", CANVAS_NODE_VARIANT_WIDTH));
    });

    test("命中外部直链规则时改写为对方 OSS 的处理参数", () => {
        expect(imagePreviewUrl("https://libtv-res.liblib.art/path/example.png", 960)).toBe("https://libtv-res.liblib.art/path/example.png?x-oss-process=image%2Fresize%2Cw_960");
    });

    test("外部直链已带处理参数时不再改写", () => {
        const original = "https://libtv-res.liblib.art/path/example.png?x-oss-process=image%2Fresize%2Cw_960";
        expect(imagePreviewUrl(original, 320)).toBe(original);
    });

    test("未知来源、内联数据和本地对象地址一律原样返回", () => {
        expect(imagePreviewUrl("https://cdn.example.com/a.png", 960)).toBe("https://cdn.example.com/a.png");
        expect(imagePreviewUrl("data:image/png;base64,AAAA", 960)).toBe("data:image/png;base64,AAAA");
        expect(imagePreviewUrl("blob:https://app.example.com/uuid", 960)).toBe("blob:https://app.example.com/uuid");
        expect(imagePreviewUrl("", 960)).toBe("");
    });

    test("非图片资源路径不受影响", () => {
        expect(imagePreviewUrl("/api/projects/abc/cover", 960)).toBe("/api/projects/abc/cover");
    });
});
