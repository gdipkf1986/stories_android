# 翻译服务切换事故（2026-10-31）

## 症状

APK 内 HN 全文和 GitHub README 翻译经常失败。API 日志显示本地翻译 `fetch failed`；GitHub README 直接因同一网络错误失败，HN 则退回 GLM 后仍可能超时。

## 证据

- `stories-api` 环境变量指向 `http://en-zh-translate:8788/translate`。
- 旧容器 `en-zh-translate` 已退出 30 小时（exit 137），Docker DNS 不再解析。
- 新容器 `hy-mt2-translate` 健康，但当时未接入 `stories-net`，API 也无法访问。
- HN 后台翻译仍使用旧同步接口的 100 秒超时；5490 字符测试在 100.058 秒被客户端中断。
- 本地服务能正确把 45 字符英文译成 13 字符中文，但客户端要求译文不少于 50 字，短文会被误判失败。

## 结论

根因是部署切换不完整：API 仍选择旧翻译容器，而新 Hy-MT2 容器没有完成网络接入。次要原因是后台化以后没有同步放宽 HN 超时，且本地短译文校验门槛过高。

## 修复

- `deploy/start-api.sh` 改为选择 `hy-mt2-translate`，并继续把它接入 `stories-net`。
- HN 后台翻译默认超时放宽到 10 分钟，可用 `TRANSLATE_TIMEOUT_MS` 覆盖。
- 本地译文只要求非空，不再强制 50 字。

## 验证

- API 容器内 `en-zh-translate:8788/health` 返回 Hy-MT2 健康状态。
- 2201 字符 HN 文章走完整 API 队列 43 秒完成。
- 5105 字符 GitHub README 走完整 API 队列 150 秒完成。
- 45 字符短文本地翻译成功；Node/Shell 语法检查通过，随后 API 日志无新错误。

## 待办

- 下次部署后观察一天，确认不再出现 `local translation failed, falling back to GLM: fetch failed`。
- 评估长 README 的 10 分钟上限是否足够；必要时按剩余缓存长度动态调整队列预算。
