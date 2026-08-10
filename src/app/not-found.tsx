import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell auth-compact">
      <p className="eyebrow">404 / 页面不存在</p>
      <h1>这里没有可看的资产</h1>
      <p className="summary">链接可能已经失效，或这条记录不属于当前账号。</p>
      <div className="actions">
        <Link href="/" className="button">返回总览</Link>
        <Link href="/subscriptions" className="button secondary">查看订阅</Link>
      </div>
    </main>
  );
}
