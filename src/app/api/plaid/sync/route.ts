import { getCurrentUser } from "@/lib/auth";
import { plaid } from "@/lib/plaid";
import { decrypt } from "@/lib/encrypt";
import { db, s } from "@/db";
import { eq } from "drizzle-orm";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = user.userId;

  const items = await db
    .select()
    .from(s.plaidItems)
    .where(eq(s.plaidItems.userId, userId));

  if (items.length === 0) {
    return Response.json({ ok: true, added: 0, modified: 0, removed: 0 });
  }

  const userAccounts = await db
    .select({
      id: s.accounts.id,
      plaidAccountId: s.accounts.plaidAccountId,
    })
    .from(s.accounts)
    .where(eq(s.accounts.userId, userId));

  const accIdMap = new Map(
    userAccounts
      .filter((a) => a.plaidAccountId)
      .map((a) => [a.plaidAccountId as string, a.id]),
  );

  let added = 0;
  let modified = 0;
  let removed = 0;

  for (const item of items) {
    const accessToken = decrypt(item.accessTokenEncrypted);
    let cursor: string | undefined = item.cursor ?? undefined;
    let hasMore = true;

    while (hasMore) {
      const res = await plaid.transactionsSync({
        access_token: accessToken,
        cursor,
      });

      for (const t of res.data.added) {
        const accId = accIdMap.get(t.account_id);
        if (!accId) continue;
        await db
          .insert(s.transactions)
          .values({
            userId,
            accountId: accId,
            date: t.date,
            // Plaid: positive = outflow. We store negative for outflow.
            amountCents: -Math.round(t.amount * 100),
            description: t.name,
            merchant: t.merchant_name ?? null,
            isPending: t.pending,
            plaidTransactionId: t.transaction_id,
          })
          .onConflictDoNothing({
            target: s.transactions.plaidTransactionId,
          });
      }

      added += res.data.added.length;
      modified += res.data.modified.length;
      removed += res.data.removed.length;

      cursor = res.data.next_cursor;
      hasMore = res.data.has_more;
    }

    await db
      .update(s.plaidItems)
      .set({ cursor, lastSyncedAt: new Date() })
      .where(eq(s.plaidItems.id, item.id));

    // Refresh balances
    const refreshed = await plaid.accountsGet({ access_token: accessToken });
    for (const a of refreshed.data.accounts) {
      await db
        .update(s.accounts)
        .set({
          currentBalanceCents: Math.round((a.balances.current ?? 0) * 100),
          creditLimitCents: a.balances.limit
            ? Math.round(a.balances.limit * 100)
            : null,
          updatedAt: new Date(),
        })
        .where(eq(s.accounts.plaidAccountId, a.account_id));
    }

    // Pull liability details (CC APRs, student loan rates, mortgages) where
    // the institution supports it. Wrapped in try/catch because not every
    // item supports Liabilities and Plaid throws when unsupported.
    try {
      const liab = await plaid.liabilitiesGet({ access_token: accessToken });
      const ccs = liab.data.liabilities.credit ?? [];
      for (const cc of ccs) {
        if (!cc.account_id) continue;
        // aprs is an array; pick the purchase APR if present, else first.
        const aprs = cc.aprs ?? [];
        const purchase = aprs.find(
          (a) => a.apr_type === "purchase_apr",
        );
        const apr = (purchase ?? aprs[0])?.apr_percentage;
        if (apr != null) {
          await db
            .update(s.accounts)
            .set({ interestRateBps: Math.round(apr * 100), updatedAt: new Date() })
            .where(eq(s.accounts.plaidAccountId, cc.account_id));
        }
      }
      const students = liab.data.liabilities.student ?? [];
      for (const sl of students) {
        if (!sl.account_id) continue;
        if (sl.interest_rate_percentage != null) {
          await db
            .update(s.accounts)
            .set({
              interestRateBps: Math.round(sl.interest_rate_percentage * 100),
              updatedAt: new Date(),
            })
            .where(eq(s.accounts.plaidAccountId, sl.account_id));
        }
      }
      const mortgages = liab.data.liabilities.mortgage ?? [];
      for (const m of mortgages) {
        if (!m.account_id) continue;
        const pct = m.interest_rate?.percentage;
        if (pct != null) {
          await db
            .update(s.accounts)
            .set({ interestRateBps: Math.round(pct * 100), updatedAt: new Date() })
            .where(eq(s.accounts.plaidAccountId, m.account_id));
        }
      }
    } catch (e) {
      // Liabilities not supported for this item — fine, skip.
      console.log(
        "[sync] liabilities skipped for item",
        item.plaidItemId,
        (e as Error).message,
      );
    }
  }

  return Response.json({ ok: true, added, modified, removed });
}
