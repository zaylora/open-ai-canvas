#!/usr/bin/env bash
set -euo pipefail

# 通过 SSH 触发服务器上的 Host Updater 完成发布部署。
# CI 只负责触发和等待：备份、镜像拉取、数据库迁移、健康验证和失败回滚全部由宿主机的
# open-ai-canvas-updater 执行，工作流不接触 Docker、数据库和 Compose 文件。

: "${DEPLOY_SSH_HOST:?}" "${DEPLOY_SSH_USER:?}" "${DEPLOY_SSH_KEY:?}" "${DEPLOY_SSH_KNOWN_HOSTS:?}"
: "${DEPLOY_UPDATER_TOKEN:?}" "${TARGET_VERSION:?}" "${GITHUB_REPOSITORY:?}"

ssh_port="${DEPLOY_SSH_PORT:-22}"
updater_socket="${DEPLOY_UPDATER_SOCKET:-/run/open-ai-canvas-updater/updater.sock}"
deploy_timeout="${DEPLOY_TIMEOUT_SECONDS:-2700}"
release_retries="${DEPLOY_RELEASE_RETRIES:-6}"
release_retry_interval="${DEPLOY_RELEASE_RETRY_INTERVAL:-20}"
poll_interval="${DEPLOY_POLL_INTERVAL:-10}"
# 更新过程会停掉 web/backend 并重建容器，偶发读不到状态不等于更新失败。
max_consecutive_failures=6

