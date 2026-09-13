import { useCallback, useEffect, useState } from 'react';

/**
 * 画像分析面板：展示 profile-engine 产出的结构化分析结果，
 * 并允许对每一条「确认 / 反对」（用户裁决，独立持久化，AI 重算不覆盖）。
 *
 * 裁决语义（对齐后端 verdict-store.mjs）：
 *   兴趣 tag  确认 → 权重托底 0.75；反对 → 从兴趣画像移除
 *   避雷 tag  确认 → 确实是雷点；反对 → 移出避雷
 *   作者      确认 → 亲和托底；反对 → 其内容不再进入推荐
 */

type Verdict = 'confirmed' | 'rejected';

interface TagRow {
  tag: string;
  weight: number;
  verdict: Verdict | null;
  evidenceCount: number;
}

interface DislikeRow {
  tag: string;
  verdict: Verdict | null;
}

interface AuthorRow {
  author: string;
  weight: number;
  verdict: Verdict | null;
}

interface ProfileData {
  ok: boolean;
  updatedAt: string | null;
  stats: { totalEvents?: number; byKind?: Record<string, number> };
  topTags: TagRow[];
  dislikedTags: DislikeRow[];
  authorAffinity: AuthorRow[];
  sourceAffinity: Record<string, number>;
  rejectedInterests: string[];
  rejectedAuthors: string[];
  portrait: unknown;
}

const EMPTY: ProfileData = {
  ok: true,
  updatedAt: null,
  stats: {},
  topTags: [],
  dislikedTags: [],
  authorAffinity: [],
  sourceAffinity: {},
  rejectedInterests: [],
  rejectedAuthors: [],
  portrait: null,
};

async function fetchProfile(): Promise<ProfileData> {
  try {
    const res = await fetch('/api/profile', { cache: 'no-store' });
    if (!res.ok) return EMPTY;
    return (await res.json()) as ProfileData;
  } catch {
    return EMPTY;
  }
}

