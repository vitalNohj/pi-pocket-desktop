// A server sends a person's notification to all their connected pages. Show it from the first page only.
export interface NoticeIdentity {
    tag: string;
    title: string;
    body: string;
    url: string;
}

export const DUPLICATE_NOTICE_MS = 10_000;

export class NotificationOnce {
    private readonly recent = new Map<string, { page: number; at: number }>();

    accept(page: number, notice: NoticeIdentity, now = Date.now()): boolean {
        for (const [key, before] of this.recent) {
            if (now - before.at >= DUPLICATE_NOTICE_MS) this.recent.delete(key);
        }

        const key = JSON.stringify([notice.tag, notice.title, notice.body, notice.url]);
        const before = this.recent.get(key);

        if (before !== undefined && before.page !== page && now >= before.at && now - before.at < DUPLICATE_NOTICE_MS) {
            return false;
        }

        // The same page can repeat one. Only a notification that was shown starts a new interval.
        this.recent.set(key, { page, at: now });

        return true;
    }
}
