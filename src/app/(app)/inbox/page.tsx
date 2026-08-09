import { redirect } from "next/navigation";

import EmptyState from "@/components/empty-state";
import DraftCard from "@/components/inbox/draft-card";
import { currentAppSession } from "@/server/auth/current-session";
import {
  acceptDraftAction,
  rejectDraftAction,
  updateDraftAction,
} from "@/server/import/draft-actions";
import { listInboxDrafts } from "@/server/import/drafts";
import { DRAFT_ACCEPT_PRESELECT_THRESHOLD } from "@/server/import/parse";

export const dynamic = "force-dynamic";

/** 0.95 → "95"；0.625 → "62.5"。 */
function percentLabel(confidence: number): string {
  const pct = Math.round(confidence * 1000) / 10;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

/** 导入草稿待确认（design §5.3/§7.5）：仅当前用户 pending 草稿。 */
export default async function InboxPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const now = new Date();
  const drafts = await listInboxDrafts(session.userId);

  return (
    <main className="shell">
      <p className="eyebrow">邮件导入</p>
      <h1>收件箱</h1>
      <p className="muted">
        扣款邮件的解析结果先落草稿，接受后才写入订阅与账单；未确认的草稿不影响实付统计。
        置信度低于 {DRAFT_ACCEPT_PRESELECT_THRESHOLD * 100}% 的草稿请务必先核对字段再接受。
      </p>

      {drafts.length === 0 ? (
        <EmptyState
          title="没有待确认的草稿"
          hint="把扣款/收据邮件转发到你的专属收件地址，解析出的草稿会出现在这里。"
          action={{ href: "/settings/data", label: "邮件导入设置" }}
        />
      ) : (
        <div className="draft-list">
          {drafts.map((draft) => {
            const candidate = draft.payload.candidate;
            const evidence = draft.payload.evidence;
            return (
              <DraftCard
                key={draft.id}
                id={draft.id}
                name={candidate.name}
                planName={candidate.planName ?? null}
                amount={candidate.amount}
                currency={candidate.currency}
                billedAt={candidate.billedAt}
                billingCycle={candidate.billingCycle ?? null}
                reference={candidate.reference ?? null}
                confidencePercent={percentLabel(draft.confidence)}
                lowConfidence={draft.confidence < DRAFT_ACCEPT_PRESELECT_THRESHOLD}
                matchedRule={evidence?.matchedRule ?? null}
                fromAddr={evidence?.fromAddr ?? null}
                subject={evidence?.subject ?? null}
                sourceReceivedAt={draft.sourceReceivedAt?.toISOString() ?? null}
                expiresAtLabel={draft.expiresAt.toISOString().slice(0, 10)}
                expired={draft.expiresAt.getTime() <= now.getTime()}
                hasSuggestion={draft.suggestedSubscriptionId !== null}
                suggestedSubscriptionName={draft.suggestedSubscriptionName}
                updateAction={updateDraftAction}
                acceptAction={acceptDraftAction}
                rejectAction={rejectDraftAction}
              />
            );
          })}
        </div>
      )}
    </main>
  );
}