async function submitVerdict(key: string, verdict: Verdict | 'none'): Promise<boolean> {
  try {
    const res = await fetch('/api/verdicts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, verdict }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function VerdictButtons({
  apiKey,
  verdict,
  busy,
  onDecide,
  confirmLabel = '说得对',
  rejectLabel = '不是这样',
}: {
  apiKey: string;
  verdict: Verdict | null;
  busy: boolean;
  onDecide: (key: string, verdict: Verdict | 'none') => void;
  confirmLabel?: string;
  rejectLabel?: string;
}) {
  if (verdict !== null) {
    return (
      <span className="verdict-done">
        <span className={verdict === 'confirmed' ? 'verdict-badge confirmed' : 'verdict-badge rejected'}>
          {verdict === 'confirmed' ? '✓ 已确认' : '✗ 已反对'}
        </span>
        <button
          className="verdict-undo"
          disabled={busy}
          onClick={() => onDecide(apiKey, 'none')}
        >
          撤销
        </button>
      </span>
    );
  }
  return (
    <span className="verdict-actions">
      <button
        className="verdict-btn confirm"
        disabled={busy}
        onClick={() => onDecide(apiKey, 'confirmed')}
        title="分析说得对：权重会托底，排序更信这条"
      >
        👍 {confirmLabel}
      </button>
      <button
        className="verdict-btn reject"
        disabled={busy}
        onClick={() => onDecide(apiKey, 'rejected')}
        title="分析不对：这条会从画像/推荐里移除"
      >
        👎 {rejectLabel}
      </button>
    </span>
  );
}

export default function ProfilePanel() {
  const [data, setData] = useState<ProfileData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    fetchProfile()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const decide = useCallback(
    async (key: string, verdict: Verdict | 'none') => {
      setBusyKey(key);
      const ok = await submitVerdict(key, verdict);
      setBusyKey(null);
      if (!ok) {
        setError('提交失败，请重试');
        return;
      }
      setError('');
      reload(); // 以服务端返回的裁决状态为准
    },
    [reload],
  );

  const hasData =
    data.topTags.length > 0 ||
    data.dislikedTags.length > 0 ||
    data.authorAffinity.length > 0 ||
    data.rejectedInterests.length > 0;

  if (loading) return <div className="feed-status">画像加载中…</div>;

  return (
    <div className="profile-page">
      <div className="profile-header">
        <h2 className="profile-title">画像分析</h2>
        <span className="profile-meta">
          {data.updatedAt
            ? `更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN', { hour12: false })}`
            : '还没有生成画像'}
        </span>
        {(data.stats.totalEvents ?? 0) > 0 && (
          <span className="profile-meta">· 累计行为 {data.stats.totalEvents} 条</span>
        )}
      </div>
      <p className="profile-tip">
        这是系统从你的行为里学到的分析结果。每一条都可以<b>确认</b>（说得对，排序更信它）或
        <b>反对</b>（从画像和推荐里移除）。裁决会一直生效，重新分析也不会覆盖；
        权重变化在下一次画像/推荐更新（调度器自动跑）后应用。
      </p>
      {error && <div className="feed-warning">⚠️ {error}</div>}

      {!hasData && (
        <div className="feed-status">
          还没有足够的浏览/反馈数据。回到信息流点几次「喜欢 / 不感兴趣」，或等每日抓取后再来看。
        </div>
      )}

      {data.topTags.length > 0 && (
        <section className="profile-section">
          <h3 className="profile-section-title">兴趣画像</h3>
          <p className="profile-section-sub">你最近的内容偏好（权重 0~1，越高越影响排序）</p>
          {data.topTags.map((row) => (
            <div key={row.tag} className="prof-row">
              <span className="prof-name">{row.tag}</span>
              <span className="prof-bar-wrap">
                <span
                  className="prof-bar"
                  style={{ width: `${Math.round(row.weight * 100)}%` }}
                />
              </span>
              <span className="prof-weight">{row.weight.toFixed(2)}</span>
              {row.evidenceCount > 0 && (
                <span className="prof-evidence" title="支撑这条分析的行为事件数">
                  {row.evidenceCount} 条证据
                </span>
              )}
              <VerdictButtons
                apiKey={`tag:${row.tag}`}
                verdict={row.verdict}
                busy={busyKey === `tag:${row.tag}`}
                onDecide={decide}
              />
            </div>
          ))}
        </section>
      )}

      {data.dislikedTags.length > 0 && (
        <section className="profile-section">
          <h3 className="profile-section-title">避雷</h3>
          <p className="profile-section-sub">命中这些主题的内容不会进入推荐（确认=确实是雷点，反对=不是雷点）</p>
          {data.dislikedTags.map((row) => (
            <div key={row.tag} className="prof-row">
              <span className="prof-name">{row.tag}</span>
              <span className="prof-dislike-mark">避雷</span>
              <VerdictButtons
                apiKey={`dislike:${row.tag}`}
                verdict={row.verdict}
                busy={busyKey === `dislike:${row.tag}`}
                onDecide={decide}
                confirmLabel="是雷点"
                rejectLabel="不是雷点"
              />
            </div>
          ))}
        </section>
      )}

      {data.authorAffinity.length > 0 && (
        <section className="profile-section">
          <h3 className="profile-section-title">作者亲和</h3>
          <p className="profile-section-sub">你互动较多的作者（反对后其内容不再进入推荐）</p>
          {data.authorAffinity.map((row) => (
            <div key={row.author} className="prof-row">
              <span className="prof-name">{row.author}</span>
              <span className="prof-bar-wrap">
                <span
                  className="prof-bar author"
                  style={{ width: `${Math.round(row.weight * 100)}%` }}
                />
              </span>
              <span className="prof-weight">{row.weight.toFixed(2)}</span>
              <VerdictButtons
                apiKey={`author:${row.author}`}
                verdict={row.verdict}
                busy={busyKey === `author:${row.author}`}
                onDecide={decide}
                confirmLabel="喜欢 ta"
                rejectLabel="别推 ta"
              />
            </div>
          ))}
        </section>
      )}

      {(data.rejectedInterests.length > 0 || data.rejectedAuthors.length > 0) && (
        <section className="profile-section">
          <h3 className="profile-section-title">已反对的分析</h3>
          <p className="profile-section-sub">撤销后相关行为证据会重新参与画像</p>
          <div className="prof-chips">
            {data.rejectedInterests.map((tag) => (
              <span key={`tag:${tag}`} className="prof-chip">
                兴趣「{tag}」
                <button
                  className="verdict-undo"
                  disabled={busyKey === `tag:${tag}`}
                  onClick={() => decide(`tag:${tag}`, 'none')}
                >
                  撤销
                </button>
              </span>
            ))}
            {data.rejectedAuthors.map((author) => (
              <span key={`author:${author}`} className="prof-chip">
                作者「{author}」
                <button
                  className="verdict-undo"
                  disabled={busyKey === `author:${author}`}
                  onClick={() => decide(`author:${author}`, 'none')}
                >
                  撤销
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      {Object.keys(data.sourceAffinity).length > 0 && (
        <section className="profile-section">
          <h3 className="profile-section-title">来源分布</h3>
          <p className="profile-section-sub">你的行为在各数据源上的分布（只读）</p>
          {Object.entries(data.sourceAffinity)
            .sort((a, b) => b[1] - a[1])
            .map(([source, weight]) => (
              <div key={source} className="prof-row">
                <span className="prof-name">{source}</span>
                <span className="prof-bar-wrap">
                  <span
                    className="prof-bar source"
                    style={{ width: `${Math.round(weight * 100)}%` }}
                  />
                </span>
                <span className="prof-weight">{weight.toFixed(2)}</span>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
