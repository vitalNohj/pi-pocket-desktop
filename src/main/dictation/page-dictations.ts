// Page ids start at 1 in every page. Worker ids must be positive and unique across the app.
export class PageDictations<Page> {
    private next = 0;
    private readonly pairs = new Map<number, { page: Page; pageId: number }>();

    start(page: Page, pageId: number): number {
        const id = ++this.next;

        this.pairs.set(id, { page, pageId });

        return id;
    }

    find(page: Page, pageId: number): number | undefined {
        for (const [id, pair] of this.pairs) {
            if (pair.page === page && pair.pageId === pageId) return id;
        }

        return undefined;
    }

    get(id: number): { page: Page; pageId: number } | undefined {
        return this.pairs.get(id);
    }

    end(id: number): void {
        this.pairs.delete(id);
    }

    /** A document is gone: its replies must not reach the next document with the same page ids. */
    forget(page: Page): number[] {
        const ids: number[] = [];

        for (const [id, pair] of this.pairs) {
            if (pair.page === page) {
                ids.push(id);
                this.pairs.delete(id);
            }
        }

        return ids;
    }
}
