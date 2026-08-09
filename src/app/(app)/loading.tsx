/**
 * (app) 段即时加载态（issue #80）：骨架复用 stat-card / data-table 现有类，
 * 只加 .skeleton 占位块，不引入新视觉体系。
 */
export default function Loading() {
  return (
    <main className="shell" aria-busy="true" aria-label="页面加载中">
      <p className="eyebrow">订阅资产管理中心</p>
      <div className="stats-grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat-card">
            <div className="skeleton skeleton-label" />
            <div className="skeleton skeleton-value" />
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data-table" aria-hidden="true">
          <tbody>
            {[0, 1, 2, 3].map((i) => (
              <tr key={i}>
                <td><div className="skeleton skeleton-cell" /></td>
                <td><div className="skeleton skeleton-cell" /></td>
                <td><div className="skeleton skeleton-cell" /></td>
                <td><div className="skeleton skeleton-cell" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
