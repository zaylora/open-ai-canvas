package assets

import (
	"io"

	"infinite-canvas/backend/internal/model"
)

type ResourceStream struct {
	Resource      *model.Resource
	Body          io.ReadCloser
	StatusCode    int
	ContentLength int64
	ContentRange  string
	AcceptRanges  string
}

type ResourceDeliveryOptions struct {
	ForceDirect bool
	ForceProxy  bool
	// ImageWidth 大于 0 时请求该宽度的图片变体；存储配置不支持变体时静默回退原图。
	ImageWidth int
}

type ResourceDelivery struct {
	Resource    *model.Resource
	Stream      *ResourceStream
	RedirectURL string
}
