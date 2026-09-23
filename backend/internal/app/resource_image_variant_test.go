package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/storage"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNormalizeImageVariantWidthRoundsUpToBucket(t *testing.T) {
	cases := []struct {
		width int
		want  int
	}{
		{width: 0, want: 0},
		{width: -10, want: 0},
		{width: 1, want: 320},
		{width: 320, want: 320},
		{width: 321, want: 640},
		{width: 960, want: 960},
		{width: 1600, want: 1600},
		// 超过最大档位时原图更划算，也避免为超大图多付一次转换。
		{width: 1601, want: 0},
	}
	for _, testCase := range cases {
		if got := storage.NormalizeImageVariantWidth(testCase.width); got != testCase.want {
			t.Fatalf("NormalizeImageVariantWidth(%d) = %d, want %d", testCase.width, got, testCase.want)
		}
	}
}

func TestNormalizeOSSSettingKeepsImageTransformOnlyForR2WithCDN(t *testing.T) {
	base := ossSettingValue{Provider: s3Provider, S3Preset: "r2", CDNBaseURL: "https://media.example.com", ImageTransform: true}
	if got := storage.NormalizeSettings(base); !got.ImageTransform {
		t.Fatalf("ImageTransform = false, want true for R2 with CDN")
	}

	noCDN := base
	noCDN.CDNBaseURL = ""
	if got := storage.NormalizeSettings(noCDN); got.ImageTransform {
		t.Fatalf("ImageTransform = true, want false without CDN base URL")
	}

	otherPreset := base
	otherPreset.S3Preset = "aws"
	if got := storage.NormalizeSettings(otherPreset); got.ImageTransform {
		t.Fatalf("ImageTransform = true, want false for non-R2 S3 preset")
	}

	otherProvider := base
	otherProvider.Provider = aliyunOSSProvider
	if got := storage.NormalizeSettings(otherProvider); got.ImageTransform {
		t.Fatalf("ImageTransform = true, want false for non-S3 provider")
	}
}

func TestImageVariantURLBuildsCloudflarePath(t *testing.T) {
	setting := ossSettingValue{Provider: s3Provider, S3Preset: "r2", CDNBaseURL: "https://media.example.com", ImageTransform: true}
	got, ok := storage.ImageVariantURL(setting, "open-ai-canvas/users/u1/image/a.png", 900)
	if !ok {
		t.Fatalf("ImageVariantURL() ok = false, want true")
	}
	want := "https://media.example.com/cdn-cgi/image/width=960,quality=82,format=auto/open-ai-canvas/users/u1/image/a.png"
	if got != want {
		t.Fatalf("ImageVariantURL() = %q, want %q", got, want)
	}
}

func TestImageVariantURLRefusesUnsupportedSettings(t *testing.T) {
	enabled := ossSettingValue{Provider: s3Provider, S3Preset: "r2", CDNBaseURL: "https://media.example.com", ImageTransform: true}

	disabled := enabled
	disabled.ImageTransform = false
	if _, ok := storage.ImageVariantURL(disabled, "a.png", 960); ok {
		t.Fatalf("ImageVariantURL() ok = true, want false when transform disabled")
	}

	// 开关为真但配置已不满足前提：SupportsImageTransform 必须在这里再次兜底。
	staleSwitch := enabled
	staleSwitch.S3Preset = "aws"
	if _, ok := storage.ImageVariantURL(staleSwitch, "a.png", 960); ok {
		t.Fatalf("ImageVariantURL() ok = true, want false for non-R2 preset")
	}

	if _, ok := storage.ImageVariantURL(enabled, "a.png", 0); ok {
		t.Fatalf("ImageVariantURL() ok = true, want false for zero width")
	}
	if _, ok := storage.ImageVariantURL(enabled, "   ", 960); ok {
		t.Fatalf("ImageVariantURL() ok = true, want false for empty object key")
	}
}

func newVariantDeliveryTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Resource{},
		&model.UserOSSSetting{},
		&model.SystemSetting{},
		&model.StorageLocation{},
	); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db), dataDir: t.TempDir()}, db
}

// seedPlatformR2Location 还原线上那次故障的数据形状：连接测试先给存储位置建档（此时管理员
// 还没打开变体交付，快照里 imageTransform=false），之后保存平台设置才把开关置为 true。
// requireTestedS3Location 只按 digest 取已测试的位置，不会回写快照，于是两份值长期不一致。
func seedPlatformR2Location(t *testing.T, db *gorm.DB, snapshotTransform bool, currentTransform bool) *model.StorageLocation {
	t.Helper()
	const endpoint = "https://acct.r2.cloudflarestorage.com"
	base := ossSettingValue{
		Enabled:         true,
		Provider:        s3Provider,
		S3Preset:        "r2",
		Region:          "auto",
		Endpoint:        endpoint,
		Bucket:          "yince",
		PathPrefix:      "open-ai-canvas",
		CDNBaseURL:      "https://media.example.com",
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-plaintext",
		// 变体地址是公开的 Cloudflare 代理路径，必须同时声明 CDN 访问鉴权方式，
		// 否则新的交付策略会判定 CDN 未配置而回落源站。
		Delivery: storage.DeliverySettings{CDNAuthMode: "public"},
	}

	snapshot := base
	snapshot.ImageTransform = snapshotTransform
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	location := &model.StorageLocation{
		ID:             newID(),
		Scope:          "platform",
		OwnerID:        "",
		Provider:       s3Provider,
		LocationDigest: storageLocationDigest(snapshot),
		ValueJSON:      string(encoded),
		Active:         true,
	}
	if err := db.Create(location).Error; err != nil {
		t.Fatal(err)
	}

	current := base
	current.ImageTransform = currentTransform
	current.StorageLocationID = location.ID
	currentJSON, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: ossSettingKey, ValueJSON: string(currentJSON)}).Error; err != nil {
		t.Fatal(err)
	}
	return location
}

