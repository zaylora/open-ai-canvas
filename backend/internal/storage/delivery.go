package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// DeliverySettings is independent from origin credentials. Public CDN access must be an explicit choice.
type DeliverySettings struct {
	CDNAuthMode       string `json:"cdnAuthMode"`
	RequireCDN        bool   `json:"requireCDN"`
	AllowPrivateProxy bool   `json:"allowPrivateProxy"`
}

func CDNEnabled(setting Settings) bool {
	if setting.CDNBaseURL == "" {
		return false
	}
	return setting.Delivery.CDNAuthMode == "public" || setting.Delivery.CDNAuthMode == "qiniu"
}

func SignCDNURL(setting Settings, objectKey string, expires time.Time) (string, error) {
	switch setting.Delivery.CDNAuthMode {
	case "public":
		return OssCDNObjectURL(setting.CDNBaseURL, objectKey)
	case "qiniu":
		if setting.Provider == qiniuKodoProvider {
			return SignedQiniuObjectURL(setting, objectKey, expires)
		}
	}
	return "", errors.New("CDN 用户访问鉴权方式未配置或不支持")
}

func PublicOrigin(setting Settings) bool {
	if setting.Provider == qiniuKodoProvider {
		return true
	} // The SDK signs the public Kodo S3 origin, not its upload endpoint.
	return PublicHTTPSStorageEndpoint(setting.Endpoint)
}

func DeliveryRevision(setting Settings) string {
	// Only a digest leaves the server; changes to credentials/configuration invalidate descriptors.
	data, _ := json.Marshal(setting)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

// imageVariantWidths 是允许交付的变体宽度档位。
// Cloudflare Images 按「源图 × 参数组合」计费唯一转换数，缓存命中不再计费；
// 若直接把节点像素宽透传上来，同一张图在画布缩放过程中会产生大量一次性转换。
// 档位化把每张图的转换次数固定为档位数量上限。前端 web/src/lib/canvas/image-variant.ts
// 的 IMAGE_VARIANT_WIDTHS 必须与此保持一致。
var imageVariantWidths = []int{320, 640, 960, 1600}

// NormalizeImageVariantWidth 把请求宽度向上取整到最近档位。
// 返回 0 表示不生成变体（宽度非法，或超过最大档位时直接用原图更划算）。
func NormalizeImageVariantWidth(width int) int {
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

// ImageVariantURL 生成指定宽度的图片变体地址。
// 第二个返回值为 false 表示当前存储配置不支持变体，调用方必须回退到原图地址。
func ImageVariantURL(setting Settings, objectKey string, width int) (string, bool) {
	if !setting.ImageTransform || !SupportsImageTransform(setting) {
		return "", false
	}
	width = NormalizeImageVariantWidth(width)
	if width == 0 {
		return "", false
	}
	// 目前只实现 Cloudflare Images；SupportsImageTransform 已保证前提为 R2 +
	// Cloudflare 代理域名。接入其他厂商的图片处理时在此分派。
	variantURL, err := cloudflareImageVariantURL(setting.CDNBaseURL, objectKey, width)
	if err != nil {
		return "", false
	}
	return variantURL, true
}

// cloudflareImageVariantURL 拼 Cloudflare Images 的 /cdn-cgi/image/<options>/<objectKey>。
// options 段必须紧跟在 host 之后，写成查询参数不会被边缘识别。
func cloudflareImageVariantURL(cdnBaseURL string, objectKey string, width int) (string, error) {
	baseURL, err := OssCDNBaseURL(cdnBaseURL)
	if err != nil {
		return "", err
	}
	objectKey = strings.TrimLeft(strings.TrimSpace(objectKey), "/")
	if objectKey == "" {
		return "", errors.New("对象存储对象路径为空")
	}
	// 与 OssCDNObjectURL 一致：Path 保留未转义值，交给 url.URL.String 统一转义，
	// 避免把已转义的 %20 再编码成 %2520。
	baseURL.Path = fmt.Sprintf("/cdn-cgi/image/width=%d,quality=82,format=auto/%s", width, objectKey)
	return baseURL.String(), nil
}
