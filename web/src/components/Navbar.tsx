interface Props {
  view: 'feed' | 'profile';
  onToggleProfile: () => void;
}

export default function Navbar({ view, onToggleProfile }: Props) {
  return (
    <header className="navbar">
      <div className="navbar-inner">
        <a className="logo" href="/">
          <span className="logo-mark">时</span>
          <span className="logo-text">stories</span>
        </a>

        <input className="search" placeholder="搜索你感兴趣的内容…" readOnly />

        <div className="navbar-right">
          <button
            className={view === 'feed' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => onToggleProfile()}
            disabled={view === 'feed'}
          >
            首页
          </button>
          <button
            className={view === 'profile' ? 'nav-btn active' : 'nav-btn'}
            onClick={() => onToggleProfile()}
            disabled={view === 'profile'}
            title="画像分析：系统学到的偏好，可逐条确认/反对"
          >
            画像
          </button>
          <span className="avatar avatar-self">我</span>
        </div>
      </div>
    </header>
  );
}
