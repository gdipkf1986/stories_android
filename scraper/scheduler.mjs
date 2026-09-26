#!/usr/bin/env node
/**
 * 每日定时抓取调度器（本机 crontab 不可用，用 Node 守护进程替代）。
 *
 * 用法:
 *   npm run schedule          # 前台运行，Ctrl+C 停止
 *   npm run schedule:start    # 后台守护运行（日志: scraper/logs/scheduler.log）
 *   npm run schedule:stop     # 停止后台守护
 *   npm run scrape            # 不经调度，立即手动抓取一次
 *   node scraper/scheduler.mjs --once   # 单次模式：到期才抓（配 crontab 每 15 分钟调用）
 *
 * 抓取节奏（二选一，默认间隔模式）:
 *   SCRAPE_INTERVAL_MINUTES   间隔抓取（分钟），默认 15；设为 0 切回每日定时模式。
 *                             守护启动时立即抓一次，之后每 N 分钟一次。
 *   SCRAPE_TIME="HH:MM"       每日模式运行时刻，默认 08:05（仅间隔模式关闭时生效）
 *
 * 其他:
 *   TAG_SCAN_HOURS="6"        无标签条目定时重扫间隔（小时），0 关闭，默认 6
 *   RANK_HOURS="6"            推荐流独立重排间隔（小时），0 关闭，默认 6
 *                             （每次抓取后本来就会跑一轮画像+排序，此项是兜底）
 *   OUTPUT_KEEP_DAYS="7"      抓取产物保留天数（按文件名日期自动删除），0 永久保留，默认 7
 *   GITHUB_INTERVAL_HOURS     GitHub Trending 抓取间隔（小时），0 跟随全局节奏，默认 24（每日一更）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SCRAPER_DIR = import.meta.dirname;
const SOURCE_LOGIN_WORKER_SCRIPT = path.join(SCRAPER_DIR, 'source-login-worker.mjs');
const PID_FILE = path.join(SCRAPER_DIR, 'scheduler.pid');
const LOG_FILE = path.join(SCRAPER_DIR, 'logs', 'scheduler.log');
const STATE_FILE = path.resolve(SCRAPER_DIR, 'storage', 'scheduler-state.json');
const SCRAPE_SCRIPT = path.join(SCRAPER_DIR, 'zhihu-feed.mjs');
const BILIBILI_SCRIPT = path.join(SCRAPER_DIR, 'bilibili-feed.mjs');
const GITHUB_SCRIPT = path.join(SCRAPER_DIR, 'github-trending.mjs');
const WEIBO_SCRIPT = path.join(SCRAPER_DIR, 'weibo-hot.mjs');
const HN_SCRIPT = path.join(SCRAPER_DIR, 'hn-hot.mjs');
const GITHUB_SUMMARIZER_SCRIPT = path.join(SCRAPER_DIR, 'github-summarizer.mjs');
const HN_SUMMARIZER_SCRIPT = path.join(SCRAPER_DIR, 'hn-summarizer.mjs');
const TAGGER_SCRIPT = path.join(SCRAPER_DIR, 'tagger.mjs');
const PROFILE_SCRIPT = path.join(SCRAPER_DIR, 'profile-engine.mjs');
const RANKER_SCRIPT = path.join(SCRAPER_DIR, 'ranker.mjs');
const LIKE_SYNC_SCRIPT = path.join(SCRAPER_DIR, 'like-sync.mjs');
const ARCHIVE_IMPORT_SCRIPT = path.join(SCRAPER_DIR, 'archive-import.mjs');
const SYNC_SCRIPT = path.resolve(SCRAPER_DIR, '..', 'scripts', 'sync-zhihu.mjs');
const SYNC_BILIBILI_SCRIPT = path.resolve(SCRAPER_DIR, '..', 'scripts', 'sync-bilibili.mjs');
const SYNC_GITHUB_SCRIPT = path.resolve(SCRAPER_DIR, '..', 'scripts', 'sync-github.mjs');
const SYNC_WEIBO_SCRIPT = path.resolve(SCRAPER_DIR, '..', 'scripts', 'sync-weibo.mjs');
const SYNC_HN_SCRIPT = path.resolve(SCRAPER_DIR, '..', 'scripts', 'sync-hn.mjs');
const GITHUB_STATE_FILE = path.join(SCRAPER_DIR, 'storage', 'github-schedule.json');
const TAG_SCAN_HOURS = Number(process.env.TAG_SCAN_HOURS ?? 6) || 0;
const RANK_HOURS = Number(process.env.RANK_HOURS ?? 6) || 0; // 推荐流重排间隔（小时），0 关闭
const SCRAPE_INTERVAL_MIN = Math.max(0, Number(process.env.SCRAPE_INTERVAL_MINUTES ?? 15) || 0);
const OUTPUT_KEEP_DAYS = Number(process.env.OUTPUT_KEEP_DAYS ?? 7) || 0;
const OUTPUT_DIR = path.join(SCRAPER_DIR, 'output');
// GitHub Trending 每日一次就够（榜单一天一更）：全局 15 分钟一轮里，GitHub 链路
// 到点才跑；0 = 跟随全局节奏。上次成功时间持久化在 storage/，守护重启不重置节流。
const GITHUB_INTERVAL_HOURS = Math.max(0, Number(process.env.GITHUB_INTERVAL_HOURS ?? 24) || 0);

const SOURCE_LABELS = { zhihu: '知乎', bilibili: 'B站', github: 'GitHub', weibo: '微博热搜', hn: 'Hacker News' };

const pad = (n) => String(n).padStart(2, '0');
const [HH, MM] = (process.env.SCRAPE_TIME ?? '08:05').split(':').map(Number);
if (!Number.isInteger(HH) || !Number.isInteger(MM) || HH > 23 || MM > 59) {
  console.error(`SCRAPE_TIME 格式应为 "HH:MM"，收到: ${process.env.SCRAPE_TIME}`);
  process.exit(1);
}
if (SCRAPE_INTERVAL_MIN > 0 && SCRAPE_INTERVAL_MIN < 5) {
  console.error('SCRAPE_INTERVAL_MINUTES 最小 5 分钟（一轮要跑完整 Playwright，太密会重叠且容易触发风控）');
  process.exit(1);
}

/** 清理过期的抓取产物（按文件名里的日期判断，OUTPUT_KEEP_DAYS=0 表示永久保留） */
function cleanupOldOutputs() {
  if (OUTPUT_KEEP_DAYS <= 0) return 0;
  let removed = 0;
  try {
    const cutoff = Date.now() - OUTPUT_KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      const m = name.match(/^(?:zhihu|bilibili|github|weibo|hn)-feed-(\d{4})-(\d{2})-(\d{2})-/);
      if (!m) continue;
      const fileTime = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (fileTime < cutoff) {
        fs.rmSync(path.join(OUTPUT_DIR, name), { force: true });
        removed++;
      }
    }
  } catch (e) {
    log(`清理抓取产物失败: ${e.message}`);
  }
  return removed;
}

