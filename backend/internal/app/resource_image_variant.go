package app

import (
	"errors"
	"fmt"
	"strings"
)

// imageVariantWidths 是允许交付的变体宽度档位。
// Cloudflare Images 按「源图 × 参数组合」计费唯一转换数，缓存命中不再计费；
// 若直接把节点像素宽透传上来，同一张图在画布缩放过程中会产生大量一次性转换。
// 档位化把每张图的转换次数固定为档位数量上限。前端 web/src/lib/canvas/image-variant.ts
// 的 IMAGE_VARIANT_WIDTHS 必须与此保持一致。
var imageVariantWidths = []int{320, 640, 960, 1600}

// normalizeImageVariantWidth 把请求宽度向上取整到最近档位。
// 返回 0 表示不生成变体（宽度非法，或超过最大档位时直接用原图更划算）。
func normalizeImageVariantWidth(width int) int {
	if width <= 0 {
		return 0
	}
	for _, allowed := range imageVariantWidths {
		if width <= allowed {
			return allowed
		}
	}
	return 0
}

// ossImageVariantURL 生成指定宽度的图片变体地址。
// 第二个返回值为 false 表示当前存储配置不支持变体，调用方必须回退到原图地址。
func ossImageVariantURL(setting ossSettingValue, objectKey string, width int) (string, bool) {
	setting = normalizeOSSSetting(setting)
	if !setting.ImageTransform {
		return "", false
	}
	width = normalizeImageVariantWidth(width)
	if width == 0 {
		return "", false
	}
	// 目前只实现 Cloudflare Images；normalizeOSSSetting 已保证 ImageTransform
	// 仅在 R2 + Cloudflare 代理域名下为真。接入其他厂商的图片处理时在此分派。
	variantURL, err := cloudflareImageVariantURL(setting.CDNBaseURL, objectKey, width)
	if err != nil {
		return "", false
	}
	return variantURL, true
}

// cloudflareImageVariantURL 拼 Cloudflare Images 的 /cdn-cgi/image/<options>/<objectKey>。
// options 段必须紧跟在 host 之后，写成查询参数不会被边缘识别。
func cloudflareImageVariantURL(cdnBaseURL string, objectKey string, width int) (string, error) {
	baseURL, err := ossCDNBaseURL(cdnBaseURL)
	if err != nil {
		return "", err
	}
	objectKey = strings.TrimLeft(strings.TrimSpace(objectKey), "/")
	if objectKey == "" {
		return "", errors.New("对象存储对象路径为空")
	}
	// 与 ossCDNObjectURL 一致：Path 保留未转义值，交给 url.URL.String 统一转义，
	// 避免把已转义的 %20 再编码成 %2520。
	baseURL.Path = fmt.Sprintf("/cdn-cgi/image/width=%d,quality=82,format=auto/%s", width, objectKey)
	return baseURL.String(), nil
}
