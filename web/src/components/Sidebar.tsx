import type { SourceId } from '../types';
import { SOURCES } from '../data/sources';

interface Props {
  active: SourceId | 'all';
  counts: Map<SourceId, number>;
  total: number;
  onSelect: (id: SourceId | 'all') => void;
}

/** 左侧栏：按数据源筛选时间线 */
export default function Sidebar({ active, counts, total, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <nav className="side-card">
        <button
          className={active === 'all' ? 'side-item active' : 'side-item'}
          onClick={() => onSelect('all')}
        >
          <span>全部动态</span>
          <span className="side-count">{total}</span>
        </button>

        {SOURCES.map((s) => (
          <button
            key={s.id}
            className={active === s.id ? 'side-item active' : 'side-item'}
            onClick={() => onSelect(s.id)}
          >
            <span className="side-dot" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span className="side-count">{counts.get(s.id) ?? 0}</span>
          </button>
        ))}
      </nav>

      <div className="side-card side-tip">
        想接入新的数据源？
        <br />
        在 <code>public/data/</code> 放 JSON，再在 <code>normalize.ts</code> 加一个适配器即可。
      </div>
    </aside>
  );
}