function log(msg) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${msg}`;
  console.log(line);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

/** 停止后台守护（--stop） */
function stopDaemon() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('调度器未在运行');
    process.exit(0);
  }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (isSchedulerAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    log(`调度器已停止 (pid ${pid})`);
    console.log(`已停止调度器 (pid ${pid})`);
  } else {
    console.log(`pid ${pid} 不是调度器或已不存在，清理 pid 文件`);
  }
  fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
}

/** 跑一次 AI 打标扫描（幂等，只处理没有标签的条目），失败不影响主链路 */
function runTagger(trigger, source = 'zhihu') {
  log(`[${trigger}] 扫描未打标的 ${SOURCE_LABELS[source] ?? source}条目…`);
  const r = spawnSync(process.execPath, [TAGGER_SCRIPT, '--source', source], { encoding: 'utf8' });
  if (r.stdout?.trim()) log(r.stdout.trim());
  if (r.stderr?.trim()) log(r.stderr.trim());
  if (r.status !== 0) log(`[${trigger}] 打标扫描异常 (exit ${r.status})，下次扫描自动重试`);
  else log(`[${trigger}] 打标扫描完成 ✓`);
}

/** 跑一次画像 + 排序（纯规则零 API 成本，失败不影响主链路） */
function runProfileAndRank(trigger) {
  log(`[${trigger}] 更新画像与推荐流…`);
  const r1 = spawnSync(process.execPath, [PROFILE_SCRIPT], { encoding: 'utf8' });
  if (r1.stdout?.trim()) log(r1.stdout.trim());
  if (r1.status !== 0) log(`[${trigger}] 画像更新异常 (exit ${r1.status})`);
  const r2 = spawnSync(process.execPath, [RANKER_SCRIPT], { encoding: 'utf8' });
  if (r2.stdout?.trim()) log(r2.stdout.trim());
  if (r2.stderr?.trim()) log(r2.stderr.trim());
  if (r2.status !== 0) log(`[${trigger}] 推荐排序异常 (exit ${r2.status})，下轮自动重试`);
  else log(`[${trigger}] 推荐流已更新 ✓`);
}

/** 把 enrichment 完成后的最新快照归档进 SQLite；失败不阻塞推荐链路 */
function runArchiveSync(trigger) {
  log(`[${trigger}] 归档最新快照到 SQLite…`);
  const r = spawnSync(process.execPath, [ARCHIVE_IMPORT_SCRIPT], { encoding: 'utf8' });
  if (r.stdout?.trim()) log(r.stdout.trim());
  if (r.stderr?.trim()) log(r.stderr.trim());
  if (r.status !== 0) log(`[${trigger}] SQLite 归档异常 (exit ${r.status})，下轮自动重试`);
  else log(`[${trigger}] SQLite 归档完成 ✓`);
}

/** 为 GitHub 新上榜仓库抓 README 并生成中文摘要（幂等，失败不影响主链路） */
function runGithubSummarizer(trigger) {
  log(`[${trigger}] 为新上榜仓库抓 README 并生成摘要…`);
  const r = spawnSync(process.execPath, [GITHUB_SUMMARIZER_SCRIPT], { encoding: 'utf8' });
  if (r.stdout?.trim()) log(r.stdout.trim());
  if (r.stderr?.trim()) log(r.stderr.trim());
  if (r.status !== 0) log(`[${trigger}] 摘要生成异常 (exit ${r.status})，下轮自动重试`);
  else log(`[${trigger}] 摘要生成完成 ✓`);
}

/** 为 HN 新条目翻译标题 + 抓原文生成中文摘要（幂等，失败不影响主链路） */
function runHnSummarizer(trigger) {
  log(`[${trigger}] 翻译 HN 标题并生成中文摘要…`);
  const r = spawnSync(process.execPath, [HN_SUMMARIZER_SCRIPT], { encoding: 'utf8' });
  if (r.stdout?.trim()) log(r.stdout.trim());
  if (r.stderr?.trim()) log(r.stderr.trim());
  if (r.status !== 0) log(`[${trigger}] HN 摘要异常 (exit ${r.status})，下轮自动重试`);
  else log(`[${trigger}] HN 摘要完成 ✓`);
}

/** 跑一个源的 抓取 → 同步 链路，返回是否成功 */
function runSourceChain(label, scrapeScript, syncScript, failHint = '') {
  log(`开始抓取${label}…`);
  const r = spawnSync(process.execPath, [scrapeScript], { encoding: 'utf8' });
  if (r.stdout?.trim()) log(r.stdout.trim());
  if (r.status !== 0) {
    log(`${label}抓取失败 (exit ${r.status})${r.stderr?.trim() ? `：${r.stderr.trim()}` : ''}`);
    if (failHint) log(`提示：${failHint}`);
    return false;
  }
  const s = spawnSync(process.execPath, [syncScript], { encoding: 'utf8' });
  if (s.stdout?.trim()) log(s.stdout.trim());
  if (s.stderr?.trim()) log(s.stderr.trim());
  if (s.status !== 0) {
    log(`${label}同步到 public/data 失败 (exit ${s.status})`);
    return false;
  }
  return true;
}

/** GitHub Trending 是否到抓取时间（默认 24h 一次；状态持久化，守护/单次模式通用） */
function githubDue() {
  if (GITHUB_INTERVAL_HOURS <= 0) return true; // 0 = 跟随全局抓取节奏
  try {
    const st = JSON.parse(fs.readFileSync(GITHUB_STATE_FILE, 'utf8'));
    return Date.now() - (st.lastOkAt ?? 0) >= GITHUB_INTERVAL_HOURS * 3_600_000;
  } catch {
    return true; // 首次运行 / 状态文件缺失 → 立即抓
  }
}

/** 记录 GitHub 抓取成功时间；失败不记，下一轮（15 分钟后）自动重试 */
function noteGithubScrape(ok) {
  if (!ok) return;
  try {
    fs.mkdirSync(path.dirname(GITHUB_STATE_FILE), { recursive: true });
    fs.writeFileSync(GITHUB_STATE_FILE, JSON.stringify({ lastOkAt: Date.now() }, null, 2));
  } catch (e) {
    log(`记录 GitHub 抓取时间失败: ${e.message}`);
  }
}

/** 把「我喜欢」回写到知乎/B站的赞（幂等：状态记 storage/like-sync-state.json，失败不挡抓取） */
function runLikeSync(trigger) {
  const r = spawnSync(process.execPath, [LIKE_SYNC_SCRIPT], { encoding: 'utf8' });
  const out = [r.stdout?.trim(), r.stderr?.trim()].filter(Boolean);
  if (out.length > 0) log(`[${trigger}] 平台点赞回写:\n${out.join('\n')}`);
  if (r.status !== 0) log(`[${trigger}] 点赞回写有失败项（exit ${r.status}），下轮自动重试`);
}

/** 执行一次 抓取 → 同步 → 打标 → 画像+排序 链路（各源独立容错），返回是否有任一源成功 */
function runDailyScrape() {
  const removed = cleanupOldOutputs();
  if (removed > 0) log(`已清理 ${removed} 份过期抓取产物（保留 ${OUTPUT_KEEP_DAYS} 天）`);
  runLikeSync('每轮'); // 放在抓取链路之前：哪怕所有源都抓挂了，收藏回写也照跑
  let okGithub = false;
  if (githubDue()) {
    okGithub = runSourceChain('GitHub Trending', GITHUB_SCRIPT, SYNC_GITHUB_SCRIPT);
    noteGithubScrape(okGithub);
    if (okGithub) {
      runGithubSummarizer('抓取后'); // 摘要先行：tagger 随后重写文件时会带着 summary 字段
      runTagger('抓取后', 'github');
    }
  }
  const okZhihu = runSourceChain('知乎', SCRAPE_SCRIPT, SYNC_SCRIPT, '登录态可能过期，运行 npm run scrape:login 重新扫码');
  const okBili = runSourceChain('B站', BILIBILI_SCRIPT, SYNC_BILIBILI_SCRIPT);
  // 热搜/热榜榜单分钟级刷新，跟随全局节奏每轮都抓（纯 JSON 接口，开销极小）
  const okWeibo = runSourceChain('微博热搜', WEIBO_SCRIPT, SYNC_WEIBO_SCRIPT);
  const okHn = runSourceChain('Hacker News', HN_SCRIPT, SYNC_HN_SCRIPT);
  if (okZhihu) runTagger('抓取后', 'zhihu');
  if (okBili) runTagger('抓取后', 'bilibili');
  if (okWeibo) runTagger('抓取后', 'weibo');
  if (okHn) {
    runHnSummarizer('抓取后'); // 翻译/摘要先行：tagger 随后重写文件时会带着 summary/title_zh 字段
    runTagger('抓取后', 'hn');
  }
  if (!okZhihu && !okBili && !okGithub && !okWeibo && !okHn) return false;
  runArchiveSync('抓取后');
  runProfileAndRank('抓取后');
  log('本轮抓取完成 ✓');
  return true;
}

/** pid 存活且确实是本调度器（/proc cmdline 核对，防止残留 pid 撞上无关进程误判） */
function isSchedulerAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('scheduler.mjs');
  } catch {
    return false;
  }
}

/** 启动后台守护（--daemon） */
function startDaemon() {
  if (fs.existsSync(PID_FILE)) {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (isSchedulerAlive(old)) {
      console.log(`调度器已在运行 (pid ${old})，无需重复启动`);
      process.exit(0);
    }
    fs.rmSync(PID_FILE, { force: true }); // 残留 pid，清理
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  // stdout 日志统一由 log() 追加写入（避免重复行）；stderr 单独进日志文件，崩溃有迹可循
  const errFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [import.meta.filename, '--worker'], {
    detached: true,
    stdio: ['ignore', 'ignore', errFd],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  const cadence =
    SCRAPE_INTERVAL_MIN > 0
      ? `每 ${SCRAPE_INTERVAL_MIN} 分钟自动抓取（启动时先抓一次）`
      : `每天 ${pad(HH)}:${pad(MM)} 自动抓取`;
  console.log(
    `调度器已启动 (pid ${child.pid})，${cadence}。` +
      `日志: scraper/logs/scheduler.log，停止: npm run schedule:stop`,
  );
}

/**
 * 守护循环（--worker / 前台）：每 30 秒检查一次。
 * 间隔模式（默认）：距上次抓取 ≥ N 分钟就抓（lastScrape 初始为 0 → 启动立即抓一次）。
 * 每日模式（SCRAPE_INTERVAL_MINUTES=0）：到达 SCRAPE_TIME 时刻且当天未跑过才抓。
 */
function workerLoop() {
  // 双实例防护：已有存活的调度器就退出（手动误开 / systemd 重启重叠都安全）
  if (fs.existsSync(PID_FILE)) {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (old && old !== process.pid && isSchedulerAlive(old)) {
      log(`已有调度器在运行 (pid ${old})，本实例退出`);
      process.exit(0);
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cadence =
    SCRAPE_INTERVAL_MIN > 0
      ? `每 ${SCRAPE_INTERVAL_MIN} 分钟运行抓取`
      : `每天 ${pad(HH)}:${pad(MM)} 运行抓取`;
  log(
    `调度器启动 (pid ${process.pid})，${cadence}` +
      (TAG_SCAN_HOURS > 0 ? `，每 ${TAG_SCAN_HOURS} 小时重扫未打标条目` : '') +
      (RANK_HOURS > 0 ? `，每 ${RANK_HOURS} 小时重排推荐流` : ''),
  );
  let lastScrape = 0; // 0 → 启动后第一个 tick 立即抓一次
  let lastRunDay = '';
  let lastTagScan = Date.now();
  let lastRank = Date.now();
  let loginWorker = null;
  let stoppingLoginWorker = false;

  function startLoginWorker() {
    loginWorker = spawn(process.execPath, [SOURCE_LOGIN_WORKER_SCRIPT], {
      stdio: 'ignore',
      env: { ...process.env, SOURCE_LOGIN_PARENT_PID: String(process.pid) },
    });
    loginWorker.on('exit', () => {
      if (stoppingLoginWorker) return;
      setTimeout(startLoginWorker, 1000);
    });
  }

  startLoginWorker();
  const timer = setInterval(() => {
    const now = new Date();
    if (SCRAPE_INTERVAL_MIN > 0) {
      if (now.getTime() - lastScrape >= SCRAPE_INTERVAL_MIN * 60_000) {
        lastScrape = now.getTime();
        try {
          runDailyScrape();
        } catch (e) {
          log(`调度异常: ${e.message}`);
        }
      }
    } else {
      const day = now.toDateString();
      if (now.getHours() === HH && now.getMinutes() === MM && lastRunDay !== day) {
        lastRunDay = day;
        try {
          runDailyScrape();
        } catch (e) {
          log(`调度异常: ${e.message}`);
        }
        return;
      }
    }
    // 定时重扫未打标条目（幂等：没有新条目就不产生 API 调用）
    if (TAG_SCAN_HOURS > 0 && now.getTime() - lastTagScan >= TAG_SCAN_HOURS * 3_600_000) {
      lastTagScan = now.getTime();
      try {
        runTagger(`定时重扫（每 ${TAG_SCAN_HOURS} 小时）`);
      } catch (e) {
        log(`打标调度异常: ${e.message}`);
      }
    }
    // 定时重排推荐流（吸收新行为反馈；纯规则，零 API 成本）
    if (RANK_HOURS > 0 && now.getTime() - lastRank >= RANK_HOURS * 3_600_000) {
      lastRank = now.getTime();
      try {
        runProfileAndRank(`定时重排（每 ${RANK_HOURS} 小时）`);
      } catch (e) {
        log(`排序调度异常: ${e.message}`);
      }
    }
  }, 30_000);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      clearInterval(timer);
      stoppingLoginWorker = true;
      loginWorker?.kill();
      fs.rmSync(PID_FILE, { force: true });
      log('调度器退出');
      process.exit(0);
    });
  }
}

/** 单次模式（--once，配合 crontab）：到期就抓一轮，否则跳过。状态记在 storage/ 下，重启不丢 */
function runOnce() {
  const now = Date.now();
  let lastScrapeAt = 0;
  let lastRunDay = '';
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    lastScrapeAt = st.lastScrapeAt ?? 0;
    lastRunDay = st.lastRunDay ?? '';
  } catch {
    // 首次运行，状态文件不存在
  }
  const state = { lastScrapeAt: lastScrapeAt, lastRunDay: lastRunDay };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

  if (SCRAPE_INTERVAL_MIN > 0) {
    // 30 秒容差：cron 每 N 分钟整点触发，边界抖动不至于连续跑两轮
    if (now - lastScrapeAt < SCRAPE_INTERVAL_MIN * 60_000 - 30_000) {
      console.log(`[once] 距上次抓取不足 ${SCRAPE_INTERVAL_MIN} 分钟，跳过`);
      return;
    }
  } else {
    const day = new Date().toDateString();
    if (state.lastRunDay === day) {
      console.log('[once] 今天已经跑过（每日模式），跳过');
      return;
    }
    state.lastRunDay = day;
  }
  state.lastScrapeAt = now;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  runDailyScrape();
}

if (process.argv.includes('--stop')) stopDaemon();
else if (process.argv.includes('--once')) runOnce();
else if (process.argv.includes('--worker')) workerLoop();
else if (process.argv.includes('--daemon')) startDaemon();
else workerLoop();
