/**
 * 画布展示用的图片变体地址。
 *
 * 两类来源走两条完全不同的路：自家资源由后端按存储配置决定变体（前端不知道底层是
 * R2 还是别的厂商，也不应该为此多查一次元数据），外部直链则按 host 命中已知规则。
 * 不认识的地址一律原样返回，宁可加载原图也不要拼出 404。
 */

/** 允许的变体宽度档位，必须与后端 backend/internal/storage/delivery.go 的 imageVariantWidths 一致。 */
export const IMAGE_VARIANT_WIDTHS = [320, 640, 960, 1600] as const;

/** 画布节点的展示宽度档位：节点最大约 640 逻辑像素，留一档给高 DPI 屏。 */
export const CANVAS_NODE_VARIANT_WIDTH = 960;

/**
 * 列表小图位的档位：@ 提及菜单头像、输入框内的引用 chip、素材卡片这类几十像素的位置。
 * 这些位置用 CANVAS_NODE_VARIANT_WIDTH 会把几十 KB 的图塞进 40px 的框，
 * 所以宁可多一个档位：每张图的计费转换从 1 次变 2 次，换来小图位少下载一个数量级。
 */
export const CANVAS_THUMBNAIL_VARIANT_WIDTH = 320;

/**
 * 缩略导航刻意复用节点档位，而不是另开 320 档。
 * 两者共享同一个变体地址后，mini-map 直接命中节点已经加载过的缓存：零额外请求，
 * 也不会让每张图在 Cloudflare 多产生一次计费转换。代价只是解码一张已在内存里的图。
 */
export const CANVAS_MINIMAP_VARIANT_WIDTH = CANVAS_NODE_VARIANT_WIDTH;

const LIBTV_RESOURCE_HOST = "libtv-res.liblib.art";

/** 外部直链的变体规则。这些服务的图片处理参数由对方 OSS 提供，与本站存储配置无关。 */
const EXTERNAL_RULES: Array<{ host: string; apply: (url: URL, width: number) => void }> = [
    {
        host: LIBTV_RESOURCE_HOST,
        apply: (url, width) => {
            if (url.searchParams.has("x-oss-process")) return;
            url.searchParams.set("x-oss-process", `image/resize,w_${width}`);
        },
    },
];

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** 仅用于解析相对地址，不会出现在返回值里。 */
const PLACEHOLDER_ORIGIN = "http://canvas.invalid";

function normalizeVariantWidth(width: number) {
    const matched = IMAGE_VARIANT_WIDTHS.find((allowed) => width <= allowed);
    return matched || 0;
}

/**
 * 返回用于展示的图片地址；无法生成变体时返回原地址。
 * 调用方必须为 <img> 准备 onError 回退，变体在上游失败时不会自动降级到原图。
 */
export function imagePreviewUrl(raw: string, width: number = CANVAS_NODE_VARIANT_WIDTH): string {
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
    const variantWidth = normalizeVariantWidth(width);
    if (!variantWidth) return raw;
    // 后端资源地址默认是相对的（apiBaseURL 为 "/api"）。用占位 origin 解析后必须还原成
    // 相对形式，否则会把页面地址固化进 src，跨域部署和测试环境都会跟着出错。
    const relative = !ABSOLUTE_URL.test(raw);
    try {
        const url = new URL(raw, PLACEHOLDER_ORIGIN);
        if (isResourceFileURL(url)) {
            url.searchParams.set("variant", "preview");
            url.searchParams.set("w", String(variantWidth));
            return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
        }
        if (relative || url.protocol !== "https:") return raw;
        const rule = EXTERNAL_RULES.find((item) => item.host === url.hostname);
        if (!rule) return raw;
        rule.apply(url, variantWidth);
        return url.toString();
    } catch {
        return raw;
    }
}

/** 后端资源文件地址形如 `<base>/resources/<id>/file`，分享页的公开地址同样以 /file 结尾。 */
function isResourceFileURL(url: URL) {
    return url.pathname.includes("/resources/") && url.pathname.endsWith("/file");
}