[[ "$TARGET_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "TARGET_VERSION 必须是 vX.Y.Z 形式的发布版本：$TARGET_VERSION" >&2
  exit 1
}
require_positive_integer() {
  local name="$1" value="$2" minimum="$3"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || ((value < minimum)); then
    echo "$name 必须是不小于 $minimum 的整数：$value" >&2
    exit 1
  fi
}

require_positive_integer DEPLOY_SSH_PORT "$ssh_port" 1
if ((ssh_port > 65535)); then
  echo "DEPLOY_SSH_PORT 必须是 1 到 65535 的数字：$ssh_port" >&2
  exit 1
fi
if [[ "$updater_socket" != /* ]]; then
  echo "DEPLOY_UPDATER_SOCKET 必须是绝对路径：$updater_socket" >&2
  exit 1
fi
require_positive_integer DEPLOY_TIMEOUT_SECONDS "$deploy_timeout" 1
require_positive_integer DEPLOY_RELEASE_RETRIES "$release_retries" 1
require_positive_integer DEPLOY_RELEASE_RETRY_INTERVAL "$release_retry_interval" 0
require_positive_integer DEPLOY_POLL_INTERVAL "$poll_interval" 1
# Token 会写进 curl 配置的引号字符串，限制字符集可排除引号和反斜杠带来的解析歧义。
[[ "$DEPLOY_UPDATER_TOKEN" =~ ^[A-Za-z0-9._~+/=-]{32,}$ ]] || {
  echo "DEPLOY_UPDATER_TOKEN 至少 32 位，且只能包含 Base64/Hex 常见字符" >&2
  exit 1
}

workdir="$(mktemp -d)"
remote="$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"
control_path="$workdir/control"
cleanup() {
  ssh -o ControlPath="$control_path" -O exit "$remote" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

umask 077
printf '%s\n' "$DEPLOY_SSH_KEY" >"$workdir/deploy_key"
printf '%s\n' "$DEPLOY_SSH_KNOWN_HOSTS" >"$workdir/known_hosts"

ssh_options=(
  -i "$workdir/deploy_key"
  -p "$ssh_port"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$workdir/known_hosts"
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o ControlMaster=auto
  -o ControlPath="$control_path"
  -o ControlPersist=180
)

response_code=""
response_body=""

quote_config_value() {
  jq -Rn --arg value "$1" '$value'
}

# 远端命令固定为一条 curl，Socket、URL、方法、Token 和请求体全部经 stdin 的配置传入：
# Token 既不出现在命令行，也不落到服务器磁盘和进程列表。
updater_call() {
  local method="$1" path="$2" body="${3:-}" raw=""
  local config="$workdir/curl.conf"
  {
    printf 'unix-socket = %s\n' "$(quote_config_value "$updater_socket")"
    printf 'url = %s\n' "$(quote_config_value "http://localhost$path")"
    printf 'request = %s\n' "$(quote_config_value "$method")"
    printf 'header = %s\n' "$(quote_config_value "Authorization: Bearer $DEPLOY_UPDATER_TOKEN")"
    if [[ -n "$body" ]]; then
      printf 'header = %s\n' "$(quote_config_value 'Content-Type: application/json')"
      printf 'data = %s\n' "$(quote_config_value "$body")"
    fi
  } >"$config"

  response_code=""
  response_body=""
  if ! raw="$(ssh "${ssh_options[@]}" "$remote" \
    'curl --silent --show-error --max-time 60 --config - --write-out "\n%{http_code}"' \
    <"$config" 2>&1)"; then
    response_body="$raw"
    return 1
  fi
  response_code="$(printf '%s' "$raw" | tail -n 1)"
  response_body="$(printf '%s' "$raw" | sed '$d')"
  [[ "$response_code" =~ ^[0-9]{3}$ ]] || {
    response_body="$raw"
    response_code=""
    return 1
  }
  [[ -n "${response_body//[[:space:]]/}" ]] || response_body='{}'
  return 0
}

field() {
  printf '%s' "$response_body" | jq -r "$1" 2>/dev/null || printf ''
}

echo "==> 读取服务器更新器状态"
if ! updater_call GET /v1/status || [[ "$response_code" != "200" ]]; then
  echo "无法访问 Host Updater（HTTP ${response_code:-连接失败}）：$response_body" >&2
  echo "请确认 open-ai-canvas-updater 正在运行，且部署账号可以读写 $updater_socket" >&2
  exit 1
fi

repository="$(field '.repository // ""')"
if [[ "$repository" != "$GITHUB_REPOSITORY" ]]; then
  # 更新器默认监听上游 ddcat-ai/open-ai-canvas，不改仓库就永远读不到本仓库的 Release。
  echo "服务器更新器监听的是 $repository，本次发布来自 $GITHUB_REPOSITORY" >&2
  echo "请在服务器更新器环境文件中设置 CANVAS_UPDATER_REPOSITORY=$GITHUB_REPOSITORY 后重启服务" >&2
  exit 1
fi

current_version="$(field '.currentVersion // ""')"
echo "    仓库：$repository"
echo "    当前版本：${current_version:-未知}"

if [[ "$current_version" == "$TARGET_VERSION" ]]; then
  echo "==> 服务器已经运行 $TARGET_VERSION，无需部署"
  exit 0
fi

phase="$(field '.operation.phase // ""')"
case "$phase" in
  preflight | backing_up | pulling | draining | migrating | switching | verifying | rolling_back)
    echo "服务器上已有更新正在进行（$phase），本次发布不重复触发" >&2
    exit 1
    ;;
esac

echo "==> 等待更新器读到 $TARGET_VERSION"
latest_version=""
for ((attempt = 1; attempt <= release_retries; attempt++)); do
  if updater_call POST /v1/check && [[ "$response_code" == "200" ]]; then
    latest_version="$(field '.latestRelease.version // ""')"
    [[ "$latest_version" == "$TARGET_VERSION" ]] && break
    printf '    第 %d 次检查读到的最新 Release 是 %s\n' "$attempt" "${latest_version:-无}"
  else
    printf '    第 %d 次检查失败（HTTP %s）：%s\n' "$attempt" "${response_code:-连接失败}" "$response_body"
  fi
  ((attempt < release_retries)) || break
  sleep "$release_retry_interval"
done

if [[ "$latest_version" != "$TARGET_VERSION" ]]; then
  echo "更新器没有把 $TARGET_VERSION 选为最新 Release（读到 ${latest_version:-无}）" >&2
  echo "更新器按语义版本取最高的非草稿 Release；若仓库里存在更高版本的 Release，需要先处理它" >&2
  exit 1
fi

echo "    更新前检查项："
printf '%s' "$response_body" |
  jq -r '.checks[]? | "      - \(.label)：\(.status)" + (if (.detail // "") == "" then "" else "（\(.detail)）" end)'

echo "==> 触发更新：$current_version -> $TARGET_VERSION"
start_body="$(jq -nc --arg version "$TARGET_VERSION" '{targetVersion: $version}')"
if ! updater_call POST /v1/update "$start_body" || [[ "$response_code" != "202" ]]; then
  echo "更新器拒绝启动更新（HTTP ${response_code:-连接失败}）：$response_body" >&2
  exit 1
fi
operation_id="$(field '.operation.id // ""')"
echo "    操作 ID：${operation_id:-未知}"

echo "==> 等待宿主机完成备份、迁移、切换和健康验证"
printed_logs=0
consecutive_failures=0
deadline=$((SECONDS + deploy_timeout))
while :; do
  sleep "$poll_interval"

  if ! updater_call GET /v1/status || [[ "$response_code" != "200" ]]; then
    consecutive_failures=$((consecutive_failures + 1))
    if ((consecutive_failures >= max_consecutive_failures)); then
      echo "连续 $consecutive_failures 次读不到更新状态（HTTP ${response_code:-连接失败}）：$response_body" >&2
      echo "宿主机上的更新可能仍在进行，请登录服务器用 journalctl -u open-ai-canvas-updater 确认" >&2
      exit 1
    fi
    ((SECONDS < deadline)) || break
    continue
  fi
  consecutive_failures=0

  running_id="$(field '.operation.id // ""')"
  if [[ -n "$operation_id" && -n "$running_id" && "$running_id" != "$operation_id" ]]; then
    echo "服务器上的更新操作已被其他操作取代（$running_id）" >&2
    exit 1
  fi

  total_logs="$(field '.operation.logs | length')"
  [[ "$total_logs" =~ ^[0-9]+$ ]] || total_logs=0
  if ((total_logs > printed_logs)); then
    printf '%s' "$response_body" |
      jq -r --argjson from "$printed_logs" '.operation.logs[$from:][] | "    [\(.phase)] \(.message)"'
    printed_logs="$total_logs"
  fi

  phase="$(field '.operation.phase // ""')"
  case "$phase" in
    succeeded)
      # 更新器在成功后约 1 秒会重启自身同步二进制，此时必须立刻结束轮询。
      echo "==> 部署成功：$(field '.currentVersion // ""')"
      backup_id="$(field '.lastBackup.id // ""')"
      if [[ -n "$backup_id" ]]; then
        echo "    更新前备份：$backup_id"
      fi
      exit 0
      ;;
    rolled_back)
      echo "更新失败并已自动回滚到 $(field '.currentVersion // ""')：$(field '.operation.error // ""')" >&2
      exit 1
      ;;
    manual_intervention)
      echo "更新失败且回滚未完成，服务可能处于不可用状态，需要人工介入" >&2
      echo "    更新错误：$(field '.operation.error // ""')" >&2
      echo "    回滚错误：$(field '.operation.rollbackError // ""')" >&2
      exit 1
      ;;
    failed)
      echo "更新失败：$(field '.operation.error // ""')" >&2
      exit 1
      ;;
  esac

  ((SECONDS < deadline)) || break
done

echo "等待 $deploy_timeout 秒后更新仍未结束（当前阶段 ${phase:-未知}）" >&2
echo "宿主机操作不会因 CI 超时而中断，请登录服务器确认最终结果" >&2
exit 1