func seedR2Resource(t *testing.T, db *gorm.DB, userID string, locationID string) *model.Resource {
	t.Helper()
	resource := &model.Resource{
		ID:               newID(),
		UserID:           userID,
		Kind:             "image",
		MimeType:         "image/png",
		Status:           model.ResourceStatusReady,
		Provider:         s3Provider,
		Endpoint:         "https://acct.r2.cloudflarestorage.com",
		Bucket:           "yince",
		ObjectKey:        "open-ai-canvas/users/u1/image/a.png",
		StorageSettingID: locationID,
		Size:             1024,
	}
	if err := db.Create(resource).Error; err != nil {
		t.Fatal(err)
	}
	return resource
}

// TestOSSSettingForResourceTakesImageTransformFromCurrentSetting 覆盖变体开关的真源：
// 存储位置快照停在 false，平台当前设置是 true，交付必须按 true 走。
// 回归的是「管理员打开变体交付后画布仍然加载 CDN 原图」。
func TestOSSSettingForResourceTakesImageTransformFromCurrentSetting(t *testing.T) {
	service, db := newVariantDeliveryTestService(t)
	location := seedPlatformR2Location(t, db, false, true)
	resource := seedR2Resource(t, db, "user-1", location.ID)

	setting, err := service.ossSettingForResource("user-1", resource)
	if err != nil {
		t.Fatalf("ossSettingForResource: %v", err)
	}
	if !setting.ImageTransform {
		t.Fatal("ImageTransform = false, want true from current platform setting")
	}
	if setting.CDNBaseURL != "https://media.example.com" {
		t.Fatalf("CDNBaseURL = %q, want https://media.example.com", setting.CDNBaseURL)
	}
}

// TestResourceAccessDeliversVariant 端到端确认浏览器展示落在 /cdn-cgi/image，
// 而不是 CDN 原图地址。ImageWidth 由 handler 的 variant=preview&w= 解析而来。
func TestResourceAccessDeliversVariant(t *testing.T) {
	service, db := newVariantDeliveryTestService(t)
	location := seedPlatformR2Location(t, db, false, true)
	resource := seedR2Resource(t, db, "user-1", location.ID)

	access, err := service.resolveResourceAccess(resource, ResourceAccessOptions{Purpose: assets.PurposeDisplay, Variant: assets.VariantOriginal, ImageWidth: 960})
	if err != nil {
		t.Fatalf("resolveResourceAccess: %v", err)
	}
	want := "https://media.example.com/cdn-cgi/image/width=960,quality=82,format=auto/open-ai-canvas/users/u1/image/a.png"
	if access.URL != want {
		t.Fatalf("URL = %q, want %q", access.URL, want)
	}
	if access.Delivery != assets.DeliveryCDN {
		t.Fatalf("Delivery = %q, want %q", access.Delivery, assets.DeliveryCDN)
	}
	// 交付宽度必须回报给调用方：前端据此判断量到的像素不是资源真实尺寸。
	if access.ImageWidth != 960 {
		t.Fatalf("ImageWidth = %d, want 960", access.ImageWidth)
	}
}

// TestResourceAccessKeepsOriginalWhenTransformOff 开关关闭时必须退回 CDN 原图，
// 不能因为修复了同步就让所有部署都开始走 /cdn-cgi/image（那会产生计费转换）。
func TestResourceAccessKeepsOriginalWhenTransformOff(t *testing.T) {
	service, db := newVariantDeliveryTestService(t)
	location := seedPlatformR2Location(t, db, true, false)
	resource := seedR2Resource(t, db, "user-1", location.ID)

	access, err := service.resolveResourceAccess(resource, ResourceAccessOptions{Purpose: assets.PurposeDisplay, Variant: assets.VariantOriginal, ImageWidth: 960})
	if err != nil {
		t.Fatalf("resolveResourceAccess: %v", err)
	}
	want := "https://media.example.com/open-ai-canvas/users/u1/image/a.png"
	if access.URL != want {
		t.Fatalf("URL = %q, want %q", access.URL, want)
	}
	if access.ImageWidth != 0 {
		t.Fatalf("ImageWidth = %d, want 0 when transform is off", access.ImageWidth)
	}
}

// TestResourceAccessKeepsOriginalForNonDisplayPurpose 导出与模型输入必须拿到原图：
// 变体只服务浏览器展示，不能让下载或上游读取到缩放后的字节。
func TestResourceAccessKeepsOriginalForNonDisplayPurpose(t *testing.T) {
	service, db := newVariantDeliveryTestService(t)
	location := seedPlatformR2Location(t, db, false, true)
	resource := seedR2Resource(t, db, "user-1", location.ID)

	access, err := service.resolveResourceAccess(resource, ResourceAccessOptions{Purpose: assets.PurposeCopy, Variant: assets.VariantOriginal, ImageWidth: 960})
	if err != nil {
		t.Fatalf("resolveResourceAccess: %v", err)
	}
	want := "https://media.example.com/open-ai-canvas/users/u1/image/a.png"
	if access.URL != want {
		t.Fatalf("URL = %q, want %q", access.URL, want)
	}
	if access.ImageWidth != 0 {
		t.Fatalf("ImageWidth = %d, want 0 for non-display purpose", access.ImageWidth)
	}
}
